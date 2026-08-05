// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcPay} from "../src/ArcPay.sol";
import {ArcAgentPayV6,IArcPayAgentV6,IAgentPassportV6} from "../src/ArcAgentPayV6.sol";

contract MockPassportV6 is IAgentPassportV6 {
    mapping(address=>uint256) public ids; mapping(uint256=>address) public owners;
    function set(address wallet,uint256 id) external {ids[wallet]=id;} function setOwner(uint256 id,address owner) external {owners[id]=owner;}
    function agentIdOf(address wallet) external view returns(uint256){return ids[wallet];} function ownerOfAgent(uint256 id) external view returns(address){return owners[id];}
}
contract Mock1271OwnerV6 { function isValidSignature(bytes32,bytes calldata) external pure returns(bytes4){return 0x1626ba7e;} }

contract ArcAgentPayV6Test is Test {
    ArcPay pay; ArcAgentPayV6 wallet; MockPassportV6 passport; uint256 ownerKey=0xA11CE; uint256 agentKey=0xA22CE; address owner; address agent; address merchant=address(3); uint256 constant AGENT_ID=7;
    function setUp() public {owner=vm.addr(ownerKey);agent=vm.addr(agentKey);pay=new ArcPay(payable(address(9)));passport=new MockPassportV6();wallet=new ArcAgentPayV6(owner,IArcPayAgentV6(address(pay)),IAgentPassportV6(address(passport)));vm.deal(owner,100 ether);vm.prank(owner);payable(wallet).transfer(20 ether);passport.set(agent,AGENT_ID);passport.setOwner(AGENT_ID,owner);vm.prank(owner);wallet.setPolicy(AGENT_ID,2 ether,5 ether,uint64(block.timestamp+7 days),true);vm.prank(owner);wallet.setMerchant(AGENT_ID,merchant,true);}
    function testBatchConsumesOneNonceAndPaysAtomically() public {
        ArcAgentPayV6.BatchPayment memory batch=_makeBatch();
        bytes32[] memory hashes=new bytes32[](2);
        bytes32 itemType=keccak256("BatchItem(bytes32 invoiceId,address merchant,uint256 amount,uint64 invoiceExpiry,bytes32 memoHash)");
        for(uint256 i;i<2;i++) hashes[i]=keccak256(abi.encode(itemType,batch.invoiceIds[i],batch.merchants[i],batch.amounts[i],batch.invoiceExpiries[i],batch.memoHashes[i]));
        bytes32 batchType=keccak256("Batch(bytes32 batchId,bytes32 itemsHash,uint256 nonce,uint64 deadline)");
        bytes32 structHash=keccak256(abi.encode(batchType,batch.batchId,keccak256(abi.encodePacked(hashes)),batch.nonce,batch.deadline));
        bytes32 digest=keccak256(abi.encodePacked("\x19\x01",wallet.DOMAIN_SEPARATOR(),structHash));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(agentKey,digest);
        wallet.payBatchBySig(batch,abi.encodePacked(r,s,v));
        (,,uint128 spent,,,) = wallet.policies(AGENT_ID);
        assertEq(wallet.nonces(agent),1);assertEq(spent,2 ether);
    }
    function _makeBatch() internal view returns(ArcAgentPayV6.BatchPayment memory batch) {
        batch.batchId=keccak256("batch-1");batch.nonce=0;batch.deadline=uint64(block.timestamp+1 days);
        batch.invoiceIds=new bytes32[](2);batch.merchants=new address[](2);batch.amounts=new uint256[](2);batch.invoiceExpiries=new uint64[](2);batch.memoHashes=new bytes32[](2);
        for(uint256 i;i<2;i++){batch.invoiceIds[i]=keccak256(abi.encodePacked("invoice-",i));batch.merchants[i]=merchant;batch.amounts[i]=1 ether;batch.invoiceExpiries[i]=uint64(block.timestamp+1 days);batch.memoHashes[i]=keccak256(abi.encodePacked("memo-",i));}
    }
    function testBatchRejectsReplayAfterNonceConsumption() public {
        ArcAgentPayV6.BatchPayment memory batch=_makeBatch();
        bytes memory signature=_sign(batch,agentKey);
        wallet.payBatchBySig(batch,signature);
        vm.expectRevert(ArcAgentPayV6.NonceUsed.selector);
        wallet.payBatchBySig(batch,signature);
    }
    function testBatchRejectsExpiredDeadline() public {
        ArcAgentPayV6.BatchPayment memory batch=_makeBatch();
        batch.deadline=uint64(block.timestamp-1);
        vm.expectRevert(ArcAgentPayV6.Invalid.selector);
        wallet.payBatchBySig(batch,"");
    }
    function testBatchRejectsMutatedSignedAmount() public {
        ArcAgentPayV6.BatchPayment memory batch=_makeBatch();
        bytes memory signature=_sign(batch,agentKey);
        batch.amounts[0]=2 ether;
        vm.expectRevert(ArcAgentPayV6.BadSignature.selector);
        wallet.payBatchBySig(batch,signature);
    }
    function _sign(ArcAgentPayV6.BatchPayment memory batch,uint256 key) internal view returns(bytes memory) {
        bytes32[] memory hashes=new bytes32[](batch.invoiceIds.length);
        bytes32 itemType=keccak256("BatchItem(bytes32 invoiceId,address merchant,uint256 amount,uint64 invoiceExpiry,bytes32 memoHash)");
        for(uint256 i;i<batch.invoiceIds.length;i++) hashes[i]=keccak256(abi.encode(itemType,batch.invoiceIds[i],batch.merchants[i],batch.amounts[i],batch.invoiceExpiries[i],batch.memoHashes[i]));
        bytes32 batchType=keccak256("Batch(bytes32 batchId,bytes32 itemsHash,uint256 nonce,uint64 deadline)");
        bytes32 digest=keccak256(abi.encodePacked("\x19\x01",wallet.DOMAIN_SEPARATOR(),keccak256(abi.encode(batchType,batch.batchId,keccak256(abi.encodePacked(hashes)),batch.nonce,batch.deadline))));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(key,digest);
        return abi.encodePacked(r,s,v);
    }
    function testBatchRejectsOversizedPayload() public {bytes32[] memory ids=new bytes32[](17);address[] memory merchants=new address[](17);uint256[] memory amounts=new uint256[](17);uint64[] memory expiries=new uint64[](17);bytes32[] memory memos=new bytes32[](17);ArcAgentPayV6.BatchPayment memory batch=ArcAgentPayV6.BatchPayment(bytes32(0),ids,merchants,amounts,expiries,memos,0,uint64(block.timestamp+1 days));vm.expectRevert(ArcAgentPayV6.Invalid.selector);wallet.payBatchBySig(batch,"");}
    function testERC1271DelegatesToSmartWalletOwner() public {Mock1271OwnerV6 smartOwner=new Mock1271OwnerV6();ArcAgentPayV6 smartVault=new ArcAgentPayV6(address(smartOwner),IArcPayAgentV6(address(pay)),IAgentPassportV6(address(passport)));assertEq(smartVault.isValidSignature(keccak256("gateway-intent"),"0x1234"),smartVault.ERC1271_MAGICVALUE());}
}
