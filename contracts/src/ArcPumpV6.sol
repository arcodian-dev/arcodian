// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PumpToken} from "./ArcPump.sol";

abstract contract PullFeeVault {
    address payable public immutable treasury;
    uint256 public accruedProtocolFees;
    bool internal feeLocked;
    event ProtocolFeeAccrued(uint256 amount, uint256 totalAccrued);
    event ProtocolFeesWithdrawn(address indexed treasury, uint256 amount);

    constructor(address payable treasury_) {
        require(treasury_ != address(0), "ZERO_TREASURY");
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
        (bool ok,) = treasury.call{value: amount}("");
        require(ok, "WITHDRAW_FAILED");
        feeLocked = false;
        emit ProtocolFeesWithdrawn(treasury, amount);
    }
}

contract ArcDexPairV6 is PullFeeVault {
    uint8 public constant ENGINE_VERSION = 6;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    PumpToken public immutable token;
    address public immutable initializer;
    uint256 public constant TOTAL_FEE_BPS = 30;
    uint256 public constant PROTOCOL_FEE_BPS = 5;
    uint256 public tokenReserve;
    uint256 public nativeReserve;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    bool private locked;
    event LiquidityBurned(uint256 tokenAmount, uint256 nativeAmount, uint256 lpAmount);
    event Swap(address indexed trader, bool nativeToToken, uint256 amountIn, uint256 amountOut, uint256 protocolFee);
    modifier nonReentrant() {
        require(!locked && !feeLocked, "REENTRANCY");
        locked = true;
        feeLocked = true;
        _;
        feeLocked = false;
        locked = false;
    }

    constructor(PumpToken token_, address initializer_, address payable treasury_) PullFeeVault(treasury_) {
        require(address(token_) != address(0) && initializer_ != address(0), "ZERO_ADDRESS");
        token = token_;
        initializer = initializer_;
    }

    function initialize(uint256 tokenAmount) external payable nonReentrant {
        require(msg.sender == initializer && totalSupply == 0 && msg.value > 0 && tokenAmount > 0, "BAD_INIT");
        require(token.transferFrom(msg.sender, address(this), tokenAmount), "TOKEN_IN");
        tokenReserve = tokenAmount;
        nativeReserve = msg.value;
        uint256 lp = _sqrt(tokenAmount * msg.value);
        require(lp > 0, "ZERO_LP");
        totalSupply = lp;
        balanceOf[BURN] = lp;
        emit LiquidityBurned(tokenAmount, msg.value, lp);
    }

    function buy(uint256 minTokensOut, uint64 deadline) external payable nonReentrant returns (uint256 out) {
        require(block.timestamp <= deadline && msg.value > 0 && totalSupply > 0, "BAD_SWAP");
        uint256 inWithFee = msg.value * (10_000 - TOTAL_FEE_BPS);
        out = tokenReserve * inWithFee / (nativeReserve * 10_000 + inWithFee);
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        uint256 fee = msg.value * PROTOCOL_FEE_BPS / 10_000;
        nativeReserve += msg.value - fee;
        tokenReserve -= out;
        _accrueFee(fee);
        require(token.transfer(msg.sender, out), "TOKEN_OUT");
        emit Swap(msg.sender, true, msg.value, out, fee);
    }

    function sell(uint256 tokenIn, uint256 minNativeOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(block.timestamp <= deadline && tokenIn > 0 && totalSupply > 0, "BAD_SWAP");
        uint256 inWithFee = tokenIn * (10_000 - 25);
        uint256 grossOut = nativeReserve * inWithFee / (tokenReserve * 10_000 + inWithFee);
        uint256 fee = grossOut * PROTOCOL_FEE_BPS / 10_000;
        out = grossOut - fee;
        require(out >= minNativeOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        tokenReserve += tokenIn;
        nativeReserve -= grossOut;
        _accrueFee(fee);
        (bool ok,) = msg.sender.call{value: out}("");
        require(ok, "NATIVE_OUT");
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

contract ArcDexFactoryV6 {
    uint8 public constant ENGINE_VERSION = 6;
    address public immutable owner;
    address payable public immutable treasury;
    address public pumpFactory;
    mapping(address => address) public pairFor;
    mapping(address => address) public curveFor;
    event PairCreated(address indexed token, address indexed pair, address indexed initializer);

    constructor(address payable treasury_) {
        require(treasury_ != address(0), "ZERO_ADDRESS");
        owner = msg.sender;
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

    function createPair(PumpToken token, address initializer) external returns (ArcDexPairV6 pair) {
        require(msg.sender == initializer && curveFor[address(token)] == initializer, "NOT_AUTHORIZED");
        require(pairFor[address(token)] == address(0), "PAIR_EXISTS");
        pair = new ArcDexPairV6(token, initializer, treasury);
        pairFor[address(token)] = address(pair);
        emit PairCreated(address(token), address(pair), initializer);
    }
}

contract ArcPumpCurveV6 is PullFeeVault {
    uint8 public constant ENGINE_VERSION = 6;
    PumpToken public immutable token;
    ArcDexFactoryV6 public immutable dexFactory;
    address public immutable creator;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public immutable graduationThreshold;
    uint256 public constant VIRTUAL_NATIVE = 1_000 ether;
    uint256 public realNativeReserve;
    bool public graduated;
    ArcDexPairV6 public pair;
    bool private locked;
    event Bought(address indexed buyer, uint256 nativeIn, uint256 tokensOut, uint256 protocolFee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 nativeOut, uint256 protocolFee);
    event Graduated(address indexed pair, uint256 tokenLiquidity, uint256 nativeLiquidity, address lpBurnAddress);
    modifier nonReentrant() {
        require(!locked && !feeLocked, "REENTRANCY");
        locked = true;
        feeLocked = true;
        _;
        feeLocked = false;
        locked = false;
    }

    constructor(PumpToken token_, ArcDexFactoryV6 dex_, address creator_, address payable treasury_, uint256 threshold_)
        PullFeeVault(treasury_)
    {
        require(
            address(token_) != address(0) && address(dex_) != address(0) && creator_ != address(0)
                && threshold_ > VIRTUAL_NATIVE,
            "BAD_INIT"
        );
        token = token_;
        dexFactory = dex_;
        creator = creator_;
        graduationThreshold = threshold_;
    }

    function buy(uint256 minTokensOut, uint64 deadline) external payable nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && msg.value > 0, "CURVE_CLOSED");
        uint256 fee = msg.value * CURVE_FEE_BPS / 10_000;
        uint256 netIn = msg.value - fee;
        uint256 inventory = token.balanceOf(address(this));
        uint256 x = VIRTUAL_NATIVE + realNativeReserve;
        out = inventory - (x * inventory / (x + netIn));
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        realNativeReserve += netIn;
        _accrueFee(fee);
        require(token.transfer(msg.sender, out), "TOKEN_OUT");
        emit Bought(msg.sender, msg.value, out, fee);
        if (realNativeReserve >= graduationThreshold) _graduate();
    }

    function sell(uint256 tokenIn, uint256 minNativeOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && tokenIn > 0, "CURVE_CLOSED");
        uint256 inventory = token.balanceOf(address(this));
        uint256 x = VIRTUAL_NATIVE + realNativeReserve;
        uint256 grossOut = x - (x * inventory / (inventory + tokenIn));
        if (grossOut > realNativeReserve) grossOut = realNativeReserve;
        uint256 fee = grossOut * CURVE_FEE_BPS / 10_000;
        out = grossOut - fee;
        require(out >= minNativeOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        realNativeReserve -= grossOut;
        _accrueFee(fee);
        (bool ok,) = msg.sender.call{value: out}("");
        require(ok, "NATIVE_OUT");
        emit Sold(msg.sender, tokenIn, out, fee);
    }

    function _graduate() private {
        graduated = true;
        uint256 tokenLiquidity = token.balanceOf(address(this));
        uint256 nativeLiquidity = realNativeReserve;
        realNativeReserve = 0;
        pair = dexFactory.createPair(token, address(this));
        require(token.approve(address(pair), tokenLiquidity), "APPROVE");
        pair.initialize{value: nativeLiquidity}(tokenLiquidity);
        emit Graduated(address(pair), tokenLiquidity, nativeLiquidity, pair.BURN());
    }
}

contract ArcPumpFactoryV6 {
    uint8 public constant ENGINE_VERSION = 6;
    ArcDexFactoryV6 public immutable dexFactory;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;
    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public curveByLaunch;
    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve);

    constructor(ArcDexFactoryV6 dex_, address payable treasury_, uint256 threshold_) {
        require(address(dex_) != address(0) && treasury_ != address(0) && threshold_ > 1_000 ether, "BAD_CONFIG");
        dexFactory = dex_;
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
        ArcPumpCurveV6 curve = new ArcPumpCurveV6(token, dexFactory, msg.sender, treasury, graduationThreshold);
        dexFactory.registerCurve(token, address(curve));
        require(token.transfer(address(curve), token.totalSupply()), "CURVE_ALLOCATION");
        uint256 id = ++launchCount;
        tokenByLaunch[id] = address(token);
        curveByLaunch[id] = address(curve);
        emit LaunchCreated(id, msg.sender, address(token), address(curve));
        return (address(token), address(curve));
    }
}

contract ArcPumpSuiteV6 {
    uint8 public constant ENGINE_VERSION = 6;
    ArcDexFactoryV6 public immutable dexFactory;
    ArcPumpFactoryV6 public immutable pumpFactory;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;

    constructor(uint256 threshold_, address payable treasury_) {
        require(threshold_ > 1_000 ether && treasury_ != address(0), "BAD_CONFIG");
        ArcDexFactoryV6 dex = new ArcDexFactoryV6(treasury_);
        ArcPumpFactoryV6 pump = new ArcPumpFactoryV6(dex, treasury_, threshold_);
        dex.setPumpFactory(address(pump));
        dexFactory = dex;
        pumpFactory = pump;
        graduationThreshold = threshold_;
        treasury = treasury_;
    }
}
