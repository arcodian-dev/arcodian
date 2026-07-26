// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcLendV2, IERC20Collateral} from "../src/ArcLendV2.sol";
import {ArcManualOracle} from "../src/ArcLend.sol";

contract LendToken {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 x = allowance[f][msg.sender];
        if (x != type(uint256).max) allowance[f][msg.sender] = x - a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

/// Reference stablecoin curve: 1% base, +10% to the 80% kink (9% there),
/// then a steep +200% jump slope above it (49% at 100% utilization) — the
/// same shape as Aave's stable-asset reserves and Compound's JumpRateModel.
contract ArcLendV2Test is Test {
    uint256 constant WAD = 1e18;
    uint256 constant BASE = 1e16; // 1%
    uint256 constant MULT = 1e17; // 10%
    uint256 constant JUMP = 2e18; // 200%
    uint256 constant KINK = 8e17; // 80%

    LendToken token;
    ArcManualOracle oracle;
    ArcLendV2 market;
    address supplier = address(0x51);
    address borrower = address(0xB0);
    address liquidator = address(0x1);

    function setUp() public {
        token = new LendToken(18);
        oracle = new ArcManualOracle(address(this), 2 ether);
        market = new ArcLendV2(
            IERC20Collateral(address(token)), oracle, address(this), address(this), 1_000 ether, 800 ether,
            BASE, MULT, JUMP, KINK
        );
        vm.deal(supplier, 500 ether);
        vm.prank(supplier);
        market.supply{value: 500 ether}();
        token.mint(borrower, 100 ether);
        vm.prank(borrower);
        token.approve(address(market), type(uint256).max);
        vm.deal(liquidator, 100 ether);
    }

    function _position(uint256 borrowAmount) internal {
        // Collateral scaled to the loan (at price 2, LTV 70%) so pool-level
        // utilization tests aren't also constrained by per-borrower LTV.
        uint256 collateral = borrowAmount * 2 + 10 ether;
        vm.startPrank(borrower);
        token.mint(borrower, collateral);
        market.depositCollateral(collateral);
        market.borrow(borrowAmount);
        vm.stopPrank();
    }

    function testZeroUtilizationChargesBaseRateOnly() public view {
        assertEq(market.utilization(), 0);
        assertEq(market.borrowRatePerYear(), BASE);
    }

    function testBelowKinkFollowsFirstSlope() public {
        _position(100 ether); // 100 / 500 = 20% utilization
        assertEq(market.utilization(), 2e17);
        // base + u*mult = 1% + 20%*10% = 3%
        assertApproxEqAbs(market.borrowRatePerYear(), BASE + 2e17 * MULT / WAD, 1);
    }

    function testAtKinkMatchesBothSlopeFormulas() public {
        // Borrow exactly 80% of the 500 ether pool.
        _position(400 ether);
        assertEq(market.utilization(), KINK);
        uint256 atKink = BASE + KINK * MULT / WAD;
        assertEq(market.borrowRatePerYear(), atKink); // 1% + 80%*10% = 9%
    }

    function testAboveKinkJumpsToSecondSlope() public {
        // 480 / 500 = 96% utilization, 16 points above the 80% kink.
        _position(480 ether);
        assertEq(market.utilization(), 96e16);
        uint256 atKink = BASE + KINK * MULT / WAD; // 9%
        uint256 expected = atKink + (96e16 - KINK) * JUMP / WAD; // 9% + 16%*200% = 41%
        assertApproxEqAbs(market.borrowRatePerYear(), expected, 1);
        assertGt(market.borrowRatePerYear(), 9e16); // strictly above the pre-kink rate
    }

    function testRateRisesMonotonicallyWithUtilization() public {
        // Collateral sized for the final 480 ether debt up front so the later
        // top-up borrows are only gated by pool liquidity, not per-user LTV.
        vm.startPrank(borrower);
        token.mint(borrower, 1_000 ether);
        market.depositCollateral(1_000 ether);
        market.borrow(100 ether);
        uint256 lowRate = market.borrowRatePerYear();
        market.borrow(300 ether); // now 400/500 = 80%, at the kink
        uint256 midRate = market.borrowRatePerYear();
        market.borrow(80 ether); // now 480/500 = 96%, past the kink
        uint256 highRate = market.borrowRatePerYear();
        vm.stopPrank();
        assertLt(lowRate, midRate);
        assertLt(midRate, highRate);
    }

    function testAccrualUsesUtilizationDependentRate() public {
        _position(400 ether); // pins utilization at the 80% kink -> 9%/yr
        vm.warp(block.timestamp + 365 days);
        market.accrue();
        assertApproxEqRel(market.totalBorrows(), 436 ether, 3e14); // 400 * 1.09
    }

    function testSupplyBorrowRepayWithdraw() public {
        vm.startPrank(borrower);
        market.depositCollateral(100 ether);
        market.borrow(100 ether);
        vm.stopPrank();
        vm.deal(borrower, 105 ether);
        vm.warp(block.timestamp + 30 days);
        vm.prank(borrower);
        market.repay{value: 105 ether}(borrower);
        assertEq(market.debtOf(borrower), 0);
        vm.prank(borrower);
        market.withdrawCollateral(100 ether);
        assertEq(token.balanceOf(borrower), 100 ether);
        uint256 before = supplier.balance;
        uint256 shares = market.supplyShares(supplier);
        vm.prank(supplier);
        market.withdraw(shares);
        assertGt(supplier.balance, before);
    }

    function testBorrowCapAndLtvEnforced() public {
        vm.startPrank(borrower);
        market.depositCollateral(100 ether);
        vm.expectRevert(ArcLendV2.Health.selector);
        market.borrow(141 ether);
        vm.stopPrank();
    }

    function testLiquidationAfterPriceDrop() public {
        vm.startPrank(borrower);
        market.depositCollateral(100 ether);
        market.borrow(100 ether);
        vm.stopPrank();
        oracle.setPrice(1 ether);
        market.acceptOraclePrice();
        uint256 before = token.balanceOf(liquidator);
        vm.prank(liquidator);
        market.liquidate{value: 50 ether}(borrower);
        assertGt(token.balanceOf(liquidator), before);
        assertLt(market.debtOf(borrower), 100 ether);
    }

    function testPauseBlocksNewSupply() public {
        market.setPaused(true);
        vm.expectRevert(ArcLendV2.PausedError.selector);
        market.supply{value: 1 ether}();
    }

    function testCapIncreaseRequiresDelayAndIsPermissionlessAfterEta() public {
        market.scheduleCapIncrease(2_000 ether, 1_600 ether);
        vm.expectRevert(ArcLendV2.Invalid.selector);
        market.executeCapIncrease();
        vm.warp(block.timestamp + 48 hours);
        market.executeCapIncrease();
        assertEq(market.supplyCap(), 2_000 ether);
        assertEq(market.borrowCap(), 1_600 ether);
    }

    function testConstructorRejectsBadIrmParams() public {
        vm.expectRevert(ArcLendV2.Invalid.selector);
        new ArcLendV2(IERC20Collateral(address(token)), oracle, address(this), address(this), 1 ether, 1 ether, 0, 0, 0, 0);
        vm.expectRevert(ArcLendV2.Invalid.selector);
        new ArcLendV2(
            IERC20Collateral(address(token)), oracle, address(this), address(this), 1 ether, 1 ether, 0, 0, 0, WAD + 1
        );
    }

    function testFuzzUtilizationNeverExceedsWad(uint96 supplyRaw, uint96 borrowRaw) public {
        uint256 supplyAmt = bound(uint256(supplyRaw), 1 ether, 10_000 ether);
        uint256 borrowAmt = bound(uint256(borrowRaw), 0, supplyAmt);
        LendToken t2 = new LendToken(18);
        ArcManualOracle o2 = new ArcManualOracle(address(this), 2 ether);
        ArcLendV2 m2 = new ArcLendV2(
            IERC20Collateral(address(t2)), o2, address(this), address(this), type(uint128).max, type(uint128).max,
            BASE, MULT, JUMP, KINK
        );
        address s = address(0x999);
        vm.deal(s, supplyAmt);
        vm.prank(s);
        m2.supply{value: supplyAmt}();
        if (borrowAmt > 0) {
            address b = address(0x998);
            t2.mint(b, borrowAmt * 10);
            vm.startPrank(b);
            t2.approve(address(m2), type(uint256).max);
            m2.depositCollateral(borrowAmt * 10);
            m2.borrow(borrowAmt);
            vm.stopPrank();
        }
        assertLe(m2.utilization(), WAD);
        assertGe(m2.borrowRatePerYear(), BASE);
    }
}
