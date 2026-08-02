// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcMultisig,ArcTimelock} from "../src/ArcGovernance.sol";

contract GovernanceTarget {uint256 public value; function setValue(uint256 next) external {value=next;}}

contract ArcGovernanceTest is Test {
    address ownerA=address(0xA);address ownerB=address(0xB);address outsider=address(0xC);
    ArcMultisig multisig;ArcTimelock timelock;GovernanceTarget target;
    function setUp() public {address[] memory owners=new address[](2);owners[0]=ownerA;owners[1]=ownerB;multisig=new ArcMultisig(owners,2);timelock=new ArcTimelock(address(multisig),1 days);target=new GovernanceTarget();}
    function _queue(uint64 eta) internal returns(uint256 txId,bytes memory data){data=abi.encodeCall(target.setValue,(42));bytes memory queueData=abi.encodeCall(timelock.queue,(address(target),0,data,eta));vm.prank(ownerA);txId=multisig.submit(address(timelock),0,queueData);vm.prank(ownerB);multisig.confirm(txId);multisig.execute(txId);}
    function testTwoOwnersAndDelayRequired() public {uint64 eta=uint64(block.timestamp+1 days);(,bytes memory data)=_queue(eta);vm.expectRevert(ArcTimelock.Invalid.selector);timelock.execute(address(target),0,data,eta);vm.warp(eta);vm.prank(outsider);timelock.execute(address(target),0,data,eta);assertEq(target.value(),42);}
    function testOneOwnerCannotExecute() public {bytes memory data=abi.encodeCall(target.setValue,(7));vm.prank(ownerA);uint256 id=multisig.submit(address(target),0,data);vm.expectRevert(ArcMultisig.Invalid.selector);multisig.execute(id);}
    function testOutsiderCannotSubmitOrQueue() public {vm.prank(outsider);vm.expectRevert(ArcMultisig.Unauthorized.selector);multisig.submit(address(target),0,"");vm.prank(outsider);vm.expectRevert(ArcTimelock.Unauthorized.selector);timelock.queue(address(target),0,"",uint64(block.timestamp+1 days));}
}
