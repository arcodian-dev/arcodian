// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArcPayAgentV6 { function pay(bytes32 invoiceId,address payable merchant,uint256 amount,uint64 expiresAt,address expectedPayer,bytes32 memoHash) external payable; }
interface IAgentPassportV6 { function agentIdOf(address wallet) external view returns(uint256); function ownerOfAgent(uint256 agentId) external view returns(address); }

/// @notice Additive Agent Pay vault with atomic EIP-712 batch payments.
/// @dev V6 is intentionally separate from deployed V5 vaults.
contract ArcAgentPayV6 {
    bytes4 public constant ERC1271_MAGICVALUE = 0x1626ba7e;
    bytes4 public constant ERC1271_INVALID = 0xffffffff;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant ITEM_TYPEHASH = keccak256("BatchItem(bytes32 invoiceId,address merchant,uint256 amount,uint64 invoiceExpiry,bytes32 memoHash)");
    bytes32 private constant BATCH_TYPEHASH = keccak256("Batch(bytes32 batchId,bytes32 itemsHash,uint256 nonce,uint64 deadline)");
    bytes32 private constant NAME_HASH = keccak256("ArcAgentPay");
    bytes32 private constant VERSION_HASH = keccak256("6");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 public constant MAX_BATCH_SIZE = 16;

    struct Policy { uint128 perPayment; uint128 dailyLimit; uint128 spentToday; uint64 validUntil; uint32 spendDay; bool enabled; }
    struct BatchPayment { bytes32 batchId; bytes32[] invoiceIds; address[] merchants; uint256[] amounts; uint64[] invoiceExpiries; bytes32[] memoHashes; uint256 nonce; uint64 deadline; }

    address public immutable owner; IArcPayAgentV6 public immutable arcPay; IAgentPassportV6 public immutable passport; bytes32 public immutable DOMAIN_SEPARATOR;
    mapping(uint256=>Policy) public policies; mapping(uint256=>mapping(address=>bool)) public merchantAllowed; mapping(address=>uint256) public nonces; uint256 private unlocked=1;
    error OwnerOnly(); error AgentOnly(); error MerchantDenied(); error Limit(); error Expired(); error Invalid(); error TransferFailed(); error Reentrancy(); error BadSignature(); error NonceUsed(); error NotCurrentOwner();
    event Funded(address indexed from,uint256 amount); event Withdrawn(address indexed to,uint256 amount); event AgentPolicySet(uint256 indexed agentId,uint256 perPayment,uint256 dailyLimit,uint64 validUntil,bool enabled); event MerchantPermission(uint256 indexed agentId,address indexed merchant,bool allowed);
    event AgentBatchPaid(uint256 indexed agentId,address indexed agentWallet,bytes32 indexed batchId,uint256 itemCount,uint256 totalAmount,uint256 spentToday); event NonceConsumed(address indexed signer,uint256 indexed nonce);
    modifier onlyOwner(){if(msg.sender!=owner)revert OwnerOnly();_;} modifier lock(){if(unlocked!=1)revert Reentrancy();unlocked=2;_;unlocked=1;}
    constructor(address owner_,IArcPayAgentV6 arcPay_,IAgentPassportV6 passport_){if(owner_==address(0)||address(arcPay_)==address(0)||address(passport_)==address(0))revert Invalid();owner=owner_;arcPay=arcPay_;passport=passport_;DOMAIN_SEPARATOR=keccak256(abi.encode(DOMAIN_TYPEHASH,NAME_HASH,VERSION_HASH,block.chainid,address(this)));}
    receive() external payable {emit Funded(msg.sender,msg.value);}
    function setPolicy(uint256 agentId,uint128 perPayment,uint128 dailyLimit,uint64 validUntil,bool enabled) external onlyOwner {if(agentId==0||perPayment==0||dailyLimit<perPayment||validUntil<=block.timestamp)revert Invalid();if(passport.ownerOfAgent(agentId)!=owner)revert NotCurrentOwner();Policy storage prior=policies[agentId];policies[agentId]=Policy(perPayment,dailyLimit,prior.spentToday,validUntil,prior.spendDay,enabled);emit AgentPolicySet(agentId,perPayment,dailyLimit,validUntil,enabled);}
    function setMerchant(uint256 agentId,address merchant,bool allowed) external onlyOwner {if(agentId==0||merchant==address(0))revert Invalid();merchantAllowed[agentId][merchant]=allowed;emit MerchantPermission(agentId,merchant,allowed);}
    function payBatchBySig(BatchPayment calldata batch,bytes calldata signature) external lock {
        uint256 length=batch.invoiceIds.length;if(length==0||length>MAX_BATCH_SIZE||length!=batch.merchants.length||length!=batch.amounts.length||length!=batch.invoiceExpiries.length||length!=batch.memoHashes.length||batch.deadline<block.timestamp)revert Invalid();
        bytes32[] memory itemHashes=new bytes32[](length);for(uint256 i;i<length;i++){itemHashes[i]=keccak256(abi.encode(ITEM_TYPEHASH,batch.invoiceIds[i],batch.merchants[i],batch.amounts[i],batch.invoiceExpiries[i],batch.memoHashes[i]));}
        bytes32 digest=keccak256(abi.encodePacked("\x19\x01",DOMAIN_SEPARATOR,keccak256(abi.encode(BATCH_TYPEHASH,batch.batchId,keccak256(abi.encodePacked(itemHashes)),batch.nonce,batch.deadline))));address signer=_recover(digest,signature);if(signer==address(0)||passport.agentIdOf(signer)==0)revert BadSignature();if(batch.nonce!=nonces[signer])revert NonceUsed();nonces[signer]=batch.nonce+1;emit NonceConsumed(signer,batch.nonce);
        uint256 total;for(uint256 i;i<length;i++){_pay(batch.invoiceIds[i],payable(batch.merchants[i]),batch.amounts[i],batch.invoiceExpiries[i],batch.memoHashes[i],signer);total+=batch.amounts[i];}emit AgentBatchPaid(passport.agentIdOf(signer),signer,batch.batchId,length,total,policies[passport.agentIdOf(signer)].spentToday);
    }
    function _pay(bytes32 invoiceId,address payable merchant,uint256 amount,uint64 invoiceExpiry,bytes32 memoHash,address agentWallet) internal {uint256 agentId=passport.agentIdOf(agentWallet);if(agentId==0)revert AgentOnly();if(passport.ownerOfAgent(agentId)!=owner)revert NotCurrentOwner();Policy storage policy=policies[agentId];if(!policy.enabled||block.timestamp>policy.validUntil||!merchantAllowed[agentId][merchant]||amount==0||amount>policy.perPayment||amount>address(this).balance)revert Limit();uint32 day=uint32(block.timestamp/1 days);if(policy.spendDay!=day){policy.spendDay=day;policy.spentToday=0;}uint256 next=uint256(policy.spentToday)+amount;if(next>policy.dailyLimit)revert Limit();policy.spentToday=uint128(next);arcPay.pay{value:amount}(invoiceId,merchant,amount,invoiceExpiry,address(this),memoHash);}
    function isValidSignature(bytes32 hash,bytes calldata signature) external view returns(bytes4){if(_recover(hash,signature)==owner)return ERC1271_MAGICVALUE;if(owner.code.length==0)return ERC1271_INVALID;(bool ok,bytes memory result)=owner.staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)",hash,signature));return ok&&result.length>=32&&bytes4(result)==ERC1271_MAGICVALUE?ERC1271_MAGICVALUE:ERC1271_INVALID;}
    function withdraw(address payable to,uint256 amount) external onlyOwner lock {if(to==address(0)||amount==0||amount>address(this).balance)revert Invalid();(bool ok,)=to.call{value:amount}("");if(!ok)revert TransferFailed();emit Withdrawn(to,amount);}
    function _recover(bytes32 hash,bytes calldata signature) internal pure returns(address signer){if(signature.length!=65)return address(0);uint8 v;bytes32 r;bytes32 s;assembly{r:=calldataload(signature.offset)s:=calldataload(add(signature.offset,32))v:=byte(0,calldataload(add(signature.offset,64)))}if(v<27)v+=27;if((v!=27&&v!=28)||uint256(s)>HALF_ORDER)return address(0);signer=ecrecover(hash,v,r,s);}
}
