// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PumpToken} from "./ArcPump.sol";
import {IERC20} from "./ArcFxPool.sol";

// EURC-collateral pump suite: same bonding-curve + graduation semantics as V7,
// but priced/settled in EURC (a 6-decimal ERC-20) instead of native USDC. All
// collateral moves via transferFrom/transfer (no msg.value). Protocol fees accrue
// in EURC and are pulled by the treasury. Virtual reserve and graduation threshold
// are denominated in EURC (6 decimals): 1000 / 4500 EURC to mirror V7's ratios.

abstract contract ErcPullFeeVault {
    IERC20 public immutable quote; // EURC
    address payable public immutable treasury;
    uint256 public accruedProtocolFees;
    bool internal feeLocked;
    event ProtocolFeeAccrued(uint256 amount, uint256 totalAccrued);
    event ProtocolFeesWithdrawn(address indexed treasury, uint256 amount);

    constructor(IERC20 quote_, address payable treasury_) {
        require(address(quote_) != address(0) && treasury_ != address(0), "ZERO");
        quote = quote_;
        treasury = treasury_;
    }

    function _accrueFee(uint256 amount) internal {
        accruedProtocolFees += amount;
        emit ProtocolFeeAccrued(amount, accruedProtocolFees);
    }

    function withdrawProtocolFees() external {
        require(msg.sender == treasury, "TREASURY_ONLY");
        require(!feeLocked, "REENTRANCY");
        feeLocked = true;
        uint256 amount = accruedProtocolFees;
        require(amount > 0, "NO_FEES");
        accruedProtocolFees = 0;
        require(quote.transfer(treasury, amount), "WITHDRAW_FAILED");
        feeLocked = false;
        emit ProtocolFeesWithdrawn(treasury, amount);
    }
}

