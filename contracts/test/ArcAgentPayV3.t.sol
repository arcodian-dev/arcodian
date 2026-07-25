// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcPay} from "../src/ArcPay.sol";
import {ArcAgentPayV3,IArcPayAgent,IAgentPassport} from "../src/ArcAgentPayV3.sol";
import {ArcAgentPayFactoryV3} from "../src/ArcAgentPayFactoryV3.sol";

contract MockPassport is IAgentPassport {
    mapping(address=>uint256) public ids;
    function set(address w,uint256 id) external {ids[w]=id;}
    function agentIdOf(address w) external view returns(uint256){return ids[w];}
}

contract ArcAgentPayV3Test is Test {
    ArcPay pay; ArcAgentPayV3 wallet; MockPassport pp;
    address owner=address(1); address walletA=address(2); address walletB=address(22); address merchant=address(3);
    uint256 constant AID=7;
    function setUp() public {
        pay=new ArcPay(payable(address(9))); pp=new MockPassport();
        wallet=new ArcAgentPayV3(owner,IArcPayAgent(address(pay)),IAgentPassport(address(pp)));
        vm.deal(owner,100 ether); vm.prank(owner); payable(wallet).transfer(20 ether);
        pp.set(walletA,AID);
        vm.startPrank(owner);
        wallet.setPolicy(AID,2 ether,5 ether,uint64(block.timestamp+7 days),true);
        wallet.setMerchant(AID,merchant,true);
        vm.stopPrank();
    }
    function pInvoice(uint256 salt,uint256 amount,address from) internal {vm.prank(from);wallet.payInvoice(bytes32(salt),payable(merchant),amount,uint64(block.timestamp+1 days),bytes32(salt));}
    function testBoundWalletPays() public {uint256 before=merchant.balance;pInvoice(1,1 ether,walletA);assertEq(merchant.balance-before,0.997 ether);}
    function testUnboundWalletReverts() public {vm.prank(walletB);vm.expectRevert(ArcAgentPayV3.AgentOnly.selector);wallet.payInvoice(0,payable(merchant),1 ether,uint64(block.timestamp+1 days),0);}
    function testRotationTransfersAuthority() public {pInvoice(1,2 ether,walletA);pp.set(walletA,0);pp.set(walletB,AID);vm.prank(walletA);vm.expectRevert(ArcAgentPayV3.AgentOnly.selector);wallet.payInvoice(bytes32(uint256(2)),payable(merchant),1 ether,uint64(block.timestamp+1 days),0);uint256 before=merchant.balance;pInvoice(3,2 ether,walletB);assertEq(merchant.balance-before,1.994 ether);}
    function testDailyCounterSharedAcrossRotation() public {pInvoice(1,2 ether,walletA);pp.set(walletA,0);pp.set(walletB,AID);pInvoice(2,2 ether,walletB);vm.prank(walletB);vm.expectRevert(ArcAgentPayV3.Limit.selector);wallet.payInvoice(bytes32(uint256(3)),payable(merchant),2 ether,uint64(block.timestamp+1 days),0);}
    function testPerPaymentCap() public {vm.prank(walletA);vm.expectRevert(ArcAgentPayV3.Limit.selector);wallet.payInvoice(0,payable(merchant),3 ether,uint64(block.timestamp+1 days),0);}
    function testMerchantDenied() public {vm.prank(walletA);vm.expectRevert(ArcAgentPayV3.MerchantDenied.selector);wallet.payInvoice(0,payable(address(4)),1 ether,uint64(block.timestamp+1 days),0);}
    function testExpiredPolicyReverts() public {vm.warp(block.timestamp+8 days);vm.prank(walletA);vm.expectRevert(ArcAgentPayV3.Expired.selector);wallet.payInvoice(0,payable(merchant),1 ether,uint64(block.timestamp+1 days),0);}
    function testOnlyOwnerConfigures() public {vm.prank(walletA);vm.expectRevert(ArcAgentPayV3.OwnerOnly.selector);wallet.setPolicy(AID,1 ether,1 ether,uint64(block.timestamp+1 days),true);}
    function testFactoryCreatesOneVaultPerOwner() public {ArcAgentPayFactoryV3 f=new ArcAgentPayFactoryV3(IArcPayAgent(address(pay)),IAgentPassport(address(pp)));vm.prank(owner);address v=f.createVault();assertEq(f.vaultOf(owner),v);vm.prank(owner);vm.expectRevert(ArcAgentPayFactoryV3.VaultExists.selector);f.createVault();}
}
