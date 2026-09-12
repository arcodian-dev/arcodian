// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PumpToken} from "./ArcPump.sol";
import {PullFeeVault} from "./ArcPumpV7.sol";
import {IERC20} from "./ArcFxPool.sol";
import {IUniswapV3FactoryV10, IUniswapV3PoolV10, INonfungiblePositionManagerV10} from "./ArcPumpV10.sol";

/// @notice Same curve/graduation engine as ArcPumpV10 (identical math, identical
/// graduation-frontrun fix), plus two fees V10 didn't have (its `creator` is
/// event-attribution only, zero on-chain privilege):
///  1. Trading fee (every buy/sell, unchanged at 1% total = CURVE_FEE_BPS) is
///     now split 50/50 between the launch's creator (pull-claimed) and the
///     protocol treasury — was 100% treasury in V10.
///  2. A separate one-time graduation fee (1% = GRADUATION_FEE_BPS, taken out
///     of the native liquidity at the moment of graduation, before it's split
///     into the LP position) goes 100% to the protocol treasury only — no
///     creator share on this one.
/// Total fee surface across a launch's lifetime is therefore 2%, split as:
/// 1% ongoing trading (creator+treasury) + 1% one-time at graduation
/// (treasury only) — this is a deliberate, explicit design the user asked
/// for, not a rate this contract picked on its own.
///
/// Deliberately NOT included (out of scope for this pass, may follow later):
/// Pons-style "holder fee sharing" (creator opts to redirect their cut to
/// holders pro-rata) — that needs a checkpoint/cumulative-per-token accounting
/// scheme (dividend-token style) to be safe against a holder buying in right
/// before a claim, which is a meaningfully bigger, separate piece of work.
contract ArcPumpCurveV11 is PullFeeVault {
    uint8 public constant ENGINE_VERSION = 11;
    address public constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;
    uint256 public constant NATIVE_TO_UNIT_6 = 1e12;
    uint24 public constant GRADUATION_FEE = 3000;
    int24 public constant TICK_LOWER = -887220;
    int24 public constant TICK_UPPER = 887220;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant CURVE_FEE_BPS = 100;
    // Split of CURVE_FEE_BPS (the per-trade fee) — total trader-facing fee
    // per trade is unchanged at 1%, only who it goes to changed.
    uint256 public constant CREATOR_FEE_BPS = 50;
    uint256 public constant PROTOCOL_FEE_BPS = CURVE_FEE_BPS - CREATOR_FEE_BPS;
    // Separate one-time fee taken out of the native liquidity at graduation,
    // 100% to treasury (no creator share) — see contract-level NatSpec.
    uint256 public constant GRADUATION_FEE_BPS = 100;
    uint256 public constant CURVE_SUPPLY = 800_000_000 ether;
    uint256 public constant LP_RESERVE = 200_000_000 ether;
    uint256 public constant VIRTUAL_NATIVE = 4_500 ether;
    // Graduation mint slippage tolerance (2%) — see _graduate().
    uint256 public constant MINT_SLIPPAGE_BPS = 200;

    PumpToken public immutable token;
    IUniswapV3FactoryV10 public immutable v3Factory;
    INonfungiblePositionManagerV10 public immutable positionManager;
    address public immutable creator;
    uint256 public immutable graduationThreshold;
    uint256 public realNativeReserve;
    uint256 public curveSold;
    uint256 public creatorFeesAccrued;
    bool public graduated;
    address public pool;
    uint256 public lpTokenId;
    // Recorded rather than kept as a local in _graduate() — that function
    // already sits right at the EVM stack-depth limit (Solidity's "stack too
    // deep" is a real compiler error here, not a style choice) and this is a
    // useful public fact about the launch anyway.
    uint256 public graduationFeeTaken;
    bool private locked;

    event Bought(address indexed buyer, uint256 nativeIn, uint256 tokensOut, uint256 protocolFee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 nativeOut, uint256 protocolFee);
    event Graduated(address indexed pool, uint256 tokenLiquidity, uint256 usdcLiquidity, uint256 lpTokenId, uint256 graduationFee);
    event CreatorFeeAccrued(uint256 amount, uint256 totalAccrued);
    event CreatorFeesWithdrawn(address indexed creator, uint256 amount);

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
        IUniswapV3FactoryV10 v3Factory_,
        INonfungiblePositionManagerV10 positionManager_,
        address creator_,
        address payable treasury_,
        uint256 threshold_
    ) PullFeeVault(treasury_) {
        require(
            address(token_) != address(0) && address(v3Factory_) != address(0)
                && address(positionManager_) != address(0) && creator_ != address(0)
                && threshold_ > VIRTUAL_NATIVE,
            "BAD_INIT"
        );
        token = token_;
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        creator = creator_;
        graduationThreshold = threshold_;
    }

    function buy(uint256 minTokensOut, uint64 deadline) external payable nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && msg.value > 0, "CURVE_CLOSED");
        uint256 fee = msg.value * CURVE_FEE_BPS / 10_000;
        uint256 netIn = msg.value - fee;
        uint256 inventory = CURVE_SUPPLY - curveSold;
        uint256 x = VIRTUAL_NATIVE + realNativeReserve;
        out = inventory - (x * inventory / (x + netIn));
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        curveSold += out;
        realNativeReserve += netIn;
        _splitFee(msg.value);
        require(token.transfer(msg.sender, out), "TOKEN_OUT");
        emit Bought(msg.sender, msg.value, out, fee);
        if (realNativeReserve >= graduationThreshold) _graduate();
    }

    function sell(uint256 tokenIn, uint256 minNativeOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && tokenIn > 0 && tokenIn <= curveSold, "CURVE_CLOSED");
        uint256 inventory = CURVE_SUPPLY - curveSold;
        uint256 x = VIRTUAL_NATIVE + realNativeReserve;
        uint256 grossOut = x - (x * inventory / (inventory + tokenIn));
        if (grossOut > realNativeReserve) grossOut = realNativeReserve;
        uint256 fee = grossOut * CURVE_FEE_BPS / 10_000;
        out = grossOut - fee;
        require(out >= minNativeOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        curveSold -= tokenIn;
        realNativeReserve -= grossOut;
        _splitFee(grossOut);
        (bool ok,) = msg.sender.call{value: out}("");
        require(ok, "NATIVE_OUT");
        emit Sold(msg.sender, tokenIn, out, fee);
    }

    // Splits CURVE_FEE_BPS of `base` between creator and protocol. Computing
    // each cut independently off `base` (rather than splitting the combined
    // `fee` in half) keeps both cuts exact and avoids a rounding remainder
    // being silently dropped — protocolCut is whatever's left of `fee` after
    // creatorCut, so the two always sum to exactly `fee`.
    function _splitFee(uint256 base) private {
        uint256 fee = base * CURVE_FEE_BPS / 10_000;
        uint256 creatorCut = base * CREATOR_FEE_BPS / 10_000;
        uint256 protocolCut = fee - creatorCut;
        creatorFeesAccrued += creatorCut;
        emit CreatorFeeAccrued(creatorCut, creatorFeesAccrued);
        _accrueFee(protocolCut);
    }

    /// @notice Pull-claim the creator's accrued share, mirroring
    /// withdrawProtocolFees()'s reentrancy-safe pattern exactly (shares the
    /// same `feeLocked` flag, so a creator and the treasury can never both be
    /// mid-withdraw at once either).
    function withdrawCreatorFees() external {
        require(msg.sender == creator, "CREATOR_ONLY");
        require(!feeLocked, "REENTRANCY");
        feeLocked = true;
        uint256 amount = creatorFeesAccrued;
        require(amount > 0, "NO_FEES");
        creatorFeesAccrued = 0;
        (bool ok,) = creator.call{value: amount}("");
        require(ok, "WITHDRAW_FAILED");
        feeLocked = false;
        emit CreatorFeesWithdrawn(creator, amount);
    }

    function _graduate() private {
        graduated = true;
        uint256 nativeLiquidity = realNativeReserve;
        realNativeReserve = 0;
        // One-time graduation fee, 100% to treasury — taken off the top of
        // the native liquidity before any of it becomes the LP position, so
        // it's paid once by the launch itself, not by whichever trader's buy
        // happened to cross the threshold.
        uint256 fee = nativeLiquidity * GRADUATION_FEE_BPS / 10_000;
        nativeLiquidity -= fee;
        graduationFeeTaken = fee;
        _accrueFee(fee);
        uint256 usdcLiquidity = nativeLiquidity / NATIVE_TO_UNIT_6;
        require(usdcLiquidity > 0, "NO_LIQUIDITY");

        uint256 unsoldCurve = CURVE_SUPPLY - curveSold;
        if (unsoldCurve > 0) require(token.transfer(BURN, unsoldCurve), "BURN_UNSOLD");
        uint256 tokenLiquidity = LP_RESERVE;

        (address token0, address token1, uint256 amount0, uint256 amount1) = address(token) < USDC_ERC20
            ? (address(token), USDC_ERC20, tokenLiquidity, usdcLiquidity)
            : (USDC_ERC20, address(token), usdcLiquidity, tokenLiquidity);
        address poolAddress = v3Factory.getPool(token0, token1, GRADUATION_FEE);
        if (poolAddress == address(0)) poolAddress = v3Factory.createPool(token0, token1, GRADUATION_FEE);
        pool = poolAddress;
        uint160 expectedPrice = _sqrtPriceX96(amount0, amount1);
        (uint160 existingPrice,,,,,,) = IUniswapV3PoolV10(poolAddress).slot0();
        uint256 amount0Min = amount0 - amount0 * MINT_SLIPPAGE_BPS / 10_000;
        uint256 amount1Min = amount1 - amount1 * MINT_SLIPPAGE_BPS / 10_000;
        if (existingPrice == 0) {
            IUniswapV3PoolV10(poolAddress).initialize(expectedPrice);
        } else {
            uint256 diff = existingPrice > expectedPrice ? existingPrice - expectedPrice : expectedPrice - existingPrice;
            require(diff * 10_000 <= uint256(expectedPrice) * MINT_SLIPPAGE_BPS, "POOL_PRICE_MANIPULATED");
        }
        require(token.approve(address(positionManager), tokenLiquidity), "APPROVE_TOKEN");
        require(IERC20(USDC_ERC20).approve(address(positionManager), usdcLiquidity), "APPROVE_USDC");
        (uint256 tokenId,,,) = positionManager.mint(
            INonfungiblePositionManagerV10.MintParams({
                token0: token0,
                token1: token1,
                fee: GRADUATION_FEE,
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: BURN,
                deadline: block.timestamp
            })
        );
        lpTokenId = tokenId;
        emit Graduated(poolAddress, tokenLiquidity, usdcLiquidity, tokenId, graduationFeeTaken);
    }

    function _sqrtPriceX96(uint256 amount0, uint256 amount1) private pure returns (uint160) {
        uint256 s0 = _sqrt(amount0);
        require(s0 > 0, "ZERO_SQRT");
        return uint160((_sqrt(amount1) << 96) / s0);
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}

