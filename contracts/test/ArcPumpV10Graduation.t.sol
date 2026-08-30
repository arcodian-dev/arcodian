// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPumpCurveV10, ArcPumpFactoryV10, IUniswapV3FactoryV10, IUniswapV3PoolV10, INonfungiblePositionManagerV10} from "../src/ArcPumpV10.sol";
import {PumpToken} from "../src/ArcPump.sol";

/// Stands in for the dual-interface USDC. Etched at the constant address the
/// curve compiles against, so the test exercises the real code path.
contract MockUsdc {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 x = allowance[f][msg.sender];
        if (x != type(uint256).max) allowance[f][msg.sender] = x - a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

interface ITransferable {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Minimal but behaviorally faithful stand-in for a real Uniswap V3 pool:
/// initialize() can only ever be called once (exactly like the real pool's
/// slot0.sqrtPriceX96 == 0 guard), which is the property the fix relies on.
contract MockV3Pool is IUniswapV3PoolV10 {
    uint160 public sqrtPriceX96;
    function initialize(uint160 price) external {
        require(sqrtPriceX96 == 0, "AI");
        require(price > 0, "BAD_PRICE");
        sqrtPriceX96 = price;
    }
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 0, 0, 0, sqrtPriceX96 != 0);
    }
}

contract MockV3Factory is IUniswapV3FactoryV10 {
    mapping(bytes32 => address) public pools;
    function _key(address a, address b, uint24 fee) internal pure returns (bytes32) {
        return keccak256(abi.encode(a, b, fee));
    }
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        bytes32 k = _key(tokenA, tokenB, fee);
        require(pools[k] == address(0), "EXISTS");
        pool = address(new MockV3Pool());
        pools[k] = pool;
    }
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[_key(tokenA, tokenB, fee)];
    }
}

/// Faithful enough for the property under test: pulls tokens at the ratio the
/// pool's CURRENT price implies (not blindly at amountDesired), and reverts
/// on the real Uniswap error string when that falls below amountMin — this is
/// exactly the mechanism that must protect the LP reserve from a manipulated
/// starting price.
contract MockPositionManager is INonfungiblePositionManagerV10 {
    MockV3Factory public immutable v3Factory;
    uint256 public nextId = 1;

    constructor(MockV3Factory v3Factory_) { v3Factory = v3Factory_; }

    function mint(MintParams calldata p) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        address pool = v3Factory.getPool(p.token0, p.token1, p.fee);
        require(pool != address(0), "NO_POOL");
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3PoolV10(pool).slot0();
        require(sqrtPriceX96 != 0, "LOK");
        // price = token1 per token0, scaled 1e18 for integer math. Shift
        // before scaling — sqrtPriceX96 routinely exceeds 1e37 for an
        // 18-decimal/6-decimal pair, and squaring-then-scaling before the
        // shift overflows uint256 well before the shift can bring it back down.
        uint256 price = ((uint256(sqrtPriceX96) * uint256(sqrtPriceX96)) >> 192) * 1e18;
        uint256 impliedAmount1 = p.amount0Desired * price / 1e18;
        if (impliedAmount1 <= p.amount1Desired) {
            amount0 = p.amount0Desired;
            amount1 = impliedAmount1;
        } else {
            amount1 = p.amount1Desired;
            amount0 = price == 0 ? 0 : p.amount1Desired * 1e18 / price;
        }
        require(amount0 >= p.amount0Min && amount1 >= p.amount1Min, "Price slippage check");
        require(ITransferable(p.token0).transferFrom(msg.sender, address(this), amount0), "T0");
        require(ITransferable(p.token1).transferFrom(msg.sender, address(this), amount1), "T1");
        tokenId = nextId++;
        liquidity = 1;
    }
}

