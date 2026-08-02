// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PumpToken} from "./ArcPump.sol";
import {PullFeeVault} from "./ArcPumpV7.sol";
import {IERC20} from "./ArcFxPool.sol";

// V9 keeps V8's bonding curve exactly — same VIRTUAL_NATIVE, same 100 bps
// symmetric fee, same buy/sell math — and changes only where a curve
// graduates to. V8 graduated into ArcPair, our own AMM. V9 graduates into a
// real, permissionless Uniswap V3 pool: the same contracts third-party
// routers, aggregators, and Telegram trading bots already know how to read.
//
// A minimal ABI surface is declared locally rather than importing the real
// (solc 0.7.6) Uniswap sources — the two compiler lines never need to share
// a build, only a matching function selector.

interface IUniswapV3FactoryMinimal {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3PoolMinimal {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

interface INonfungiblePositionManagerMinimal {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

contract ArcPumpCurveV9 is PullFeeVault {
    uint8 public constant ENGINE_VERSION = 9;

    /// Dual-interface USDC: the gas token in 18 decimals, this ERC-20 in 6.
    address public constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;
    uint256 public constant NATIVE_TO_UNIT_6 = 1e12;

    /// 0.30% fee tier, tick spacing 60 — same economics as V8's 30 bps
    /// graduation tier, on the venue everything else already routes through.
    uint24 public constant GRADUATION_FEE = 3000;
    /// Full-range position at spacing 60 (nearest multiples of Uniswap's
    /// MIN_TICK/MAX_TICK), so graduated liquidity is always active regardless
    /// of where price moves post-graduation.
    int24 public constant TICK_LOWER = -887220;
    int24 public constant TICK_UPPER = 887220;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    PumpToken public immutable token;
    IUniswapV3FactoryMinimal public immutable v3Factory;
    INonfungiblePositionManagerMinimal public immutable positionManager;
    address public immutable creator;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public immutable graduationThreshold;
    uint256 public constant VIRTUAL_NATIVE = 1_000 ether;
    uint256 public realNativeReserve;
    bool public graduated;
    address public pool;
    uint256 public lpTokenId;
    bool private locked;

    event Bought(address indexed buyer, uint256 nativeIn, uint256 tokensOut, uint256 protocolFee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 nativeOut, uint256 protocolFee);
    event Graduated(address indexed pool, uint256 tokenLiquidity, uint256 usdcLiquidity, uint256 lpTokenId);

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
        IUniswapV3FactoryMinimal v3Factory_,
        INonfungiblePositionManagerMinimal positionManager_,
        address creator_,
        address payable treasury_,
        uint256 threshold_
    ) PullFeeVault(treasury_) {
        require(
            address(token_) != address(0) && address(v3Factory_) != address(0)
                && address(positionManager_) != address(0) && creator_ != address(0) && threshold_ > VIRTUAL_NATIVE,
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

        (address token0, address token1, uint256 amount0, uint256 amount1) = address(token) < USDC_ERC20
            ? (address(token), USDC_ERC20, tokenLiquidity, usdcLiquidity)
            : (USDC_ERC20, address(token), usdcLiquidity, tokenLiquidity);

        // createPool is idempotent — returns the existing pool if one was
        // already permissionlessly created (Uniswap V3 pool creation is
        // open to anyone). Only the price and the liquidity are ours to set;
        // an already-initialized pool is used as-is rather than reverting,
        // so one griefed pool can't permanently block this token's curve.
        address poolAddress = v3Factory.getPool(token0, token1, GRADUATION_FEE);
        if (poolAddress == address(0)) {
            poolAddress = v3Factory.createPool(token0, token1, GRADUATION_FEE);
        }
        pool = poolAddress;

        (uint160 existingPrice,,,,,,) = IUniswapV3PoolMinimal(poolAddress).slot0();
        if (existingPrice == 0) {
            IUniswapV3PoolMinimal(poolAddress).initialize(_sqrtPriceX96(amount0, amount1));
        }

        require(token.approve(address(positionManager), tokenLiquidity), "APPROVE_TOKEN");
        require(IERC20(USDC_ERC20).approve(address(positionManager), usdcLiquidity), "APPROVE_USDC");

        // Minted directly to the dead address: the same "graduated liquidity
        // can never be pulled out" guarantee V8 gave by burning LP shares,
        // expressed as an LP position NFT instead of a fungible LP token.
        (uint256 tokenId,,,) = positionManager.mint(
            INonfungiblePositionManagerMinimal.MintParams({
                token0: token0,
                token1: token1,
                fee: GRADUATION_FEE,
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: BURN,
                deadline: block.timestamp
            })
        );
        lpTokenId = tokenId;

        emit Graduated(poolAddress, tokenLiquidity, usdcLiquidity, tokenId);
    }

    /// sqrtPriceX96 = sqrt(amount1 / amount0) * 2^96, computed as
    /// (sqrt(amount1) * 2^96) / sqrt(amount0) to keep every intermediate
    /// value well inside uint256 regardless of how lopsided the two
    /// reserves are (18-decimal token vs 6-decimal USDC).
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) private pure returns (uint160) {
        uint256 s0 = _sqrt(amount0);
        require(s0 > 0, "ZERO_SQRT");
        uint256 s1 = _sqrt(amount1);
        return uint160((s1 << 96) / s0);
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

contract ArcPumpFactoryV9 {
    uint8 public constant ENGINE_VERSION = 9;
    address private constant USDC_ERC20_CONST = 0x3600000000000000000000000000000000000000;
    uint24 private constant GRADUATION_FEE_CONST = 3000;
    IUniswapV3FactoryMinimal public immutable v3Factory;
    INonfungiblePositionManagerMinimal public immutable positionManager;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;

    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public curveByLaunch;
    mapping(address => address) public curveForToken;
    mapping(address => bool) public isCurve;

    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve);

    constructor(
        IUniswapV3FactoryMinimal v3Factory_,
        INonfungiblePositionManagerMinimal positionManager_,
        address payable treasury_,
        uint256 threshold_
    ) {
        require(
            address(v3Factory_) != address(0) && address(positionManager_) != address(0) && treasury_ != address(0)
                && threshold_ > 1_000 ether,
            "BAD_CONFIG"
        );
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        treasury = treasury_;
        graduationThreshold = threshold_;
    }

    function isUngraduatedLaunchToken(address token) external view returns (bool) {
        address curve = curveForToken[token];
        if (curve == address(0)) return false;
        return !ArcPumpCurveV9(curve).graduated();
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
        ArcPumpCurveV9 curve =
            new ArcPumpCurveV9(token, v3Factory, positionManager, msg.sender, treasury, graduationThreshold);
        require(token.transfer(address(curve), token.totalSupply()), "CURVE_ALLOCATION");

        // Register the pool in the real Uniswap V3 factory immediately, at
        // launch time — empty and uninitialized, holding no liquidity, but
        // present in getPool() from block one. Bots and aggregators that key
        // off factory.getPool() (rather than actual liquidity depth) can see
        // this token as a known Arc DEX pair while it's still on the curve.
        // Graduation later reuses this exact pool (ArcPumpCurveV9._graduate
        // checks getPool() before creating), so there is never a second one.
        address tokenAddr = address(token);
        (address token0, address token1) =
            tokenAddr < USDC_ERC20_CONST ? (tokenAddr, USDC_ERC20_CONST) : (USDC_ERC20_CONST, tokenAddr);
        try v3Factory.createPool(token0, token1, GRADUATION_FEE_CONST) {} catch {}

        uint256 id = ++launchCount;
        tokenByLaunch[id] = address(token);
        curveByLaunch[id] = address(curve);
        curveForToken[address(token)] = address(curve);
        isCurve[address(curve)] = true;

        emit LaunchCreated(id, msg.sender, address(token), address(curve));
        return (address(token), address(curve));
    }
}
