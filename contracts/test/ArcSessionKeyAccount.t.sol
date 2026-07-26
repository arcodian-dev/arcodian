// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcSessionKeyAccount} from "../src/ArcSessionKeyAccount.sol";

contract MockTarget {
    uint256 public received;
    bytes32 public lastMemo;
    function receivePayment(bytes32 memo) external payable { received += msg.value; lastMemo = memo; }
    function other() external payable { received += msg.value; }
    function boom() external payable { revert("boom"); }
}

contract ReentrantTarget {
    ArcSessionKeyAccount immutable acct;
    constructor(ArcSessionKeyAccount a) { acct = a; }
    function receivePayment(bytes32) external payable {
        // Attempt to re-enter the locked executor.
        acct.execute(address(this), 1, abi.encodeWithSelector(this.receivePayment.selector, bytes32(0)));
    }
}

contract ArcSessionKeyAccountTest is Test {
    ArcSessionKeyAccount acct;
    MockTarget target;
    address owner = address(1);
    address key = address(2);
    bytes4 sel;

    function setUp() public {
        acct = new ArcSessionKeyAccount(owner);
        target = new MockTarget();
        sel = MockTarget.receivePayment.selector;
        vm.deal(owner, 100 ether);
        vm.prank(owner);
        payable(address(acct)).transfer(20 ether);
        vm.prank(owner);
        acct.installKey(key, address(target), sel, 2 ether, 5 ether, uint64(block.timestamp), uint64(block.timestamp + 7 days), 851811);
    }

    function callData(bytes32 memo) internal view returns (bytes memory) {
        return abi.encodeWithSelector(sel, memo);
    }

    function exec(uint256 value, bytes32 memo) internal {
        vm.prank(key);
        acct.execute(address(target), value, callData(memo));
    }

    function testHappyPathEnforcedExecution() public {
        exec(1 ether, bytes32(uint256(7)));
        assertEq(target.received(), 1 ether);
        assertEq(target.lastMemo(), bytes32(uint256(7)));
        (,,,, uint128 spentToday,,,,,,) = acct.capabilities(key);
        assertEq(spentToday, 1 ether);
    }

    function testWrongTargetReverts() public {
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.TargetDenied.selector);
        acct.execute(address(0xBEEF), 1 ether, callData(0));
    }

    function testWrongSelectorReverts() public {
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.SelectorDenied.selector);
        acct.execute(address(target), 1 ether, abi.encodeWithSelector(MockTarget.other.selector));
    }

    function testPerCallCapReverts() public {
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.Limit.selector);
        acct.execute(address(target), 3 ether, callData(0));
    }

    function testDailyCapAndDayRoll() public {
        exec(2 ether, bytes32(uint256(1)));
        exec(2 ether, bytes32(uint256(2)));
        exec(1 ether, bytes32(uint256(3))); // fills 5 ether daily cap
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.Limit.selector);
        acct.execute(address(target), 1 ether, callData(bytes32(uint256(4))));
        // next UTC day resets the rolling window
        vm.warp(block.timestamp + 1 days);
        exec(2 ether, bytes32(uint256(5)));
        assertEq(target.received(), 7 ether);
    }

    function testNotYetValidReverts() public {
        vm.prank(owner);
        acct.installKey(key, address(target), sel, 2 ether, 5 ether, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), 0);
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.NotYetValid.selector);
        acct.execute(address(target), 1 ether, callData(0));
    }

    function testExpiredReverts() public {
        vm.warp(block.timestamp + 8 days);
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.Expired.selector);
        acct.execute(address(target), 1 ether, callData(0));
    }

    function testRevokedReverts() public {
        vm.prank(owner);
        acct.revokeKey(key);
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.NotAuthorized.selector);
        acct.execute(address(target), 1 ether, callData(0));
    }

    function testUninstalledKeyReverts() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(ArcSessionKeyAccount.NotAuthorized.selector);
        acct.execute(address(target), 1 ether, callData(0));
    }

    function testZeroAndOverBalanceReverts() public {
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.Limit.selector);
        acct.execute(address(target), 0, callData(0));
        // fund a fresh account with less than perCallCap and try to overspend balance
        ArcSessionKeyAccount thin = new ArcSessionKeyAccount(owner);
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        payable(address(thin)).transfer(0.5 ether);
        vm.prank(owner);
        thin.installKey(key, address(target), sel, 2 ether, 5 ether, uint64(block.timestamp), uint64(block.timestamp + 1 days), 0);
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.Limit.selector);
        thin.execute(address(target), 1 ether, callData(0));
    }

    function testCallFailedPropagates() public {
        vm.prank(owner);
        acct.installKey(key, address(target), MockTarget.boom.selector, 2 ether, 5 ether, uint64(block.timestamp), uint64(block.timestamp + 1 days), 0);
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.CallFailed.selector);
        acct.execute(address(target), 1 ether, abi.encodeWithSelector(MockTarget.boom.selector));
    }

    function testReentrancyGuardHolds() public {
        ReentrantTarget evil = new ReentrantTarget(acct);
        vm.prank(owner);
        acct.installKey(key, address(evil), evil.receivePayment.selector, 2 ether, 5 ether, uint64(block.timestamp), uint64(block.timestamp + 1 days), 0);
        // outer execute forwards to evil, which re-enters execute -> lock reverts ->
        // outer sees the failed call and reverts CallFailed. No double spend occurs.
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.CallFailed.selector);
        acct.execute(address(evil), 1 ether, abi.encodeWithSelector(evil.receivePayment.selector, bytes32(0)));
    }

    function testOwnerOnlyControls() public {
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.OwnerOnly.selector);
        acct.installKey(key, address(target), sel, 1 ether, 1 ether, uint64(block.timestamp), uint64(block.timestamp + 1 days), 0);
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.OwnerOnly.selector);
        acct.revokeKey(key);
        vm.prank(key);
        vm.expectRevert(ArcSessionKeyAccount.OwnerOnly.selector);
        acct.withdraw(payable(key), 1 ether);
    }

    function testOwnerRetainsCustody() public {
        uint256 before = owner.balance;
        vm.prank(owner);
        acct.withdraw(payable(owner), 5 ether);
        assertEq(owner.balance, before + 5 ether);
    }

    function testInstallValidations() public {
        vm.startPrank(owner);
        vm.expectRevert(ArcSessionKeyAccount.Invalid.selector);
        acct.installKey(address(0), address(target), sel, 1 ether, 1 ether, uint64(block.timestamp), uint64(block.timestamp + 1 days), 0);
        vm.expectRevert(ArcSessionKeyAccount.Invalid.selector);
        acct.installKey(key, address(target), sel, 0, 1 ether, uint64(block.timestamp), uint64(block.timestamp + 1 days), 0);
        vm.expectRevert(ArcSessionKeyAccount.Invalid.selector); // dailyCap < perCallCap
        acct.installKey(key, address(target), sel, 2 ether, 1 ether, uint64(block.timestamp), uint64(block.timestamp + 1 days), 0);
        vm.expectRevert(ArcSessionKeyAccount.Invalid.selector); // validUntil in past
        acct.installKey(key, address(target), sel, 1 ether, 1 ether, uint64(block.timestamp), uint64(block.timestamp - 1), 0);
        vm.stopPrank();
    }
}
