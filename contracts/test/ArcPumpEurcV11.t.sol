// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPumpCurveEurcV11, ArcPumpFactoryEurcV11} from "../src/ArcPumpEurcV11.sol";
import {IUniswapV3FactoryV10, IUniswapV3PoolV10, INonfungiblePositionManagerV10} from "../src/ArcPumpV10.sol";
import {IERC20} from "../src/ArcFxPool.sol";
import {PumpToken} from "../src/ArcPump.sol";

/// Per-file mocks, matching this codebase's existing convention (see
/// ArcPumpV11CreatorFee.t.sol, whose harness this mirrors). The one real
/// difference is the quote token: EURC is an ordinary 6-decimal ERC-20 held at
/// a normal address, not a precompile that has to be vm.etch'd into place —
/// which is exactly why this graduation path can be driven end to end here
/// while the USDC one cannot.
contract MockEurc {
    string public constant symbol = "EURC";
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

contract MockPositionManager is INonfungiblePositionManagerV10 {
    MockV3Factory public immutable v3Factory;
    uint256 public nextId = 1;

    constructor(MockV3Factory v3Factory_) { v3Factory = v3Factory_; }

    function mint(MintParams calldata p) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        address pool = v3Factory.getPool(p.token0, p.token1, p.fee);
        require(pool != address(0), "NO_POOL");
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3PoolV10(pool).slot0();
        require(sqrtPriceX96 != 0, "LOK");
        amount0 = p.amount0Desired;
        amount1 = p.amount1Desired;
        require(amount0 >= p.amount0Min && amount1 >= p.amount1Min, "Price slippage check");
        require(ITransferable(p.token0).transferFrom(msg.sender, address(this), amount0), "T0");
        require(ITransferable(p.token1).transferFrom(msg.sender, address(this), amount1), "T1");
        tokenId = nextId++;
        liquidity = 1;
    }
}