contract ArcPumpFactoryV11 {
    uint8 public constant ENGINE_VERSION = 11;
    IUniswapV3FactoryV10 public immutable v3Factory;
    INonfungiblePositionManagerV10 public immutable positionManager;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;
    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public curveByLaunch;
    mapping(address => address) public curveForToken;
    mapping(address => bool) public isCurve;
    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve);

    constructor(IUniswapV3FactoryV10 v3Factory_, INonfungiblePositionManagerV10 positionManager_, address payable treasury_, uint256 threshold_) {
        require(address(v3Factory_) != address(0) && address(positionManager_) != address(0) && treasury_ != address(0) && threshold_ > 1_000 ether, "BAD_CONFIG");
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        treasury = treasury_;
        graduationThreshold = threshold_;
    }

    function isUngraduatedLaunchToken(address token) external view returns (bool) {
        address curve = curveForToken[token];
        return curve != address(0) && !ArcPumpCurveV11(curve).graduated();
    }

    function createLaunch(string calldata name, string calldata symbol, string calldata imageURI) external returns (address tokenAddress, address curveAddress) {
        require(bytes(name).length <= 40 && bytes(symbol).length >= 2 && bytes(symbol).length <= 10 && bytes(imageURI).length <= 200, "BAD_METADATA");
        PumpToken token = new PumpToken(name, symbol, imageURI, address(this));
        ArcPumpCurveV11 curve = new ArcPumpCurveV11(token, v3Factory, positionManager, msg.sender, treasury, graduationThreshold);
        require(token.transfer(address(curve), token.totalSupply()), "CURVE_ALLOCATION");
        address tokenAddr = address(token);
        uint256 id = ++launchCount;
        tokenByLaunch[id] = tokenAddr;
        curveByLaunch[id] = address(curve);
        curveForToken[tokenAddr] = address(curve);
        isCurve[address(curve)] = true;
        emit LaunchCreated(id, msg.sender, tokenAddr, address(curve));
        return (tokenAddr, address(curve));
    }
}
