// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArcPayAgentV4 { function pay(bytes32 invoiceId,address payable merchant,uint256 amount,uint64 expiresAt,address expectedPayer,bytes32 memoHash) external payable; }
interface IAgentPassportV4 { function agentIdOf(address wallet) external view returns(uint256); function ownerOfAgent(uint256 agentId) external view returns(address); }

/// @notice Identity-aware Agent Pay vault. Policies are keyed by ERC-8004 agentId;
/// the authorized wallet is resolved through ArcAgentPassport at execution time.
///
/// @dev V4 fix over V3: V3 only checked `passport.agentIdOf(msg.sender)` at
/// payment time, which trusts whatever wallet the passport CURRENTLY has
/// bound for that agentId — including a binding that's gone stale because the
/// agentId's Identity Registry ownership already moved on and nobody called
/// bindWallet/unbind yet. That's not a hypothetical: a real ArcAgentPassport
/// binding only updates when someone calls bindWallet, and Identity Registry
/// transfers don't (can't — it's an external registry we don't control) fire
/// that call automatically. V4 additionally requires that THIS vault's owner
/// is still the agentId's current registry owner at the moment of payment —
/// so the instant an agentId changes hands, every V3-style policy any
/// PREVIOUS owner set for it goes inert on its own, with no proactive
/// unbind/rebind required from anyone. This does not retrofit already-live V3
/// vaults (immutable, no upgrade path) — it's the template for new ones.
contract ArcAgentPayV4 {
    struct Policy { uint128 perPayment; uint128 dailyLimit; uint128 spentToday; uint64 validUntil; uint32 spendDay; bool enabled; }
    address public immutable owner;
    IArcPayAgentV4 public immutable arcPay;
    IAgentPassportV4 public immutable passport;
    mapping(uint256=>Policy) public policies;                       // agentId -> policy
    mapping(uint256=>mapping(address=>bool)) public merchantAllowed; // agentId -> merchant -> ok
    uint256 private unlocked=1;
    error OwnerOnly(); error AgentOnly(); error MerchantDenied(); error Limit(); error Expired(); error Invalid(); error TransferFailed(); error Reentrancy(); error NotCurrentOwner();
    event Funded(address indexed from,uint256 amount); event Withdrawn(address indexed to,uint256 amount);
    event AgentPolicySet(uint256 indexed agentId,uint256 perPayment,uint256 dailyLimit,uint64 validUntil,bool enabled);
    event MerchantPermission(uint256 indexed agentId,address indexed merchant,bool allowed);
    event AgentInvoicePaid(uint256 indexed agentId,address indexed agentWallet,bytes32 indexed invoiceId,address merchant,uint256 amount,uint256 spentToday);
    modifier onlyOwner(){if(msg.sender!=owner)revert OwnerOnly();_;}
    modifier lock(){if(unlocked!=1)revert Reentrancy();unlocked=2;_;unlocked=1;}
    constructor(address owner_,IArcPayAgentV4 arcPay_,IAgentPassportV4 passport_){if(owner_==address(0)||address(arcPay_)==address(0)||address(passport_)==address(0))revert Invalid();owner=owner_;arcPay=arcPay_;passport=passport_;}
    receive() external payable {emit Funded(msg.sender,msg.value);}
    // Requiring current registry ownership here too (not just at payment time)
    // stops an owner from configuring a policy for an agentId they don't (or
    // no longer) actually hold — the same staleness class of bug, one step earlier.
    function setPolicy(uint256 agentId,uint128 perPayment,uint128 dailyLimit,uint64 validUntil,bool enabled) external onlyOwner {
        if(agentId==0||perPayment==0||dailyLimit<perPayment||validUntil<=block.timestamp)revert Invalid();
        if(passport.ownerOfAgent(agentId)!=owner)revert NotCurrentOwner();
        Policy storage prior=policies[agentId];policies[agentId]=Policy(perPayment,dailyLimit,prior.spentToday,validUntil,prior.spendDay,enabled);emit AgentPolicySet(agentId,perPayment,dailyLimit,validUntil,enabled);
    }
    function setMerchant(uint256 agentId,address merchant,bool allowed) external onlyOwner {if(agentId==0||merchant==address(0))revert Invalid();merchantAllowed[agentId][merchant]=allowed;emit MerchantPermission(agentId,merchant,allowed);}
    function payInvoice(bytes32 invoiceId,address payable merchant,uint256 amount,uint64 invoiceExpiry,bytes32 memoHash) external lock {
        uint256 agentId=passport.agentIdOf(msg.sender);if(agentId==0)revert AgentOnly();
        if(passport.ownerOfAgent(agentId)!=owner)revert NotCurrentOwner();
        Policy storage policy=policies[agentId];if(!policy.enabled)revert AgentOnly();if(block.timestamp>policy.validUntil)revert Expired();if(!merchantAllowed[agentId][merchant])revert MerchantDenied();if(amount==0||amount>policy.perPayment||amount>address(this).balance)revert Limit();
        uint32 day=uint32(block.timestamp/1 days);if(policy.spendDay!=day){policy.spendDay=day;policy.spentToday=0;}
        uint256 next=uint256(policy.spentToday)+amount;if(next>policy.dailyLimit)revert Limit();policy.spentToday=uint128(next);
        arcPay.pay{value:amount}(invoiceId,merchant,amount,invoiceExpiry,address(this),memoHash);
        emit AgentInvoicePaid(agentId,msg.sender,invoiceId,merchant,amount,next);
    }
    function withdraw(address payable to,uint256 amount) external onlyOwner lock {if(to==address(0)||amount==0||amount>address(this).balance)revert Invalid();(bool ok,)=to.call{value:amount}("");if(!ok)revert TransferFailed();emit Withdrawn(to,amount);}
}