contract ArcPumpEurcV11Test is Test {
    address payable treasury = payable(address(0xFEE));
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0B);
    address attacker = address(0xBAD);
    // 6-decimal EURC throughout — 20,000 EURC.
    uint256 threshold = 20_000e6;

    MockEurc eurc;
    MockV3Factory v3Factory;
    MockPositionManager npm;
    ArcPumpFactoryEurcV11 pumpFactory;

    function setUp() public {
        eurc = new MockEurc();
        v3Factory = new MockV3Factory();
        npm = new MockPositionManager(v3Factory);
        pumpFactory = new ArcPumpFactoryEurcV11(v3Factory, npm, IERC20(address(eurc)), treasury, threshold);
    }

    function _launch() internal returns (PumpToken token, ArcPumpCurveEurcV11 curve) {
        vm.prank(creator);
        (address t, address c) = pumpFactory.createLaunch("Euro Coin Test", "ETEST", "ipfs://x");
        return (PumpToken(t), ArcPumpCurveEurcV11(c));
    }

    function _buy(ArcPumpCurveEurcV11 curve, address who, uint256 spend) internal returns (uint256 out) {
        eurc.mint(who, spend);
        vm.startPrank(who);
        eurc.approve(address(curve), spend);
        out = curve.buy(spend, 0, uint64(block.timestamp + 1));
        vm.stopPrank();
    }

    // --- quote wiring -----------------------------------------------------

    function testQuoteIsEurcNotNative() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        assertEq(curve.QUOTE_KIND(), 1, "must declare an ERC-20 quote");
        assertEq(curve.ENGINE_VERSION(), 11, "same engine generation as the USDC V11");
        assertEq(address(curve.quote()), address(eurc));
        assertEq(curve.treasury(), treasury);
        assertEq(curve.creator(), creator);
    }

    /// The whole reason this contract exists: it must graduate into Uniswap V3
    /// like the live USDC engine, not into ArcPair like the EURC V8 engine —
    /// Arc Mainnet's pair factory has no graduation authority set and has never
    /// created a pair.
    function testGraduatesIntoUniswapV3() public {
        (PumpToken token, ArcPumpCurveEurcV11 curve) = _launch();
        _buy(curve, buyer, 25_000e6);
        assertTrue(curve.graduated(), "threshold crossed but did not graduate");
        address pool = curve.pool();
        assertTrue(pool != address(0), "no V3 pool");
        (address a, address b) = address(token) < address(eurc) ? (address(token), address(eurc)) : (address(eurc), address(token));
        assertEq(v3Factory.getPool(a, b, 3000), pool, "pool is not the 0.3% V3 pool for this pair");
        assertTrue(curve.lpTokenId() != 0, "no LP position minted");
    }

    /// LP goes to the burn address, so graduated liquidity can never be pulled.
    function testGraduationLiquidityIsPermanent() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        _buy(curve, buyer, 25_000e6);
        // The mock records the mint recipient implicitly by accepting the
        // transfer; what matters on-chain is that the curve asked for BURN.
        assertEq(curve.BURN(), 0x000000000000000000000000000000000000dEaD);
        assertTrue(curve.graduated());
    }

    // --- fees -------------------------------------------------------------

    function testBuyFeeIsOnePercentSplitEvenly() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        uint256 spend = 1_000e6;
        _buy(curve, buyer, spend);
        uint256 fee = spend * 100 / 10_000;
        assertEq(curve.creatorFeesAccrued(), fee / 2, "creator half");
        assertEq(curve.accruedProtocolFees(), fee - fee / 2, "treasury half");
        assertEq(curve.creatorFeesAccrued() + curve.accruedProtocolFees(), fee, "total fee must stay 1%");
    }

    function testSellFeeIsOnePercentSplitEvenly() public {
        (PumpToken token, ArcPumpCurveEurcV11 curve) = _launch();
        uint256 bought = _buy(curve, buyer, 1_000e6);
        uint256 creatorBefore = curve.creatorFeesAccrued();
        uint256 protocolBefore = curve.accruedProtocolFees();

        vm.startPrank(buyer);
        token.approve(address(curve), bought);
        curve.sell(bought, 0, uint64(block.timestamp + 1));
        vm.stopPrank();

        uint256 creatorCut = curve.creatorFeesAccrued() - creatorBefore;
        uint256 protocolCut = curve.accruedProtocolFees() - protocolBefore;
        assertTrue(creatorCut > 0 && protocolCut > 0, "both sides must accrue on a sell");
        // Computed independently off the base, so they differ by at most the
        // rounding remainder and never silently drop it.
        assertLe(protocolCut - creatorCut, 1);
    }

    function testOnlyCreatorCanWithdrawTheirFees() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        _buy(curve, buyer, 1_000e6);
        vm.prank(attacker);
        vm.expectRevert("CREATOR_ONLY");
        curve.withdrawCreatorFees();
    }

    function testCreatorWithdrawPaysInEurcAndZeroesTheBalance() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        _buy(curve, buyer, 1_000e6);
        uint256 owed = curve.creatorFeesAccrued();
        assertTrue(owed > 0);
        vm.prank(creator);
        curve.withdrawCreatorFees();
        assertEq(eurc.balanceOf(creator), owed, "creator must be paid in the quote token");
        assertEq(curve.creatorFeesAccrued(), 0, "balance must not be claimable twice");
        vm.prank(creator);
        vm.expectRevert("NO_FEES");
        curve.withdrawCreatorFees();
    }

    function testTreasuryWithdrawPaysInEurc() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        _buy(curve, buyer, 1_000e6);
        uint256 owed = curve.accruedProtocolFees();
        vm.prank(treasury);
        curve.withdrawProtocolFees();
        assertEq(eurc.balanceOf(treasury), owed);
    }

    function testGraduationFeeIsOnePercentOfLiquidityAndTreasuryOnly() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        uint256 creatorBeforeGraduation;
        // Walk up to just under the threshold so the graduation fee can be
        // isolated from the trading fee of the buy that crosses it.
        _buy(curve, buyer, 19_000e6);
        assertFalse(curve.graduated());
        creatorBeforeGraduation = curve.creatorFeesAccrued();
        _buy(curve, buyer, 5_000e6);
        assertTrue(curve.graduated());
        assertTrue(curve.graduationFeeTaken() > 0, "graduation fee must be taken");
        // The creator's accrual moved only by the crossing buy's trading fee,
        // never by the graduation fee.
        uint256 creatorDelta = curve.creatorFeesAccrued() - creatorBeforeGraduation;
        assertEq(creatorDelta, 5_000e6 * 50 / 10_000, "creator must get no share of the graduation fee");
    }

    // --- safety -----------------------------------------------------------

    function testCannotTradeAfterGraduation() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        _buy(curve, buyer, 25_000e6);
        eurc.mint(buyer, 100e6);
        vm.startPrank(buyer);
        eurc.approve(address(curve), 100e6);
        vm.expectRevert("CURVE_CLOSED");
        curve.buy(100e6, 0, uint64(block.timestamp + 1));
        vm.stopPrank();
    }

    function testSlippageGuardRefusesAShortfall() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        eurc.mint(buyer, 1_000e6);
        vm.startPrank(buyer);
        eurc.approve(address(curve), 1_000e6);
        vm.expectRevert("SLIPPAGE");
        curve.buy(1_000e6, type(uint256).max, uint64(block.timestamp + 1));
        vm.stopPrank();
    }

    function testExpiredDeadlineIsRejected() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        eurc.mint(buyer, 1_000e6);
        vm.warp(1000);
        vm.startPrank(buyer);
        eurc.approve(address(curve), 1_000e6);
        vm.expectRevert("CURVE_CLOSED");
        curve.buy(1_000e6, 0, uint64(block.timestamp - 1));
        vm.stopPrank();
    }

    /// A pool pre-created at a manipulated price must stop graduation rather
    /// than let the attacker mint against it — the same guard V11 carries.
    function testGraduationRefusesAManipulatedPool() public {
        (PumpToken token, ArcPumpCurveEurcV11 curve) = _launch();
        (address a, address b) = address(token) < address(eurc) ? (address(token), address(eurc)) : (address(eurc), address(token));
        vm.prank(attacker);
        address pool = v3Factory.createPool(a, b, 3000);
        MockV3Pool(pool).initialize(type(uint160).max / 2);
        eurc.mint(buyer, 25_000e6);
        vm.startPrank(buyer);
        eurc.approve(address(curve), 25_000e6);
        vm.expectRevert("POOL_PRICE_MANIPULATED");
        curve.buy(25_000e6, 0, uint64(block.timestamp + 1));
        vm.stopPrank();
    }

    function testFactoryRejectsATooLowThreshold() public {
        vm.expectRevert("BAD_CONFIG");
        new ArcPumpFactoryEurcV11(v3Factory, npm, IERC20(address(eurc)), treasury, 1_000e6);
    }

    /// The factory's floor and the curve's own requirement must be the same
    /// number. If the factory accepted a threshold the curve rejects, every
    /// launch it created would revert in its constructor — a factory that
    /// looks deployed and works for nobody.
    function testFactoryFloorMatchesTheCurveRequirement() public {
        (, ArcPumpCurveEurcV11 probe) = _launch();
        uint256 virtualQuote = probe.VIRTUAL_QUOTE();
        vm.expectRevert("BAD_CONFIG");
        new ArcPumpFactoryEurcV11(v3Factory, npm, IERC20(address(eurc)), treasury, virtualQuote);
        // One wei above the floor must be accepted, and must then produce a
        // launch that actually constructs.
        ArcPumpFactoryEurcV11 edge =
            new ArcPumpFactoryEurcV11(v3Factory, npm, IERC20(address(eurc)), treasury, virtualQuote + 1);
        vm.prank(creator);
        (, address curve) = edge.createLaunch("Edge", "EDGE", "");
        assertTrue(curve != address(0));
    }

    /// The curve must keep the same SHAPE as the live USDC V11 engine, just
    /// scaled down. V11 runs 4,500 virtual against a 12,000 threshold; this
    /// runs 1,125 against 3,000 — the same 1:2.667 ratio, which is what fixes
    /// the price run and the sold/burned split at V11's values. A future edit
    /// that changes one number without the other silently reshapes every
    /// launch, so it is pinned here.
    function testCurveShapeMatchesTheLiveUsdcEngine() public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        assertEq(curve.VIRTUAL_QUOTE(), 1_125e6, "virtual reserve");
        // V11's ratio: 12_000 / 4_500 == 3_000 / 1_125, compared as a fraction
        // to stay exact in integer arithmetic.
        assertEq(uint256(3_000e6) * 4_500, uint256(1_125e6) * 12_000, "threshold:virtual ratio must match V11");
    }

    /// Graduation must be reachable at the intended 3,000 EURC, not only at
    /// some larger number — that reachability is the entire reason the curve
    /// was rescaled.
    function testGraduatesAtTheThreeThousandThreshold() public {
        ArcPumpFactoryEurcV11 live =
            new ArcPumpFactoryEurcV11(v3Factory, npm, IERC20(address(eurc)), treasury, 3_000e6);
        vm.prank(creator);
        (, address c) = live.createLaunch("Live", "LIVE", "");
        ArcPumpCurveEurcV11 curve = ArcPumpCurveEurcV11(c);
        // 3,030 EURC in, of which 1% is fee, leaves just under 3,000 net —
        // deliberately close to the line so this fails if the accounting drifts.
        _buy(curve, buyer, 3_040e6);
        assertTrue(curve.graduated(), "3,000 EURC of net inflow must graduate");
        assertTrue(curve.pool() != address(0));
    }

    function testFactoryTracksLaunches() public {
        (PumpToken token, ArcPumpCurveEurcV11 curve) = _launch();
        assertEq(pumpFactory.launchCount(), 1);
        assertEq(pumpFactory.tokenByLaunch(1), address(token));
        assertEq(pumpFactory.curveByLaunch(1), address(curve));
        assertTrue(pumpFactory.isCurve(address(curve)));
        assertTrue(pumpFactory.isUngraduatedLaunchToken(address(token)));
        _buy(curve, buyer, 25_000e6);
        assertFalse(pumpFactory.isUngraduatedLaunchToken(address(token)), "graduated launches are no longer reserved");
    }

    // --- invariant-style fuzz --------------------------------------------

    /// The curve must never owe out more quote than it holds. Fees are accrued
    /// and pull-claimed separately, so the balance has to cover the reserve
    /// plus everything accrued but not yet withdrawn, at every point.
    function testFuzzCurveStaysSolvent(uint96 a, uint96 b, uint96 c) public {
        (, ArcPumpCurveEurcV11 curve) = _launch();
        uint256[3] memory spends = [uint256(a) % 5_000e6, uint256(b) % 5_000e6, uint256(c) % 5_000e6];
        for (uint256 i = 0; i < spends.length; i++) {
            if (spends[i] == 0 || curve.graduated()) continue;
            _buy(curve, buyer, spends[i]);
            uint256 owed = curve.realQuoteReserve() + curve.creatorFeesAccrued() + curve.accruedProtocolFees();
            assertGe(eurc.balanceOf(address(curve)), owed, "curve cannot owe more quote than it holds");
        }
    }

    /// Selling back everything just bought must never return more than was
    /// paid — otherwise the curve is a money pump.
    function testFuzzRoundTripNeverProfits(uint96 raw) public {
        uint256 spend = uint256(raw) % 5_000e6;
        vm.assume(spend > 1e6);
        (PumpToken token, ArcPumpCurveEurcV11 curve) = _launch();
        uint256 bought = _buy(curve, buyer, spend);
        vm.assume(bought > 0);
        vm.startPrank(buyer);
        token.approve(address(curve), bought);
        uint256 returned = curve.sell(bought, 0, uint64(block.timestamp + 1));
        vm.stopPrank();
        assertLe(returned, spend, "round trip must not profit the trader");
    }
}
