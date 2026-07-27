// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcPay} from "../src/ArcPay.sol";
import {ArcAgentPayV4,IArcPayAgentV4,IAgentPassportV4} from "../src/ArcAgentPayV4.sol";
import {ArcAgentPayFactoryV4} from "../src/ArcAgentPayFactoryV4.sol";

contract MockPassportV4 is IAgentPassportV4 {
    mapping(address=>uint256) public ids;
    mapping(uint256=>address) public owners;
    function set(address w,uint256 id) external {ids[w]=id;}
    function setOwner(uint256 id,address o) external {owners[id]=o;}
    function agentIdOf(address w) external view returns(uint256){return ids[w];}
    function ownerOfAgent(uint256 id) external view returns(address){return owners[id];}
}

contract ArcAgentPayV4Test is Test {
    ArcPay pay; ArcAgentPayV4 wallet; MockPassportV4 pp;
    address owner=address(1); address walletA=address(2); address walletB=address(22); address merchant=address(3); address buyer=address(4);
    uint256 constant AID=7;
    function setUp() public {
        pay=new ArcPay(payable(address(9))); pp=new MockPassportV4();
        wallet=new ArcAgentPayV4(owner,IArcPayAgentV4(address(pay)),IAgentPassportV4(address(pp)));
        vm.deal(owner,100 ether); vm.prank(owner); payable(wallet).transfer(20 ether);
        pp.set(walletA,AID); pp.setOwner(AID,owner);
        vm.startPrank(owner);
        wallet.setPolicy(AID,2 ether,5 ether,uint64(block.timestamp+7 days),true);
        wallet.setMerchant(AID,merchant,true);
        vm.stopPrank();
    }
    function pInvoice(uint256 salt,uint256 amount,address from) internal {vm.prank(from);wallet.payInvoice(bytes32(salt),payable(merchant),amount,uint64(block.timestamp+1 days),bytes32(salt));}

    function testBoundWalletPays() public {uint256 before=merchant.balance;pInvoice(1,1 ether,walletA);assertEq(merchant.balance-before,0.997 ether);}
    function testUnboundWalletReverts() public {vm.prank(walletB);vm.expectRevert(ArcAgentPayV4.AgentOnly.selector);wallet.payInvoice(0,payable(merchant),1 ether,uint64(block.timestamp+1 days),0);}
    function testRotationTransfersAuthority() public {pInvoice(1,2 ether,walletA);pp.set(walletA,0);pp.set(walletB,AID);vm.prank(walletA);vm.expectRevert(ArcAgentPayV4.AgentOnly.selector);wallet.payInvoice(bytes32(uint256(2)),payable(merchant),1 ether,uint64(block.timestamp+1 days),0);uint256 before=merchant.balance;pInvoice(3,2 ether,walletB);assertEq(merchant.balance-before,1.994 ether);}
    function testDailyCounterSharedAcrossRotation() public {pInvoice(1,2 ether,walletA);pp.set(walletA,0);pp.set(walletB,AID);pInvoice(2,2 ether,walletB);vm.prank(walletB);vm.expectRevert(ArcAgentPayV4.Limit.selector);wallet.payInvoice(bytes32(uint256(3)),payable(merchant),2 ether,uint64(block.timestamp+1 days),0);}
    function testPerPaymentCap() public {vm.prank(walletA);vm.expectRevert(ArcAgentPayV4.Limit.selector);wallet.payInvoice(0,payable(merchant),3 ether,uint64(block.timestamp+1 days),0);}
    function testMerchantDenied() public {vm.prank(walletA);vm.expectRevert(ArcAgentPayV4.MerchantDenied.selector);wallet.payInvoice(0,payable(address(44)),1 ether,uint64(block.timestamp+1 days),0);}
    function testExpiredPolicyReverts() public {vm.warp(block.timestamp+8 days);vm.prank(walletA);vm.expectRevert(ArcAgentPayV4.Expired.selector);wallet.payInvoice(0,payable(merchant),1 ether,uint64(block.timestamp+1 days),0);}
    function testOnlyOwnerConfigures() public {vm.prank(walletA);vm.expectRevert(ArcAgentPayV4.OwnerOnly.selector);wallet.setPolicy(AID,1 ether,1 ether,uint64(block.timestamp+1 days),true);}
    function testFactoryCreatesOneVaultPerOwner() public {ArcAgentPayFactoryV4 f=new ArcAgentPayFactoryV4(IArcPayAgentV4(address(pay)),IAgentPassportV4(address(pp)));vm.prank(owner);address v=f.createVault();assertEq(f.vaultOf(owner),v);vm.prank(owner);vm.expectRevert(ArcAgentPayFactoryV4.VaultExists.selector);f.createVault();}

    // --- V4-specific: staleness protection when an agentId changes hands ---

    function testSetPolicyRejectsAgentIdOwnerDoesNotCurrentlyHold() public {
        vm.prank(owner);
        vm.expectRevert(ArcAgentPayV4.NotCurrentOwner.selector);
        wallet.setPolicy(999, 1 ether, 1 ether, uint64(block.timestamp + 1 days), true); // owner never registered as holder of 999
    }

    function testPayInvoiceGoesInertTheMomentAgentIdIsSold() public {
        // Sanity: the policy works before any sale.
        pInvoice(1, 1 ether, walletA);
        // Simulate selling agentId 7 in the Identity Registry to `buyer` — the
        // passport binding (walletA) is deliberately left stale, exactly the
        // real-world gap: nobody calls bindWallet/unbind on a sale.
        pp.setOwner(AID, buyer);
        // walletA is still bound to AID in the passport, but this vault's
        // owner is no longer AID's registry owner — must now revert instead
        // of letting the stale binding keep spending the former owner's vault.
        vm.prank(walletA);
        vm.expectRevert(ArcAgentPayV4.NotCurrentOwner.selector);
        wallet.payInvoice(bytes32(uint256(2)), payable(merchant), 1 ether, uint64(block.timestamp + 1 days), 0);
    }

    function testSetPolicyAlsoBlockedAfterSaleEvenIfOwnerTriesToReconfigure() public {
        pp.setOwner(AID, buyer);
        vm.prank(owner);
        vm.expectRevert(ArcAgentPayV4.NotCurrentOwner.selector);
        wallet.setPolicy(AID, 1 ether, 1 ether, uint64(block.timestamp + 1 days), true);
    }
}
