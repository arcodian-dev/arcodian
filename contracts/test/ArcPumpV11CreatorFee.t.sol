// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPumpCurveV11, ArcPumpFactoryV11} from "../src/ArcPumpV11.sol";
import {IUniswapV3FactoryV10, IUniswapV3PoolV10, INonfungiblePositionManagerV10} from "../src/ArcPumpV10.sol";
import {PumpToken} from "../src/ArcPump.sol";

/// Same mock harness as ArcPumpV10Graduation.t.sol (duplicated rather than
/// shared, matching this codebase's existing per-file mock convention) — see
/// that file for why each mock is shaped the way it is.
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

contract ArcPumpV11CreatorFeeTest is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address payable treasury = payable(address(0xFEE));
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0B);
    address seller = address(0xB0B);
    address attacker = address(0xBAD);
    uint256 threshold = 5_000 ether;

    MockV3Factory v3Factory;
    MockPositionManager npm;
    ArcPumpFactoryV11 pumpFactory;

    function setUp() public {
        vm.etch(USDC, address(new MockUsdc()).code);
        v3Factory = new MockV3Factory();
        npm = new MockPositionManager(v3Factory);
        pumpFactory = new ArcPumpFactoryV11(v3Factory, npm, treasury, threshold);
    }

    function _launch() internal returns (PumpToken token, ArcPumpCurveV11 curve) {
        vm.prank(creator);
        (address t, address c) = pumpFactory.createLaunch("Test Coin", "TEST", "ipfs://x");
        return (PumpToken(t), ArcPumpCurveV11(c));
    }

    /// Trader-facing total fee must be unchanged from V10 (1%) — this is a
    /// fee-split, not a fee increase. Buy side.
    function testBuyFeeSplitIsExactHalfEachAndSumsToOneATotalFee() public {
        (, ArcPumpCurveV11 curve) = _launch();
        uint256 spend = 1_000 ether;
        vm.deal(buyer, spend);
        vm.prank(buyer);
        curve.buy{value: spend}(1, uint64(block.timestamp + 3600));

        uint256 expectedTotalFee = spend * 100 / 10_000; // CURVE_FEE_BPS
        uint256 expectedCreatorCut = spend * 50 / 10_000; // CREATOR_FEE_BPS
        assertEq(curve.creatorFeesAccrued(), expectedCreatorCut, "creator gets exactly its half");
        assertEq(curve.accruedProtocolFees(), expectedTotalFee - expectedCreatorCut, "protocol gets the remainder");
        assertEq(curve.creatorFeesAccrued() + curve.accruedProtocolFees(), expectedTotalFee, "split sums to the unchanged 1% total");
    }

    /// Same invariant on the sell side, where the fee is taken off grossOut
    /// (native proceeds) rather than msg.value.
    function testSellFeeSplitSumsToOneTotalFee() public {
        (PumpToken token, ArcPumpCurveV11 curve) = _launch();
        uint256 spend = 1_000 ether;
        vm.deal(buyer, spend);
        vm.prank(buyer);
        uint256 bought = curve.buy{value: spend}(1, uint64(block.timestamp + 3600));

        uint256 creatorBefore = curve.creatorFeesAccrued();
        uint256 protocolBefore = curve.accruedProtocolFees();

        vm.prank(buyer);
        token.approve(address(curve), bought);
        vm.prank(buyer);
        curve.sell(bought, 1, uint64(block.timestamp + 3600));

        uint256 creatorGain = curve.creatorFeesAccrued() - creatorBefore;
        uint256 protocolGain = curve.accruedProtocolFees() - protocolBefore;
        assertGt(creatorGain, 0, "creator earns a cut on sell too");
        assertGt(protocolGain, 0, "protocol still earns its half on sell");
        // Exact CREATOR_FEE_BPS/PROTOCOL_FEE_BPS ratio: creatorGain==protocolGain
        // since the split is 50/50 in this deployment's constants.
        assertEq(creatorGain, protocolGain, "50/50 split holds on the sell side too");
    }

    function testCreatorCanWithdrawAccruedFees() public {
        (, ArcPumpCurveV11 curve) = _launch();
        uint256 spend = 1_000 ether;
        vm.deal(buyer, spend);
        vm.prank(buyer);
        curve.buy{value: spend}(1, uint64(block.timestamp + 3600));

        uint256 owed = curve.creatorFeesAccrued();
        assertGt(owed, 0);
        uint256 before = creator.balance;

        vm.prank(creator);
        curve.withdrawCreatorFees();

        assertEq(creator.balance, before + owed, "creator receives exactly the accrued amount");
        assertEq(curve.creatorFeesAccrued(), 0, "accrual reset after withdraw");
    }

    function testOnlyCreatorCanWithdrawCreatorFees() public {
        (, ArcPumpCurveV11 curve) = _launch();
        vm.deal(buyer, 1_000 ether);
        vm.prank(buyer);
        curve.buy{value: 1_000 ether}(1, uint64(block.timestamp + 3600));

        vm.prank(buyer);
        vm.expectRevert("CREATOR_ONLY");
        curve.withdrawCreatorFees();
    }

    function testWithdrawCreatorFeesRevertsWhenNothingAccrued() public {
        (, ArcPumpCurveV11 curve) = _launch();
        vm.prank(creator);
        vm.expectRevert("NO_FEES");
        curve.withdrawCreatorFees();
    }

    /// Treasury's own withdraw path must be completely unaffected by adding
    /// the creator side — same reentrancy flag, must not deadlock either.
    function testTreasuryWithdrawStillWorksIndependentlyOfCreatorWithdraw() public {
        (, ArcPumpCurveV11 curve) = _launch();
        vm.deal(buyer, 1_000 ether);
        vm.prank(buyer);
        curve.buy{value: 1_000 ether}(1, uint64(block.timestamp + 3600));

        uint256 owed = curve.accruedProtocolFees();
        assertGt(owed, 0);
        vm.prank(treasury);
        curve.withdrawProtocolFees();
        assertEq(treasury.balance, owed);

        // Creator's separate accrual must be untouched by the treasury's withdraw.
        assertGt(curve.creatorFeesAccrued(), 0);
        vm.prank(creator);
        curve.withdrawCreatorFees();
    }

    /// End-to-end sanity: graduation still works identically to V10 with the
    /// fee split active (the split only touches where the fee GOES, not the
    /// curve math that decides `out`/`netIn`/graduation threshold).
    function testGraduationStillWorksWithFeeSplitActive() public {
        (, ArcPumpCurveV11 curve) = _launch();
        uint256 spend = threshold * 10_100 / 10_000 + 1 ether;
        MockUsdc(USDC).mint(address(curve), spend / 1e12);
        vm.deal(buyer, spend);
        vm.prank(buyer);
        curve.buy{value: spend}(1, uint64(block.timestamp + 3600));

        assertTrue(curve.graduated());
        assertGt(curve.lpTokenId(), 0);
        assertGt(curve.creatorFeesAccrued(), 0, "creator still accrued a cut even on the graduating trade");
    }

    /// The graduation fee is a SEPARATE 1% on top of the trading fee, taken
    /// out of the native liquidity right before it becomes the LP position,
    /// 100% to treasury with no creator share — verifies the full "2% total"
    /// design: 1% ongoing trading (split) + 1% one-time at graduation
    /// (treasury only).
    function testGraduationFeeIsSeparateOnePercentToTreasuryOnly() public {
        (, ArcPumpCurveV11 curve) = _launch();
        uint256 spend = threshold * 10_100 / 10_000 + 1 ether;
        MockUsdc(USDC).mint(address(curve), spend / 1e12);
        vm.deal(buyer, spend);

        // realNativeReserve right before the graduating buy's own trading-fee
        // cut is what _graduate() will take its 1% from — reconstruct it the
        // same way buy() does, so the expected graduation fee is exact.
        uint256 netIn = spend - (spend * curve.CURVE_FEE_BPS() / 10_000);
        uint256 reserveAtGraduation = netIn; // curve starts this test with 0 realNativeReserve
        uint256 expectedGraduationFee = reserveAtGraduation * curve.GRADUATION_FEE_BPS() / 10_000;

        uint256 protocolBefore = curve.accruedProtocolFees();
        vm.prank(buyer);
        curve.buy{value: spend}(1, uint64(block.timestamp + 3600));

        assertTrue(curve.graduated());
        uint256 tradingFeeToProtocol = spend * curve.PROTOCOL_FEE_BPS() / 10_000;
        uint256 protocolGain = curve.accruedProtocolFees() - protocolBefore;
        assertEq(protocolGain, tradingFeeToProtocol + expectedGraduationFee, "protocol gets its trading-fee half PLUS the full graduation fee");
    }

    /// V11 reuses ArcPumpV10's exact graduation-frontrun fix (pool created +
    /// initialized atomically inside _graduate(), no pre-create window) —
    /// re-run the same regression here rather than trust-by-inheritance,
    /// since V11 is its own separate contract, not a subclass of V10.
    function testGraduationRevertsIfExistingPoolPriceIsManipulated() public {
        (PumpToken token, ArcPumpCurveV11 curve) = _launch();
        (address token0, address token1) = address(token) < USDC ? (address(token), USDC) : (USDC, address(token));

        vm.prank(attacker);
        address pool = v3Factory.createPool(token0, token1, 3000);
        vm.prank(attacker);
        MockV3Pool(pool).initialize(type(uint160).max / 2);

        uint256 spend = threshold * 10_100 / 10_000 + 1 ether;
        MockUsdc(USDC).mint(address(curve), spend / 1e12);
        vm.deal(buyer, spend);
        vm.prank(buyer);
        vm.expectRevert("POOL_PRICE_MANIPULATED");
        curve.buy{value: spend}(1, uint64(block.timestamp + 3600));
    }
}
