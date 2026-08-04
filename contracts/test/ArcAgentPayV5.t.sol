// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcPay} from "../src/ArcPay.sol";
import {ArcAgentPayV5,IArcPayAgentV5,IAgentPassportV5} from "../src/ArcAgentPayV5.sol";

contract MockPassportV5 is IAgentPassportV5 {
    mapping(address=>uint256) public ids; mapping(uint256=>address) public owners;
    function set(address wallet,uint256 id) external {ids[wallet]=id;}
    function setOwner(uint256 id,address owner) external {owners[id]=owner;}
    function agentIdOf(address wallet) external view returns(uint256){return ids[wallet];}
    function ownerOfAgent(uint256 id) external view returns(address){return owners[id];}
}

contract ArcAgentPayV5Test is Test {
    ArcPay pay; ArcAgentPayV5 wallet; MockPassportV5 passport;
    uint256 ownerKey=0xA11CE; uint256 agentKey=0xA22CE; address owner; address agent; address merchant=address(3); uint256 constant AGENT_ID=7;
    function setUp() public {
        owner=vm.addr(ownerKey);agent=vm.addr(agentKey);pay=new ArcPay(payable(address(9)));passport=new MockPassportV5();
        wallet=new ArcAgentPayV5(owner,IArcPayAgentV5(address(pay)),IAgentPassportV5(address(passport)));
        vm.deal(owner,100 ether);vm.prank(owner);payable(wallet).transfer(20 ether);
        passport.set(agent,AGENT_ID);passport.setOwner(AGENT_ID,owner);
        vm.prank(owner);wallet.setPolicy(AGENT_ID,2 ether,5 ether,uint64(block.timestamp+7 days),true);
        vm.prank(owner);wallet.setMerchant(AGENT_ID,merchant,true);
    }
    function testERC1271AcceptsOwnerSignature() public view {
        bytes32 hash=keccak256("gateway-intent");(uint8 v,bytes32 r,bytes32 s)=vm.sign(ownerKey,hash);
        bytes memory signature=abi.encodePacked(r,s,v);
        assertEq(wallet.isValidSignature(hash,signature),wallet.ERC1271_MAGICVALUE());
    }
    function testERC1271RejectsOtherSigner() public view {
        bytes32 hash=keccak256("gateway-intent");(uint8 v,bytes32 r,bytes32 s)=vm.sign(0xB0B,hash);
        assertEq(wallet.isValidSignature(hash,abi.encodePacked(r,s,v)),wallet.ERC1271_INVALID());
    }
    function testRelayedPaymentConsumesSignerNonce() public {
        bytes32 invoiceId=keccak256("invoice-1");bytes32 memo=keccak256("memo");
        bytes32 typeHash=keccak256("Payment(bytes32 invoiceId,address merchant,uint256 amount,uint64 invoiceExpiry,bytes32 memoHash,uint256 nonce,uint64 deadline)");
        uint64 expiry=uint64(block.timestamp+1 days);uint64 deadline=uint64(block.timestamp+1 days);
        bytes32 structHash=keccak256(abi.encode(typeHash,invoiceId,merchant,1 ether,expiry,memo,0,deadline));
        bytes32 digest=keccak256(abi.encodePacked("\x19\x01",wallet.DOMAIN_SEPARATOR(),structHash));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(agentKey,digest);
        ArcAgentPayV5.Payment memory payment=ArcAgentPayV5.Payment(invoiceId,merchant,1 ether,expiry,memo,0,deadline);
        wallet.payInvoiceBySig(payment,abi.encodePacked(r,s,v));
        assertEq(wallet.nonces(agent),1); // nonce belongs to the signed agent wallet, not the relayer
    }
}