contract ArcDexPairEurc is ErcPullFeeVault {
    uint8 public constant ENGINE_VERSION = 7;
    uint8 public constant QUOTE_KIND = 1; // 0 = native USDC, 1 = EURC
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    PumpToken public immutable token;
    address public immutable initializer;
    uint256 public constant TOTAL_FEE_BPS = 30;
    uint256 public constant PROTOCOL_FEE_BPS = 5;
    uint256 public tokenReserve;
    uint256 public quoteReserve;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    bool private locked;
    event LiquidityBurned(uint256 tokenAmount, uint256 quoteAmount, uint256 lpAmount);
    event Swap(address indexed trader, bool quoteToToken, uint256 amountIn, uint256 amountOut, uint256 protocolFee);
    modifier nonReentrant() {
        require(!locked && !feeLocked, "REENTRANCY");
        locked = true;
        feeLocked = true;
        _;
        feeLocked = false;
        locked = false;
    }

    constructor(PumpToken token_, address initializer_, IERC20 quote_, address payable treasury_)
        ErcPullFeeVault(quote_, treasury_)
    {
        require(address(token_) != address(0) && initializer_ != address(0), "ZERO_ADDRESS");
        token = token_;
        initializer = initializer_;
    }

    function initialize(uint256 tokenAmount, uint256 quoteAmount) external nonReentrant {
        require(msg.sender == initializer && totalSupply == 0 && quoteAmount > 0 && tokenAmount > 0, "BAD_INIT");
        require(token.transferFrom(msg.sender, address(this), tokenAmount), "TOKEN_IN");
        require(quote.transferFrom(msg.sender, address(this), quoteAmount), "QUOTE_IN");
        tokenReserve = tokenAmount;
        quoteReserve = quoteAmount;
        uint256 lp = _sqrt(tokenAmount * quoteAmount);
        require(lp > 0, "ZERO_LP");
        totalSupply = lp;
        balanceOf[BURN] = lp;
        emit LiquidityBurned(tokenAmount, quoteAmount, lp);
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(block.timestamp <= deadline && quoteIn > 0 && totalSupply > 0, "BAD_SWAP");
        uint256 inWithFee = quoteIn * (10_000 - TOTAL_FEE_BPS);
        out = tokenReserve * inWithFee / (quoteReserve * 10_000 + inWithFee);
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        uint256 fee = quoteIn * PROTOCOL_FEE_BPS / 10_000;
        require(quote.transferFrom(msg.sender, address(this), quoteIn), "QUOTE_IN");
        quoteReserve += quoteIn - fee;
        tokenReserve -= out;
        _accrueFee(fee);
        require(token.transfer(msg.sender, out), "TOKEN_OUT");
        emit Swap(msg.sender, true, quoteIn, out, fee);
    }

    function sell(uint256 tokenIn, uint256 minQuoteOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(block.timestamp <= deadline && tokenIn > 0 && totalSupply > 0, "BAD_SWAP");
        uint256 inWithFee = tokenIn * (10_000 - TOTAL_FEE_BPS);
        uint256 grossOut = quoteReserve * inWithFee / (tokenReserve * 10_000 + inWithFee);
        uint256 fee = grossOut * PROTOCOL_FEE_BPS / 10_000;
        out = grossOut - fee;
        require(out >= minQuoteOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        tokenReserve += tokenIn;
        quoteReserve -= grossOut;
        _accrueFee(fee);
        require(quote.transfer(msg.sender, out), "QUOTE_OUT");
        emit Swap(msg.sender, false, tokenIn, out, fee);
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}

contract ArcDexFactoryEurc {
    uint8 public constant ENGINE_VERSION = 7;
    address public immutable owner;
    IERC20 public immutable quote;
    address payable public immutable treasury;
    address public pumpFactory;
    mapping(address => address) public pairFor;
    mapping(address => address) public curveFor;
    event PairCreated(address indexed token, address indexed pair, address indexed initializer);

    constructor(IERC20 quote_, address payable treasury_) {
        require(address(quote_) != address(0) && treasury_ != address(0), "ZERO_ADDRESS");
        owner = msg.sender;
        quote = quote_;
        treasury = treasury_;
    }

    function setPumpFactory(address value) external {
        require(msg.sender == owner && pumpFactory == address(0) && value != address(0), "NOT_AUTHORIZED");
        pumpFactory = value;
    }

    function registerCurve(PumpToken token, address curve) external {
        require(
            msg.sender == pumpFactory && curveFor[address(token)] == address(0) && curve != address(0), "NOT_AUTHORIZED"
        );
        curveFor[address(token)] = curve;
    }

    function createPair(PumpToken token, address initializer) external returns (ArcDexPairEurc pair) {
        require(msg.sender == initializer && curveFor[address(token)] == initializer, "NOT_AUTHORIZED");
        require(pairFor[address(token)] == address(0), "PAIR_EXISTS");
        pair = new ArcDexPairEurc(token, initializer, quote, treasury);
        pairFor[address(token)] = address(pair);
        emit PairCreated(address(token), address(pair), initializer);
    }
}

contract ArcPumpCurveEurc is ErcPullFeeVault {
    uint8 public constant ENGINE_VERSION = 7;
    uint8 public constant QUOTE_KIND = 1;
    PumpToken public immutable token;
    ArcDexFactoryEurc public immutable dexFactory;
    address public immutable creator;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public immutable graduationThreshold;
    uint256 public constant VIRTUAL_QUOTE = 1_000_000_000; // 1,000 EURC (6 dec)
    uint256 public realQuoteReserve;
    bool public graduated;
    ArcDexPairEurc public pair;
    bool private locked;
    event Bought(address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 protocolFee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 protocolFee);
    event Graduated(address indexed pair, uint256 tokenLiquidity, uint256 quoteLiquidity, address lpBurnAddress);
    modifier nonReentrant() {
        require(!locked && !feeLocked, "REENTRANCY");
        locked = true;
        feeLocked = true;
        _;
        feeLocked = false;
        locked = false;
    }

    constructor(
        PumpToken token_,
        ArcDexFactoryEurc dex_,
        address creator_,
        IERC20 quote_,
        address payable treasury_,
        uint256 threshold_
    ) ErcPullFeeVault(quote_, treasury_) {
        require(
            address(token_) != address(0) && address(dex_) != address(0) && creator_ != address(0)
                && threshold_ > VIRTUAL_QUOTE,
            "BAD_INIT"
        );
        token = token_;
        dexFactory = dex_;
        creator = creator_;
        graduationThreshold = threshold_;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && quoteIn > 0, "CURVE_CLOSED");
        uint256 fee = quoteIn * CURVE_FEE_BPS / 10_000;
        uint256 netIn = quoteIn - fee;
        uint256 inventory = token.balanceOf(address(this));
        uint256 x = VIRTUAL_QUOTE + realQuoteReserve;
        out = inventory - (x * inventory / (x + netIn));
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        require(quote.transferFrom(msg.sender, address(this), quoteIn), "QUOTE_IN");
        realQuoteReserve += netIn;
        _accrueFee(fee);
        require(token.transfer(msg.sender, out), "TOKEN_OUT");
        emit Bought(msg.sender, quoteIn, out, fee);
        if (realQuoteReserve >= graduationThreshold) _graduate();
    }

    function sell(uint256 tokenIn, uint256 minQuoteOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && tokenIn > 0, "CURVE_CLOSED");
        uint256 inventory = token.balanceOf(address(this));
        uint256 x = VIRTUAL_QUOTE + realQuoteReserve;
        uint256 grossOut = x - (x * inventory / (inventory + tokenIn));
        if (grossOut > realQuoteReserve) grossOut = realQuoteReserve;
        uint256 fee = grossOut * CURVE_FEE_BPS / 10_000;
        out = grossOut - fee;
        require(out >= minQuoteOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        realQuoteReserve -= grossOut;
        _accrueFee(fee);
        require(quote.transfer(msg.sender, out), "QUOTE_OUT");
        emit Sold(msg.sender, tokenIn, out, fee);
    }

    function _graduate() private {
        graduated = true;
        uint256 tokenLiquidity = token.balanceOf(address(this));
        uint256 quoteLiquidity = realQuoteReserve;
        realQuoteReserve = 0;
        pair = dexFactory.createPair(token, address(this));
        require(token.approve(address(pair), tokenLiquidity), "APPROVE_TOKEN");
        require(quote.approve(address(pair), quoteLiquidity), "APPROVE_QUOTE");
        pair.initialize(tokenLiquidity, quoteLiquidity);
        emit Graduated(address(pair), tokenLiquidity, quoteLiquidity, pair.BURN());
    }
}

contract ArcPumpFactoryEurc {
    uint8 public constant ENGINE_VERSION = 7;
    uint8 public constant QUOTE_KIND = 1;
    ArcDexFactoryEurc public immutable dexFactory;
    IERC20 public immutable quote;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;
    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public curveByLaunch;
    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve);

    constructor(ArcDexFactoryEurc dex_, IERC20 quote_, address payable treasury_, uint256 threshold_) {
        require(
            address(dex_) != address(0) && address(quote_) != address(0) && treasury_ != address(0)
                && threshold_ > 1_000_000_000,
            "BAD_CONFIG"
        );
        dexFactory = dex_;
        quote = quote_;
        treasury = treasury_;
        graduationThreshold = threshold_;
    }

    function createLaunch(string calldata name, string calldata symbol, string calldata imageURI)
        external
        returns (address tokenAddress, address curveAddress)
    {
        require(
            bytes(name).length <= 40 && bytes(symbol).length >= 2 && bytes(symbol).length <= 10
                && bytes(imageURI).length <= 200,
            "BAD_METADATA"
        );
        PumpToken token = new PumpToken(name, symbol, imageURI, address(this));
        ArcPumpCurveEurc curve =
            new ArcPumpCurveEurc(token, dexFactory, msg.sender, quote, treasury, graduationThreshold);
        dexFactory.registerCurve(token, address(curve));
        require(token.transfer(address(curve), token.totalSupply()), "CURVE_ALLOCATION");
        uint256 id = ++launchCount;
        tokenByLaunch[id] = address(token);
        curveByLaunch[id] = address(curve);
        emit LaunchCreated(id, msg.sender, address(token), address(curve));
        return (address(token), address(curve));
    }
}

contract ArcPumpSuiteEurc {
    uint8 public constant ENGINE_VERSION = 7;
    uint8 public constant QUOTE_KIND = 1;
    IERC20 public immutable quote;
    ArcDexFactoryEurc public immutable dexFactory;
    ArcPumpFactoryEurc public immutable pumpFactory;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;

    constructor(IERC20 quote_, uint256 threshold_, address payable treasury_) {
        require(address(quote_) != address(0) && threshold_ > 1_000_000_000 && treasury_ != address(0), "BAD_CONFIG");
        ArcDexFactoryEurc dex = new ArcDexFactoryEurc(quote_, treasury_);
        ArcPumpFactoryEurc pump = new ArcPumpFactoryEurc(dex, quote_, treasury_, threshold_);
        dex.setPumpFactory(address(pump));
        quote = quote_;
        dexFactory = dex;
        pumpFactory = pump;
        graduationThreshold = threshold_;
        treasury = treasury_;
    }
}
