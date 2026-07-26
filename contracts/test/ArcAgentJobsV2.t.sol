// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPay} from "../src/ArcPay.sol";
import {
    ArcAgentJobsV2,
    IArcPayJobsV2,
    IAgentPassportJobsV2
} from "../src/ArcAgentJobsV2.sol";

contract MockJobsPassport is IAgentPassportJobsV2 {
    mapping(uint256 => address) public walletOf;

    function bind(uint256 agentId, address wallet) external {
        walletOf[agentId] = wallet;
    }
}

contract ArcAgentJobsV2Test is Test {
    ArcPay internal pay;
    MockJobsPassport internal passport;
    ArcAgentJobsV2 internal jobs;

    address internal treasury = address(9);
    address internal client = address(1);
    address internal provider = address(2);
    address internal attacker = address(4);
    address internal evaluator = address(3);
    uint256 internal constant AGENT_ID = 851849;
    bytes32 internal constant DESC = keccak256("desc");
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");
    bytes32 internal constant EVIDENCE = keccak256("evidence");

    function setUp() public {
        pay = new ArcPay(payable(treasury));
        passport = new MockJobsPassport();
        passport.bind(AGENT_ID, provider);
        jobs = new ArcAgentJobsV2(
            IArcPayJobsV2(address(pay)),
            IAgentPassportJobsV2(address(passport))
        );
        vm.deal(client, 100 ether);
    }

    function _create(address namedProvider, uint256 agentId) internal returns (uint256) {
        vm.prank(client);
        return jobs.createJob{value: 1 ether}(
            namedProvider,
            evaluator,
            uint64(block.timestamp + 7 days),
            DESC,
            agentId
        );
    }

    function testBoundProviderIdentityCompletes() public {
        uint256 jobId = _create(provider, AGENT_ID);
        vm.prank(provider);
        jobs.submit(jobId, DELIVERABLE);
        uint256 before = provider.balance;
        vm.prank(evaluator);
        jobs.evaluate(jobId, true, EVIDENCE);
        assertEq(provider.balance - before, 0.997 ether);
        (,,,,, ArcAgentJobsV2.Status status,,, uint256 agentId) = jobs.jobs(jobId);
        assertEq(uint256(status), uint256(ArcAgentJobsV2.Status.Completed));
        assertEq(agentId, AGENT_ID);
    }

    function testRejectsVictimAgentIdForUnboundProvider() public {
        vm.prank(client);
        vm.expectRevert(ArcAgentJobsV2.IdentityMismatch.selector);
        jobs.createJob{value: 1 ether}(
            attacker,
            evaluator,
            uint64(block.timestamp + 7 days),
            DESC,
            AGENT_ID
        );
    }

    function testRejectsUnboundAgentId() public {
        vm.prank(client);
        vm.expectRevert(ArcAgentJobsV2.IdentityMismatch.selector);
        jobs.createJob{value: 1 ether}(
            provider,
            evaluator,
            uint64(block.timestamp + 7 days),
            DESC,
            AGENT_ID + 1
        );
    }

    function testAllowsExplicitAddressOnlyJob() public {
        uint256 jobId = _create(attacker, 0);
        (,,,,,,,, uint256 agentId) = jobs.jobs(jobId);
        assertEq(agentId, 0);
    }

    function testRotationRequiresCurrentBoundWallet() public {
        passport.bind(AGENT_ID, attacker);
        vm.prank(client);
        vm.expectRevert(ArcAgentJobsV2.IdentityMismatch.selector);
        jobs.createJob{value: 1 ether}(
            provider,
            evaluator,
            uint64(block.timestamp + 7 days),
            DESC,
            AGENT_ID
        );
        uint256 jobId = _create(attacker, AGENT_ID);
        assertEq(jobId, 1);
    }
}
