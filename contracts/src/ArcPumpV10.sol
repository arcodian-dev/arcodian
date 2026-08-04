// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PumpToken} from "./ArcPump.sol";
import {PullFeeVault} from "./ArcPumpV7.sol";
import {IERC20} from "./ArcFxPool.sol";

interface IUniswapV3FactoryV10 {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3PoolV10 {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

interface INonfungiblePositionManagerV10 {
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

    function mint(MintParams calldata params) external payable returns (uint256, uint128, uint256, uint256);
}

/// @notice Fairer Arcodian launch curve for new mainnet launches.
/// @dev Keeps the public buy/sell ABI compatible with the existing indexers and
/// bots, but uses an 800M curve allocation, a 200M permanent LP reserve, and a
/// 4,500 USDC virtual reserve. The LP reserve is fixed; unsold curve inventory
/// is burned at graduation so the pool always receives exactly 20% of supply.
contract ArcPumpCurveV10 is PullFeeVault {
    uint8 public constant ENGINE_VERSION = 10;
    address public constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;
    uint256 public constant NATIVE_TO_UNIT_6 = 1e12;
    uint24 public constant GRADUATION_FEE = 3000;
    int24 public constant TICK_LOWER = -887220;
    int24 public constant TICK_UPPER = 887220;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public constant CURVE_SUPPLY = 800_000_000 ether;
    uint256 public constant LP_RESERVE = 200_000_000 ether;
    uint256 public constant VIRTUAL_NATIVE = 4_500 ether;

    PumpToken public immutable token;
    IUniswapV3FactoryV10 public immutable v3Factory;
    INonfungiblePositionManagerV10 public immutable positionManager;
    address public immutable creator;
    uint256 public immutable graduationThreshold;
    uint256 public realNativeReserve;
    uint256 public curveSold;
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
        _accrueFee(fee);
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
        _accrueFee(fee);
        (bool ok,) = msg.sender.call{value: out}("");
        require(ok, "NATIVE_OUT");
        emit Sold(msg.sender, tokenIn, out, fee);
    }

    function _graduate() private {
        graduated = true;
        uint256 nativeLiquidity = realNativeReserve;
        realNativeReserve = 0;
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
        (uint160 existingPrice,,,,,,) = IUniswapV3PoolV10(poolAddress).slot0();
        if (existingPrice == 0) IUniswapV3PoolV10(poolAddress).initialize(_sqrtPriceX96(amount0, amount1));
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
                amount0Min: 0,
                amount1Min: 0,
                recipient: BURN,
                deadline: block.timestamp
            })
        );
        lpTokenId = tokenId;
        emit Graduated(poolAddress, tokenLiquidity, usdcLiquidity, tokenId);
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

contract ArcPumpFactoryV10 {
    uint8 public constant ENGINE_VERSION = 10;
    address private constant USDC_ERC20_CONST = 0x3600000000000000000000000000000000000000;
    uint24 private constant GRADUATION_FEE_CONST = 3000;
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
        return curve != address(0) && !ArcPumpCurveV10(curve).graduated();
    }

    function createLaunch(string calldata name, string calldata symbol, string calldata imageURI) external returns (address tokenAddress, address curveAddress) {
        require(bytes(name).length <= 40 && bytes(symbol).length >= 2 && bytes(symbol).length <= 10 && bytes(imageURI).length <= 200, "BAD_METADATA");
        PumpToken token = new PumpToken(name, symbol, imageURI, address(this));
        ArcPumpCurveV10 curve = new ArcPumpCurveV10(token, v3Factory, positionManager, msg.sender, treasury, graduationThreshold);
        require(token.transfer(address(curve), token.totalSupply()), "CURVE_ALLOCATION");
        address tokenAddr = address(token);
        (address token0, address token1) = tokenAddr < USDC_ERC20_CONST ? (tokenAddr, USDC_ERC20_CONST) : (USDC_ERC20_CONST, tokenAddr);
        try v3Factory.createPool(token0, token1, GRADUATION_FEE_CONST) {} catch {}
        uint256 id = ++launchCount;
        tokenByLaunch[id] = tokenAddr;
        curveByLaunch[id] = address(curve);
        curveForToken[tokenAddr] = address(curve);
        isCurve[address(curve)] = true;
        emit LaunchCreated(id, msg.sender, tokenAddr, address(curve));
        return (tokenAddr, address(curve));
    }
}
