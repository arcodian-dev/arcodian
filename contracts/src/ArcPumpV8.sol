// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PumpToken} from "./ArcPump.sol";
import {PullFeeVault} from "./ArcPumpV7.sol";
import {ArcPair} from "./ArcPair.sol";
import {ArcPairFactoryV2} from "./ArcPairFactoryV2.sol";
import {IERC20} from "./ArcFxPool.sol";

// V8 keeps V7's bonding curve exactly — same VIRTUAL_NATIVE, same 100 bps
// symmetric fee, same buy/sell math — and changes only where a curve graduates
// to. V7 graduated into ArcDexFactoryV7, a venue of its own. V8 graduates into
// ArcPair, so launched tokens land in the same pools third-party liquidity and
// routing already use.
//
// Graduation needs no wrapper. On Arc the gas token and the ERC-20 at
// USDC_ERC20 are two views of one balance, differing by 1e12 — verified on
// chain, not assumed. A curve holding native can approve the ERC-20 interface
// directly.

contract ArcPumpCurveV8 is PullFeeVault {
    uint8 public constant ENGINE_VERSION = 8;

    /// Dual-interface USDC: the gas token in 18 decimals, this ERC-20 in 6.
    address public constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;
    uint256 public constant NATIVE_TO_UNIT_6 = 1e12;
    uint16 public constant GRADUATION_TIER = 30;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    PumpToken public immutable token;
    ArcPairFactoryV2 public immutable pairFactory;
    address public immutable creator;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public immutable graduationThreshold;
    uint256 public constant VIRTUAL_NATIVE = 1_000 ether;
    uint256 public realNativeReserve;
    bool public graduated;
    ArcPair public pair;
    bool private locked;

    event Bought(address indexed buyer, uint256 nativeIn, uint256 tokensOut, uint256 protocolFee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 nativeOut, uint256 protocolFee);
    event Graduated(address indexed pair, uint256 tokenLiquidity, uint256 usdcLiquidity, uint256 lpBurned);

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
        address payable treasury_,
        uint256 threshold_
    ) PullFeeVault(treasury_) {
        require(
            address(token_) != address(0) && address(pairFactory_) != address(0) && creator_ != address(0)
                && threshold_ > VIRTUAL_NATIVE,
            "BAD_INIT"
        );
        token = token_;
        pairFactory = pairFactory_;
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

        // Truncation leaves less than 0.000001 USDC with the curve permanently.
        uint256 usdcLiquidity = nativeLiquidity / NATIVE_TO_UNIT_6;
        require(tokenLiquidity > 0 && usdcLiquidity > 0, "NO_LIQUIDITY");

        // The factory reserves this pair for this curve while the curve runs,
        // so creation cannot have been front-run. Asserted anyway: if the pair
        // somehow exists already, its price is not ours to inherit.
        address pairAddress =
            pairFactory.createGraduationPair(address(token), USDC_ERC20, GRADUATION_TIER);
        pair = ArcPair(pairAddress);
        require(pair.totalSupply() == 0, "PAIR_ALREADY_SEEDED");

        require(token.approve(pairAddress, tokenLiquidity), "APPROVE_TOKEN");
        require(IERC20(USDC_ERC20).approve(pairAddress, usdcLiquidity), "APPROVE_USDC");

        (uint256 amount0, uint256 amount1) = address(token) < USDC_ERC20
            ? (tokenLiquidity, usdcLiquidity)
            : (usdcLiquidity, tokenLiquidity);

        uint256 shares = pair.addLiquidity(amount0, amount1, 1, uint64(block.timestamp));

        // Burn the LP so graduated liquidity can never be pulled out. ArcPair's
        // _transfer rejects address(0), so it goes to the dead address instead.
        require(pair.transfer(BURN, shares), "BURN_LP");

        emit Graduated(pairAddress, tokenLiquidity, usdcLiquidity, shares);
    }
}

contract ArcPumpFactoryV8 {
    uint8 public constant ENGINE_VERSION = 8;
    ArcPairFactoryV2 public immutable pairFactory;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;

    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public curveByLaunch;
    mapping(address => address) public curveForToken;
    mapping(address => bool) public isCurve;

    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve);

    constructor(ArcPairFactoryV2 pairFactory_, address payable treasury_, uint256 threshold_) {
        require(address(pairFactory_) != address(0) && treasury_ != address(0) && threshold_ > 1_000 ether, "BAD_CONFIG");
        pairFactory = pairFactory_;
        treasury = treasury_;
        graduationThreshold = threshold_;
    }

    /// Read by ArcPairFactoryV2 to decide whether a token's pair is reserved.
    function isUngraduatedLaunchToken(address token) external view returns (bool) {
        address curve = curveForToken[token];
        if (curve == address(0)) return false;
        return !ArcPumpCurveV8(curve).graduated();
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
        ArcPumpCurveV8 curve = new ArcPumpCurveV8(token, pairFactory, msg.sender, treasury, graduationThreshold);
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
