// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcAdminTimelock} from "../src/ArcAdminTimelock.sol";

contract Sink {
    uint256 public x;
    function set(uint256 v) external payable { x = v; }
    function boom() external payable { revert("boom"); }
}

contract ArcAdminTimelockTest is Test {
    ArcAdminTimelock tl;
    Sink sink;
    address admin = address(1);
    address proposer = address(2);
    address executor = address(3);
    uint256 constant DELAY = 2 days;

    function setUp() public {
        sink = new Sink();
        address[] memory p = new address[](1); p[0] = proposer;
        address[] memory e = new address[](1); e[0] = executor;
        tl = new ArcAdminTimelock(DELAY, admin, p, e);
    }

    function data(uint256 v) internal pure returns (bytes memory) { return abi.encodeWithSelector(Sink.set.selector, v); }

    function scheduleSet(uint256 v, uint256 delay) internal returns (bytes32) {
        vm.prank(proposer);
        tl.schedule(address(sink), 0, data(v), bytes32(0), bytes32(0), delay);
        return tl.hashOperation(address(sink), 0, data(v), bytes32(0), bytes32(0));
    }

    function testScheduleThenExecuteAfterDelay() public {
        bytes32 id = scheduleSet(42, DELAY);
        assertEq(tl.state(id), 1); // Waiting
        vm.warp(block.timestamp + DELAY);
        assertEq(tl.state(id), 2); // Ready
        vm.prank(executor);
        tl.execute(address(sink), 0, data(42), bytes32(0), bytes32(0));
        assertEq(sink.x(), 42);
        assertEq(tl.state(id), 3); // Done
    }

    function testExecuteBeforeDelayReverts() public {
        scheduleSet(42, DELAY);
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(executor);
        vm.expectRevert(ArcAdminTimelock.NotReady.selector);
        tl.execute(address(sink), 0, data(42), bytes32(0), bytes32(0));
    }

    function testScheduleBelowMinDelayReverts() public {
        vm.prank(proposer);
        vm.expectRevert(ArcAdminTimelock.BadDelay.selector);
        tl.schedule(address(sink), 0, data(1), bytes32(0), bytes32(0), DELAY - 1);
    }

    function testDuplicateScheduleReverts() public {
        scheduleSet(42, DELAY);
        vm.prank(proposer);
        vm.expectRevert(ArcAdminTimelock.AlreadyScheduled.selector);
        tl.schedule(address(sink), 0, data(42), bytes32(0), bytes32(0), DELAY);
    }

    function testExecuteUnscheduledReverts() public {
        vm.prank(executor);
        vm.expectRevert(ArcAdminTimelock.NotScheduled.selector);
        tl.execute(address(sink), 0, data(99), bytes32(0), bytes32(0));
    }

    function testCancelPendingBlocksExecution() public {
        bytes32 id = scheduleSet(42, DELAY);
        vm.prank(proposer);
        tl.cancel(id);
        assertEq(tl.state(id), 0);
        vm.warp(block.timestamp + DELAY);
        vm.prank(executor);
        vm.expectRevert(ArcAdminTimelock.NotScheduled.selector);
        tl.execute(address(sink), 0, data(42), bytes32(0), bytes32(0));
    }

    function testCannotCancelDone() public {
        bytes32 id = scheduleSet(42, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(executor);
        tl.execute(address(sink), 0, data(42), bytes32(0), bytes32(0));
        vm.prank(proposer);
        vm.expectRevert(ArcAdminTimelock.NotScheduled.selector);
        tl.cancel(id);
    }

    function testPredecessorGating() public {
        bytes32 first = scheduleSet(1, DELAY);
        // second depends on first
        vm.prank(proposer);
        tl.schedule(address(sink), 0, data(2), first, bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        // executing second before first is done reverts
        vm.prank(executor);
        vm.expectRevert(ArcAdminTimelock.PredecessorNotDone.selector);
        tl.execute(address(sink), 0, data(2), first, bytes32(0));
        // do first, then second succeeds
        vm.prank(executor);
        tl.execute(address(sink), 0, data(1), bytes32(0), bytes32(0));
        vm.prank(executor);
        tl.execute(address(sink), 0, data(2), first, bytes32(0));
        assertEq(sink.x(), 2);
    }

    function testRoleGates() public {
        vm.prank(admin); // admin is not a proposer
        vm.expectRevert(ArcAdminTimelock.NotProposer.selector);
        tl.schedule(address(sink), 0, data(1), bytes32(0), bytes32(0), DELAY);
        scheduleSet(1, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(proposer); // proposer is not an executor
        vm.expectRevert(ArcAdminTimelock.NotExecutor.selector);
        tl.execute(address(sink), 0, data(1), bytes32(0), bytes32(0));
    }

    function testSelfGovernedDelayChange() public {
        // Only the timelock itself may change minDelay.
        vm.prank(admin);
        vm.expectRevert(ArcAdminTimelock.NotSelf.selector);
        tl.updateDelay(1 days);
        // Route the change through a scheduled operation.
        bytes memory call = abi.encodeWithSelector(ArcAdminTimelock.updateDelay.selector, uint256(1 days));
        vm.prank(proposer);
        tl.schedule(address(tl), 0, call, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(executor);
        tl.execute(address(tl), 0, call, bytes32(0), bytes32(0));
        assertEq(tl.minDelay(), 1 days);
    }

    function testCallRevertPropagates() public {
        bytes memory call = abi.encodeWithSelector(Sink.boom.selector);
        vm.prank(proposer);
        tl.schedule(address(sink), 0, call, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(executor);
        vm.expectRevert(ArcAdminTimelock.CallReverted.selector);
        tl.execute(address(sink), 0, call, bytes32(0), bytes32(0));
    }

    function testAdminManagesRolesAndTransfers() public {
        vm.prank(proposer);
        vm.expectRevert(ArcAdminTimelock.NotAdmin.selector);
        tl.setProposer(address(9), true);
        vm.prank(admin);
        tl.setProposer(address(9), true);
        assertTrue(tl.isProposer(address(9)));
        vm.prank(admin);
        tl.transferAdmin(address(4));
        assertEq(tl.admin(), admin); // unchanged until accepted
        assertEq(tl.pendingAdmin(), address(4));
        vm.prank(address(4));
        tl.acceptAdmin();
        assertEq(tl.admin(), address(4));
        assertEq(tl.pendingAdmin(), address(0));
    }

    function testTransferAdminRejectsZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(ArcAdminTimelock.Invalid.selector);
        tl.transferAdmin(address(0));
    }

    function testOnlyPendingAdminMayAccept() public {
        vm.prank(admin);
        tl.transferAdmin(address(4));
        vm.prank(address(5));
        vm.expectRevert(ArcAdminTimelock.NotPendingAdmin.selector);
        tl.acceptAdmin();
    }

    function testMistypedTransferIsHarmlessUntilAccepted() public {
        vm.prank(admin);
        tl.transferAdmin(address(0xDEAD));
        // Admin retains full control — a typo never bricks the contract.
        assertEq(tl.admin(), admin);
        vm.prank(admin);
        tl.setProposer(address(9), true);
        assertTrue(tl.isProposer(address(9)));
    }

    function testRenounceAdminIsSeparateFromTransfer() public {
        vm.prank(admin);
        tl.transferAdmin(address(4)); // pending, not yet accepted
        vm.prank(admin);
        tl.renounceAdmin();
        assertEq(tl.admin(), address(0));
        assertEq(tl.pendingAdmin(), address(0)); // pending proposal cleared too
        vm.prank(address(4));
        vm.expectRevert(ArcAdminTimelock.NotPendingAdmin.selector);
        tl.acceptAdmin();
    }

    function testRenounceAdminRequiresCurrentAdmin() public {
        vm.prank(address(9));
        vm.expectRevert(ArcAdminTimelock.NotAdmin.selector);
        tl.renounceAdmin();
    }
}
