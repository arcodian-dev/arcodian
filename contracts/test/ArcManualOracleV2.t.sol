// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcManualOracleV2} from "../src/ArcManualOracleV2.sol";

contract ArcManualOracleV2Test is Test {
    address internal admin = address(0xA1);
    address internal attacker = address(0xE7);
    ArcManualOracleV2 internal oracle;

    function setUp() public {
        oracle = new ArcManualOracleV2(admin, 1 ether, 2_000); // 20% max move
    }

    function testConstructorRejectsMoveBoundOutOfRange() public {
        vm.expectRevert(ArcManualOracleV2.Invalid.selector);
        new ArcManualOracleV2(admin, 1 ether, 50);
        vm.expectRevert(ArcManualOracleV2.Invalid.selector);
        new ArcManualOracleV2(admin, 1 ether, 6_000);
    }

    function testOnlyAdminMaySetPrice() public {
        vm.prank(attacker);
        vm.expectRevert(ArcManualOracleV2.Unauthorized.selector);
        oracle.setPrice(1.05 ether);
    }

    function testWithinBoundMoveSucceeds() public {
        vm.prank(admin);
        oracle.setPrice(1.15 ether); // +15%, under the 20% cap
        (uint256 value,) = oracle.price();
        assertEq(value, 1.15 ether);
    }

    function testOversizedMoveReverts() public {
        vm.prank(admin);
        vm.expectRevert(ArcManualOracleV2.MoveTooLarge.selector);
        oracle.setPrice(1.5 ether); // +50%, over the 20% cap
    }

    function testOversizedDownwardMoveRevertsToo() public {
        vm.prank(admin);
        vm.expectRevert(ArcManualOracleV2.MoveTooLarge.selector);
        oracle.setPrice(0.5 ether); // -50%
    }

    function testZeroPriceRejected() public {
        vm.prank(admin);
        vm.expectRevert(ArcManualOracleV2.Invalid.selector);
        oracle.setPrice(0);
    }

    function testFuzzMoveWithinCapAlwaysSucceeds(uint256 bumpBps) public {
        bumpBps = bound(bumpBps, 0, 2_000);
        vm.prank(admin);
        oracle.setPrice(1 ether + (1 ether * bumpBps / 10_000));
        (uint256 value,) = oracle.price();
        assertGe(value, 1 ether);
    }
}
