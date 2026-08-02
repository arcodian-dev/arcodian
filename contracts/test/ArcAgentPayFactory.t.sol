// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcPay} from "../src/ArcPay.sol";
import {ArcAgentPay, IArcPayAgent} from "../src/ArcAgentPay.sol";
import {ArcAgentPayFactory} from "../src/ArcAgentPayFactory.sol";

contract ArcAgentPayFactoryTest is Test {
    ArcPay pay; ArcAgentPayFactory factory;
    address alice=address(0xA11CE); address bob=address(0xB0B); address agent=address(0xA6E17); address merchant=address(0xBEEF);
    function setUp() public { pay=new ArcPay(payable(address(9))); factory=new ArcAgentPayFactory(IArcPayAgent(address(pay))); vm.deal(alice,10 ether); vm.deal(bob,10 ether); }
    function create(address owner,uint256 value) internal returns(ArcAgentPay vault){vm.prank(owner);vault=ArcAgentPay(payable(factory.createVault{value:value}()));}
    function testCreatesIsolatedOwnerFundedVaults() public {ArcAgentPay a=create(alice,2 ether);ArcAgentPay b=create(bob,3 ether);assertEq(a.owner(),alice);assertEq(b.owner(),bob);assertEq(address(a).balance,2 ether);assertEq(address(b).balance,3 ether);assertEq(factory.vaultOf(alice),address(a));assertEq(factory.vaultCount(),2);}
    function testOwnerSelfConfiguresAndAgentPays() public {ArcAgentPay v=create(alice,2 ether);vm.startPrank(alice);v.setPolicy(agent,1 ether,2 ether,uint64(block.timestamp+1 days),true);v.setMerchant(agent,merchant,true);vm.stopPrank();vm.prank(agent);v.payInvoice(bytes32(uint256(1)),payable(merchant),1 ether,uint64(block.timestamp+1 hours),0);assertEq(merchant.balance,0.997 ether);}
    function testCannotCreateSecondVault() public {create(alice,0);vm.prank(alice);vm.expectRevert(ArcAgentPayFactory.VaultExists.selector);factory.createVault();}
    function testOneOwnerCannotControlAnotherVault() public {ArcAgentPay a=create(alice,0);create(bob,0);vm.prank(bob);vm.expectRevert(ArcAgentPay.OwnerOnly.selector);a.setPolicy(agent,1,1,uint64(block.timestamp+1),true);}
}