contract ArcPumpV10GraduationTest is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    uint24 constant FEE = 3000;
    address payable treasury = payable(address(0xFEE));
    address creator = address(0xC0FFEE);
    address attacker = address(0xBAD);
    address buyer = address(0xB0B);

    MockV3Factory v3Factory;
    MockPositionManager npm;
    ArcPumpFactoryV10 pumpFactory;
    // Must be strictly greater than ArcPumpCurveV10.VIRTUAL_NATIVE (4,500 ether).
    uint256 threshold = 5_000 ether;

    function setUp() public {
        vm.etch(USDC, address(new MockUsdc()).code);
        v3Factory = new MockV3Factory();
        npm = new MockPositionManager(v3Factory);
        pumpFactory = new ArcPumpFactoryV10(v3Factory, npm, treasury, threshold);
    }

    function _launch() internal returns (PumpToken token, ArcPumpCurveV10 curve) {
        vm.prank(creator);
        (address t, address c) = pumpFactory.createLaunch("Test Coin", "TEST", "ipfs://x");
        return (PumpToken(t), ArcPumpCurveV10(c));
    }

    function _fundForGraduation(ArcPumpCurveV10 curve) internal returns (uint256 spend) {
        spend = threshold * 10_100 / 10_000 + 1 ether;
        MockUsdc(USDC).mint(address(curve), spend / 1e12);
        vm.deal(buyer, spend);
    }

    function _tokenPair(PumpToken token) internal pure returns (address token0, address token1) {
        return address(token) < USDC ? (address(token), USDC) : (USDC, address(token));
    }

    /// Core regression: createLaunch() must NOT leave a pool sitting around
    /// uninitialized for anyone to call initialize() on before graduation —
    /// that was the entire vulnerability. The pool must not exist yet.
    function testLaunchDoesNotPreCreateThePool() public {
        (PumpToken token,) = _launch();
        (address token0, address token1) = _tokenPair(token);
        assertEq(v3Factory.getPool(token0, token1, FEE), address(0), "pool must not exist before graduation");
    }

    /// Normal graduation still creates and seeds the pool correctly end to end.
    function testGraduationCreatesAndSeedsThePool() public {
        (PumpToken token, ArcPumpCurveV10 curve) = _launch();
        (address token0, address token1) = _tokenPair(token);
        uint256 spend = _fundForGraduation(curve);

        vm.prank(buyer);
        curve.buy{value: spend}(1, uint64(block.timestamp + 3600));

        assertTrue(curve.graduated(), "curve graduated");
        address pool = v3Factory.getPool(token0, token1, FEE);
        assertTrue(pool != address(0), "pool created at graduation");
        assertGt(MockV3Pool(pool).sqrtPriceX96(), 0, "pool initialized at graduation");
        assertGt(curve.lpTokenId(), 0, "LP position minted");
    }

    /// The residual defense-in-depth path: even in the edge case where a pool
    /// somehow already exists and is initialized before graduation runs (e.g.
    /// an attacker who predicted the deterministic token address and front-ran
    /// createPool+initialize before the graduating transaction lands), a wildly
    /// manipulated price must revert graduation instead of silently accepting
    /// it and stranding the LP reserve.
    function testGraduationRevertsIfExistingPoolPriceIsManipulated() public {
        (PumpToken token, ArcPumpCurveV10 curve) = _launch();
        (address token0, address token1) = _tokenPair(token);

        // Attacker predicts the pool address and front-runs both createPool
        // and initialize with an extreme price before graduation.
        vm.prank(attacker);
        address pool = v3Factory.createPool(token0, token1, FEE);
        vm.prank(attacker);
        MockV3Pool(pool).initialize(type(uint160).max / 2);

        uint256 spend = _fundForGraduation(curve);
        vm.prank(buyer);
        vm.expectRevert("POOL_PRICE_MANIPULATED");
        curve.buy{value: spend}(1, uint64(block.timestamp + 3600));
    }

    /// If the pool already exists (e.g. someone else independently created
    /// and correctly initialized it at a fair price for legitimate reasons)
    /// graduation should still succeed rather than assume malice.
    function testGraduationSucceedsIfExistingPoolPriceIsFair() public {
        (PumpToken token, ArcPumpCurveV10 curve) = _launch();
        (address token0, address token1) = _tokenPair(token);

        // Mirror ArcPumpCurveV10's own arithmetic exactly (buy()'s 1% fee,
        // then _graduate()'s LP_RESERVE/NATIVE_TO_UNIT_6 split) so this is
        // the precise price the contract itself will compute — proving the
        // fair-price path is not just "loose enough to pass" but exact.
        uint256 spend = threshold * 10_100 / 10_000 + 1 ether;
        uint256 netIn = spend - (spend * 100 / 10_000);
        uint256 usdcLiquidity = netIn / 1e12;
        uint256 tokenLiquidity = 200_000_000 ether;
        (uint256 amount0, uint256 amount1) = address(token) < USDC
            ? (tokenLiquidity, usdcLiquidity)
            : (usdcLiquidity, tokenLiquidity);
        uint160 fairPrice = uint160((_sqrt(amount1) << 96) / _sqrt(amount0));

        vm.prank(attacker);
        address pool = v3Factory.createPool(token0, token1, FEE);
        MockV3Pool(pool).initialize(fairPrice);

        MockUsdc(USDC).mint(address(curve), spend / 1e12);
        vm.deal(buyer, spend);
        vm.prank(buyer);
        curve.buy{value: spend}(1, uint64(block.timestamp + 3600));

        assertTrue(curve.graduated(), "graduation succeeds against a fairly-priced pre-existing pool");
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }
}
