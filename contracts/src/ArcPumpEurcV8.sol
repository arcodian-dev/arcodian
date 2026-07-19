// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PumpToken} from "./ArcPump.sol";
import {IERC20} from "./ArcFxPool.sol";
import {ErcPullFeeVault} from "./ArcPumpEurc.sol";
import {ArcPair} from "./ArcPair.sol";
import {ArcPairFactoryV2} from "./ArcPairFactoryV2.sol";

// The EURC mirror of ArcPumpV8: the bonding curve is unchanged from the EURC V7
// suite — same VIRTUAL_QUOTE, same 100 bps symmetric fee, same buy/sell math —
// and only the destination of graduation moves. V7 graduated into
// ArcDexFactoryEurc, a venue nothing else could reach; V8 graduates into
// ArcPair, the same pools third-party liquidity and routing already use.
//
// Simpler than the USDC path in one respect worth stating: EURC is an ordinary
// ERC-20, with no dual native/precompile interface, so there is no 1e12 scaling
// and no unit conversion at settlement. That also means this graduation path can
// be executed end-to-end in Foundry against a plain mock — the USDC path cannot,
// because its precompile does not exist in a local EVM.

contract ArcPumpCurveEurcV8 is ErcPullFeeVault {
    uint8 public constant ENGINE_VERSION = 8;
    uint8 public constant QUOTE_KIND = 1; // 0 = native USDC, 1 = EURC

    uint16 public constant GRADUATION_TIER = 30;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    PumpToken public immutable token;
    ArcPairFactoryV2 public immutable pairFactory;
    address public immutable creator;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public immutable graduationThreshold;
    uint256 public constant VIRTUAL_QUOTE = 1_000_000_000; // 1,000 EURC (6 dec)
    uint256 public realQuoteReserve;
    bool public graduated;
    ArcPair public pair;
    bool private locked;

    event Bought(address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 protocolFee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 protocolFee);
    event Graduated(address indexed pair, uint256 tokenLiquidity, uint256 quoteLiquidity, uint256 lpBurned);

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
        ArcPairFactoryV2 pairFactory_,
        address creator_,
        IERC20 quote_,
        address payable treasury_,
        uint256 threshold_
    ) ErcPullFeeVault(quote_, treasury_) {
        require(
            address(token_) != address(0) && address(pairFactory_) != address(0) && creator_ != address(0)
                && threshold_ > VIRTUAL_QUOTE,
            "BAD_INIT"
        );
        token = token_;
        pairFactory = pairFactory_;
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
        require(tokenLiquidity > 0 && quoteLiquidity > 0, "NO_LIQUIDITY");

        // The factory reserves this pair for this curve while the curve runs, so
        // creation cannot have been front-run. Asserted anyway: if the pair
        // somehow exists already, its price is not ours to inherit.
        address quoteToken = address(quote);
        address pairAddress = pairFactory.createGraduationPair(address(token), quoteToken, GRADUATION_TIER);
        pair = ArcPair(pairAddress);
        require(pair.totalSupply() == 0, "PAIR_ALREADY_SEEDED");

        require(token.approve(pairAddress, tokenLiquidity), "APPROVE_TOKEN");
        require(quote.approve(pairAddress, quoteLiquidity), "APPROVE_QUOTE");

        (uint256 amount0, uint256 amount1) = address(token) < quoteToken
            ? (tokenLiquidity, quoteLiquidity)
            : (quoteLiquidity, tokenLiquidity);

        uint256 shares = pair.addLiquidity(amount0, amount1, 1, uint64(block.timestamp));

        // Burn the LP so graduated liquidity can never be pulled out. ArcPair's
        // _transfer rejects address(0), so it goes to the dead address instead.
        require(pair.transfer(BURN, shares), "BURN_LP");

        emit Graduated(pairAddress, tokenLiquidity, quoteLiquidity, shares);
    }
}

contract ArcPumpFactoryEurcV8 {
    uint8 public constant ENGINE_VERSION = 8;
    uint8 public constant QUOTE_KIND = 1;

    ArcPairFactoryV2 public immutable pairFactory;
    IERC20 public immutable quote;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;

    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public curveByLaunch;
    mapping(address => address) public curveForToken;
    mapping(address => bool) public isCurve;

    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve);

    constructor(ArcPairFactoryV2 pairFactory_, IERC20 quote_, address payable treasury_, uint256 threshold_) {
        require(
            address(pairFactory_) != address(0) && address(quote_) != address(0) && treasury_ != address(0)
                && threshold_ > 1_000_000_000,
            "BAD_CONFIG"
        );
        pairFactory = pairFactory_;
        quote = quote_;
        treasury = treasury_;
        graduationThreshold = threshold_;
    }

    /// Read through ArcGraduationHub by ArcPairFactoryV2, to decide whether a
    /// token's pair is reserved for its own curve.
    function isUngraduatedLaunchToken(address token) external view returns (bool) {
        address curve = curveForToken[token];
        if (curve == address(0)) return false;
        return !ArcPumpCurveEurcV8(curve).graduated();
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
        ArcPumpCurveEurcV8 curve =
            new ArcPumpCurveEurcV8(token, pairFactory, msg.sender, quote, treasury, graduationThreshold);
        require(token.transfer(address(curve), token.totalSupply()), "CURVE_ALLOCATION");

        uint256 id = ++launchCount;
        tokenByLaunch[id] = address(token);
        curveByLaunch[id] = address(curve);
        curveForToken[address(token)] = address(curve);
        isCurve[address(curve)] = true;

        emit LaunchCreated(id, msg.sender, address(token), address(curve));
        return (address(token), address(curve));
    }
}
