// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcLend, ArcManualOracle, IERC20Collateral} from "../src/ArcLend.sol";

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

contract ArcLendTest is Test {
    LendToken token;
    ArcManualOracle oracle;
    ArcLend market;
    address supplier = address(0x51);
    address borrower = address(0xB0);
    address liquidator = address(0x1);

    function setUp() public {
        token = new LendToken(18);
        oracle = new ArcManualOracle(address(this), 2 ether);
        market = new ArcLend(
            IERC20Collateral(address(token)), oracle, address(this), address(this), 1_000 ether, 800 ether, 8e16
        );
        vm.deal(supplier, 500 ether);
        vm.prank(supplier);
        market.supply{value: 500 ether}();
        token.mint(borrower, 100 ether);
        vm.prank(borrower);
        token.approve(address(market), type(uint256).max);
        vm.deal(liquidator, 100 ether);
    }

    function _position() internal {
        vm.startPrank(borrower);
        market.depositCollateral(100 ether);
        market.borrow(100 ether);
        vm.stopPrank();
    }

    function testSupplyBorrowRepayWithdraw() public {
        _position();
        assertEq(borrower.balance, 100 ether);
        assertEq(market.debtOf(borrower), 100 ether);
        vm.prank(borrower);
        market.repay{value: 100 ether}(borrower);
        assertEq(market.debtShares(borrower), 0);
        uint256 shares = market.supplyShares(supplier);
        vm.prank(supplier);
        uint256 out = market.withdraw(shares);
        assertGe(out, 500 ether);
    }

    function testRepayAllowsOverpaymentAndRefundsExcess() public {
        _position();
        vm.warp(block.timestamp + 1 days);
        vm.deal(borrower, 101 ether);
        uint256 before = borrower.balance;
        vm.prank(borrower);
        market.repay{value: 101 ether}(borrower);
        assertEq(market.debtShares(borrower), 0);
        assertGt(borrower.balance, before - 101 ether);
    }

    function testAccrualCreatesSupplierYieldAndTenPercentReserve() public {
        _position();
        vm.warp(block.timestamp + 365 days);
        market.accrue();
        assertApproxEqRel(market.totalBorrows(), 108 ether, 1e14);
        assertApproxEqRel(market.reserves(), 0.8 ether, 1e14);
        assertGt(market.totalAssets(), 500 ether);
    }

    function testBorrowCapAndLtvEnforced() public {
        vm.startPrank(borrower);
        market.depositCollateral(100 ether);
        vm.expectRevert(ArcLend.Health.selector);
        market.borrow(141 ether);
        vm.stopPrank();
    }

    function testStaleOracleBlocksRiskIncrease() public {
        vm.warp(block.timestamp + 2 hours);
        vm.startPrank(borrower);
        market.depositCollateral(100 ether);
        vm.expectRevert(ArcLend.OracleStale.selector);
        market.borrow(1 ether);
        vm.stopPrank();
    }

    function testOracleAdminMayDifferFromDeployer() public {
        address externalAdmin = address(0xA11CE);
        ArcManualOracle externalOracle = new ArcManualOracle(externalAdmin, 1 ether);
        (uint256 value, uint64 updatedAt) = externalOracle.price();
        assertEq(externalOracle.admin(), externalAdmin);
        assertEq(value, 1 ether);
        assertEq(updatedAt, block.timestamp);
        vm.expectRevert();
        externalOracle.setPrice(2 ether);
        vm.prank(externalAdmin);
        externalOracle.setPrice(2 ether);
        (value,) = externalOracle.price();
        assertEq(value, 2 ether);
    }

    function testLiquidationAfterPriceDrop() public {
        _position();
        oracle.setPrice(1 ether);
        market.acceptOraclePrice();
        uint256 before = token.balanceOf(liquidator);
        vm.prank(liquidator);
        market.liquidate{value: 50 ether}(borrower);
        assertGt(token.balanceOf(liquidator), before);
        assertLt(market.debtOf(borrower), 100 ether);
    }

    function testSixDecimalCollateralNormalizationAndLiquidation() public {
        LendToken token6 = new LendToken(6);
        ArcManualOracle oracle6 = new ArcManualOracle(address(this), 1 ether);
        ArcLend market6 = new ArcLend(
            IERC20Collateral(address(token6)), oracle6, address(this), address(this), 1_000 ether, 800 ether, 8e16
        );
        vm.deal(supplier, 500 ether);
        vm.prank(supplier);
        market6.supply{value: 500 ether}();
        token6.mint(borrower, 100e6);
        vm.startPrank(borrower);
        token6.approve(address(market6), type(uint256).max);
        market6.depositCollateral(100e6);
        assertEq(market6.collateralValue(borrower), 100 ether);
        market6.borrow(70 ether);
        vm.stopPrank();

        oracle6.setPrice(0.8 ether);
        market6.acceptOraclePrice();
        uint256 before = token6.balanceOf(liquidator);
        vm.prank(liquidator);
        market6.liquidate{value: 35 ether}(borrower);
        assertEq(token6.balanceOf(liquidator) - before, 45_937_500);
    }

    function testPauseBlocksNewSupply() public {
        market.setPaused(true);
        vm.deal(address(9), 1 ether);
        vm.prank(address(9));
        vm.expectRevert(ArcLend.PausedError.selector);
        market.supply{value: 1 ether}();
    }

    function testDeviationCircuitBreakerAndGuardianAcceptance() public {
        oracle.setPrice(1 ether);
        vm.expectRevert(ArcLend.OracleDeviation.selector);
        market.syncOracle();
        market.acceptOraclePrice();
        assertEq(market.lastGoodPrice(), 1 ether);
    }

    function testGranularPauseAndAdjustableCaps() public {
        market.setPauseFlags(market.PAUSE_BORROW());
        vm.startPrank(borrower);
        market.depositCollateral(1 ether);
        vm.expectRevert(ArcLend.PausedError.selector);
        market.borrow(1 ether);
        vm.stopPrank();
        market.setCaps(900 ether, 700 ether);
        assertEq(market.borrowCap(), 700 ether);
    }

    function testCapIncreaseRequiresDelayAndIsPermissionlessAfterEta() public {
        market.scheduleCapIncrease(1_200 ether, 900 ether);
        vm.expectRevert(ArcLend.Invalid.selector);
        market.executeCapIncrease();
        vm.warp(block.timestamp + market.CAP_INCREASE_DELAY());
        vm.prank(address(0xBEEF));
        market.executeCapIncrease();
        assertEq(market.supplyCap(), 1_200 ether);
        assertEq(market.borrowCap(), 900 ether);
    }

    function testGuardianCanLowerAndCancelButCannotRaiseOrAcceptOracle() public {
        address separateGuardian = address(0x600D);
        market.setGuardian(separateGuardian);
        oracle.setPrice(1 ether);
        vm.startPrank(separateGuardian);
        market.setCaps(900 ether, 700 ether);
        vm.expectRevert(ArcLend.Cap.selector);
        market.setCaps(901 ether, 700 ether);
        vm.expectRevert(ArcLend.Unauthorized.selector);
        market.acceptOraclePrice();
        vm.stopPrank();
        market.scheduleCapIncrease(1_100 ether, 800 ether);
        vm.prank(separateGuardian);
        market.cancelCapIncrease();
        assertEq(market.capIncreaseEta(), 0);
    }

    function testFuzzSupplyShares(uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1e12, 400 ether);
        address user = address(0x77);
        vm.deal(user, amount);
        vm.prank(user);
        uint256 shares = market.supply{value: amount}();
        assertGt(shares, 0);
    }
}
