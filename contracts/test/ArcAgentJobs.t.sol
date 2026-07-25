// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcPay} from "../src/ArcPay.sol";
import {ArcAgentJobs,IArcPayAgent} from "../src/ArcAgentJobs.sol";

// Malicious client that re-enters reclaimExpired on refund receipt.
contract ReentrantClient {
    ArcAgentJobs public target; uint256 public jobId; bool armed;
    function createOn(ArcAgentJobs t,address provider,address evaluator,uint64 expiry) external payable {
        target=t; jobId=t.createJob{value:msg.value}(provider,evaluator,expiry,bytes32(0),0);
    }
    function arm() external { armed=true; }
    receive() external payable {
        if(armed){ armed=false; target.reclaimExpired(jobId); }
    }
}

contract ArcAgentJobsTest is Test {
    ArcPay pay; ArcAgentJobs jobs;
    address treasury=address(9);
    address client=address(1); address provider=address(2); address evaluator=address(3);
    address clientB=address(11); address providerB=address(12); address evaluatorB=address(13);
    bytes32 constant DESC=keccak256("desc"); bytes32 constant DELIV=keccak256("deliverable"); bytes32 constant EVID=keccak256("evidence");

    function setUp() public {
        pay=new ArcPay(payable(treasury));
        jobs=new ArcAgentJobs(IArcPayAgent(address(pay)));
        vm.deal(client,100 ether); vm.deal(clientB,100 ether);
    }
    function _create(address c,uint256 budget) internal returns(uint256 id){
        vm.prank(c);
        id=jobs.createJob{value:budget}(provider,evaluator,uint64(block.timestamp+7 days),DESC,0);
    }

    function testCreateFundsAtomically() public {
        uint256 id=_create(client,5 ether);
        (address jc,address jp,address je,uint128 budget,,ArcAgentJobs.Status status,,,)=jobs.jobs(id);
        assertEq(id,1); assertEq(jc,client); assertEq(jp,provider); assertEq(je,evaluator);
        assertEq(budget,5 ether); assertEq(uint256(status),uint256(ArcAgentJobs.Status.Funded));
        assertEq(address(jobs).balance,5 ether); assertEq(jobs.jobCount(),1);
    }
    function testCreateRejectsZeroValue() public {
        vm.prank(client); vm.expectRevert(ArcAgentJobs.Invalid.selector);
        jobs.createJob{value:0}(provider,evaluator,uint64(block.timestamp+7 days),DESC,0);
    }
    function testCreateRejectsZeroProvider() public {
        vm.prank(client); vm.expectRevert(ArcAgentJobs.Invalid.selector);
        jobs.createJob{value:1 ether}(address(0),evaluator,uint64(block.timestamp+7 days),DESC,0);
    }
    function testCreateRejectsZeroEvaluator() public {
        vm.prank(client); vm.expectRevert(ArcAgentJobs.Invalid.selector);
        jobs.createJob{value:1 ether}(provider,address(0),uint64(block.timestamp+7 days),DESC,0);
    }
    function testCreateRejectsPastExpiry() public {
        vm.warp(1000); vm.prank(client); vm.expectRevert(ArcAgentJobs.Invalid.selector);
        jobs.createJob{value:1 ether}(provider,evaluator,uint64(block.timestamp-1),DESC,0);
    }
    function testCreateRejectsTooFarExpiry() public {
        vm.prank(client); vm.expectRevert(ArcAgentJobs.Invalid.selector);
        jobs.createJob{value:1 ether}(provider,evaluator,uint64(block.timestamp+91 days),DESC,0);
    }

    // --- submit ---
    function testSubmitByProvider() public {
        uint256 id=_create(client,2 ether);
        vm.prank(provider); jobs.submit(id,DELIV);
        (,,,,,ArcAgentJobs.Status status,,bytes32 deliv,)=jobs.jobs(id);
        assertEq(uint256(status),uint256(ArcAgentJobs.Status.Submitted)); assertEq(deliv,DELIV);
    }
    function testSubmitRejectsNonProvider() public {
        uint256 id=_create(client,2 ether);
        vm.prank(client); vm.expectRevert(ArcAgentJobs.NotProvider.selector); jobs.submit(id,DELIV);
    }
    function testSubmitRejectsWrongState() public {
        uint256 id=_create(client,2 ether);
        vm.prank(provider); jobs.submit(id,DELIV);
        vm.prank(provider); vm.expectRevert(ArcAgentJobs.BadState.selector); jobs.submit(id,DELIV);
    }
    function testSubmitRejectsAfterExpiry() public {
        uint256 id=_create(client,2 ether);
        vm.warp(block.timestamp+8 days);
        vm.prank(provider); vm.expectRevert(ArcAgentJobs.Expired.selector); jobs.submit(id,DELIV);
    }

    // --- evaluate ---
    function _submitReady(address c,uint256 budget) internal returns(uint256 id){
        id=_create(c,budget); vm.prank(provider); jobs.submit(id,DELIV);
    }
    function testEvaluateApproveSettlesProvider() public {
        uint256 id=_submitReady(client,10 ether);
        uint256 provBefore=provider.balance; uint256 treasBefore=treasury.balance;
        vm.prank(evaluator); jobs.evaluate(id,true,EVID);
        assertEq(provider.balance-provBefore,9.97 ether); // 10 - 0.3% fee
        assertEq(pay.accruedFees(),0.03 ether);
        (,,,,,ArcAgentJobs.Status status,,,)=jobs.jobs(id);
        assertEq(uint256(status),uint256(ArcAgentJobs.Status.Completed));
        assertEq(address(jobs).balance,0);
        assertEq(treasury.balance,treasBefore); // fee only paid on withdrawProtocolFees
    }
    function testEvaluateRejectRefundsClient() public {
        uint256 id=_submitReady(client,4 ether);
        uint256 cBefore=client.balance;
        vm.prank(evaluator); jobs.evaluate(id,false,EVID);
        assertEq(client.balance-cBefore,4 ether);
        (,,,,,ArcAgentJobs.Status status,,,)=jobs.jobs(id);
        assertEq(uint256(status),uint256(ArcAgentJobs.Status.Rejected));
        assertEq(address(jobs).balance,0);
    }
    function testEvaluateRejectsNonEvaluator() public {
        uint256 id=_submitReady(client,2 ether);
        vm.prank(client); vm.expectRevert(ArcAgentJobs.NotEvaluator.selector); jobs.evaluate(id,true,EVID);
    }
    function testEvaluateRejectsBeforeSubmit() public {
        uint256 id=_create(client,2 ether);
        vm.prank(evaluator); vm.expectRevert(ArcAgentJobs.BadState.selector); jobs.evaluate(id,true,EVID);
    }
    function testEvaluateRejectsDoubleSettle() public {
        uint256 id=_submitReady(client,2 ether);
        vm.prank(evaluator); jobs.evaluate(id,true,EVID);
        vm.prank(evaluator); vm.expectRevert(ArcAgentJobs.BadState.selector); jobs.evaluate(id,true,EVID);
    }

    // --- reclaimExpired ---
    function testReclaimAfterExpiryFromFunded() public {
        uint256 id=_create(client,3 ether);
        vm.warp(block.timestamp+8 days);
        uint256 cBefore=client.balance;
        vm.prank(address(99)); jobs.reclaimExpired(id); // anyone can call
        assertEq(client.balance-cBefore,3 ether);
        (,,,,,ArcAgentJobs.Status status,,,)=jobs.jobs(id);
        assertEq(uint256(status),uint256(ArcAgentJobs.Status.Expired));
    }
    function testReclaimAfterExpiryFromSubmitted() public {
        uint256 id=_submitReady(client,3 ether);
        vm.warp(block.timestamp+8 days);
        uint256 cBefore=client.balance;
        jobs.reclaimExpired(id);
        assertEq(client.balance-cBefore,3 ether);
    }
    function testReclaimRejectsBeforeExpiry() public {
        uint256 id=_create(client,3 ether);
        vm.expectRevert(ArcAgentJobs.NotYetExpired.selector); jobs.reclaimExpired(id);
    }
    function testReclaimRejectsCompletedJob() public {
        uint256 id=_submitReady(client,2 ether);
        vm.prank(evaluator); jobs.evaluate(id,true,EVID);
        vm.warp(block.timestamp+8 days);
        vm.expectRevert(ArcAgentJobs.BadState.selector); jobs.reclaimExpired(id);
    }

    // --- hardening: reentrancy + multi-tenant ---
    function testReentrantReclaimReverts() public {
        ReentrantClient rc=new ReentrantClient();
        vm.deal(address(rc),5 ether);
        rc.createOn{value:3 ether}(jobs,provider,evaluator,uint64(block.timestamp+7 days));
        vm.warp(block.timestamp+8 days);
        rc.arm();
        uint256 id=rc.jobId();
        vm.expectRevert(ArcAgentJobs.TransferFailed.selector); // inner reentrant call -> lock -> refund .call fails
        jobs.reclaimExpired(id);
    }
    function testMultiTenantIsolation() public {
        uint256 idA=_create(client,2 ether);
        vm.prank(clientB);
        uint256 idB=jobs.createJob{value:5 ether}(providerB,evaluatorB,uint64(block.timestamp+7 days),DESC,0);
        assertEq(idA,1); assertEq(idB,2);
        vm.prank(providerB); vm.expectRevert(ArcAgentJobs.NotProvider.selector); jobs.submit(idA,DELIV);
        vm.prank(evaluatorB); vm.expectRevert(ArcAgentJobs.NotEvaluator.selector); jobs.evaluate(idA,true,EVID);
        assertEq(address(jobs).balance,7 ether);
        (,,,uint128 budgetB,,,,,)=jobs.jobs(idB); assertEq(budgetB,5 ether);
    }
}
