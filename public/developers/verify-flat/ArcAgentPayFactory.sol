// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// src/ArcAgentPay.sol

interface IArcPayAgent {
    function pay(bytes32 invoiceId,address payable merchant,uint256 amount,uint64 expiresAt,address expectedPayer,bytes32 memoHash) external payable;
}

/// @notice Owner-funded native-USDC smart account with tightly bounded agent spending.
contract ArcAgentPay {
    struct Policy { uint128 perPayment; uint128 dailyLimit; uint128 spentToday; uint64 validUntil; uint32 spendDay; bool enabled; }
    address public immutable owner;
    IArcPayAgent public immutable arcPay;
    mapping(address=>Policy) public policies;
    mapping(address=>mapping(address=>bool)) public merchantAllowed;
    uint256 private unlocked=1;
    error OwnerOnly(); error AgentOnly(); error MerchantDenied(); error Limit(); error Expired(); error Invalid(); error TransferFailed(); error Reentrancy();
    event Funded(address indexed from,uint256 amount); event Withdrawn(address indexed to,uint256 amount);
    event AgentPolicySet(address indexed agent,uint256 perPayment,uint256 dailyLimit,uint64 validUntil,bool enabled);
    event MerchantPermission(address indexed agent,address indexed merchant,bool allowed);
    event AgentInvoicePaid(address indexed agent,bytes32 indexed invoiceId,address indexed merchant,uint256 amount,uint256 spentToday);
    modifier onlyOwner(){if(msg.sender!=owner)revert OwnerOnly();_;} modifier lock(){if(unlocked!=1)revert Reentrancy();unlocked=2;_;unlocked=1;}
    constructor(address owner_,IArcPayAgent arcPay_){if(owner_==address(0)||address(arcPay_)==address(0))revert Invalid();owner=owner_;arcPay=arcPay_;}
    receive() external payable {emit Funded(msg.sender,msg.value);}
    function setPolicy(address agent,uint128 perPayment,uint128 dailyLimit,uint64 validUntil,bool enabled) external onlyOwner {if(agent==address(0)||perPayment==0||dailyLimit<perPayment||validUntil<=block.timestamp)revert Invalid();Policy storage prior=policies[agent];policies[agent]=Policy(perPayment,dailyLimit,prior.spentToday,validUntil,prior.spendDay,enabled);emit AgentPolicySet(agent,perPayment,dailyLimit,validUntil,enabled);}
    function setMerchant(address agent,address merchant,bool allowed) external onlyOwner {if(agent==address(0)||merchant==address(0))revert Invalid();merchantAllowed[agent][merchant]=allowed;emit MerchantPermission(agent,merchant,allowed);}
    function payInvoice(bytes32 invoiceId,address payable merchant,uint256 amount,uint64 invoiceExpiry,bytes32 memoHash) external lock {
        Policy storage policy=policies[msg.sender];if(!policy.enabled)revert AgentOnly();if(block.timestamp>policy.validUntil)revert Expired();if(!merchantAllowed[msg.sender][merchant])revert MerchantDenied();if(amount==0||amount>policy.perPayment||amount>address(this).balance)revert Limit();uint32 day=uint32(block.timestamp/1 days);if(policy.spendDay!=day){policy.spendDay=day;policy.spentToday=0;}uint256 next=uint256(policy.spentToday)+amount;if(next>policy.dailyLimit)revert Limit();policy.spentToday=uint128(next);arcPay.pay{value:amount}(invoiceId,merchant,amount,invoiceExpiry,address(this),memoHash);emit AgentInvoicePaid(msg.sender,invoiceId,merchant,amount,next);
    }
    function withdraw(address payable to,uint256 amount) external onlyOwner lock {if(to==address(0)||amount==0||amount>address(this).balance)revert Invalid();(bool ok,)=to.call{value:amount}("");if(!ok)revert TransferFailed();emit Withdrawn(to,amount);}
}

// src/ArcAgentPayFactory.sol

/// @notice Permissionless factory creating one isolated Agent Pay vault per owner.
contract ArcAgentPayFactory {
    IArcPayAgent public immutable arcPay;
    mapping(address => address) public vaultOf;
    address[] public allVaults;

    error Invalid();
    error VaultExists();
    event VaultCreated(address indexed owner, address indexed vault, uint256 initialFunding);

    constructor(IArcPayAgent arcPay_) {
        if (address(arcPay_) == address(0)) revert Invalid();
        arcPay = arcPay_;
    }

    function createVault() external payable returns (address vault) {
        if (vaultOf[msg.sender] != address(0)) revert VaultExists();
        ArcAgentPay created = new ArcAgentPay(msg.sender, arcPay);
        vault = address(created);
        vaultOf[msg.sender] = vault;
        allVaults.push(vault);
        if (msg.value != 0) {
            (bool ok,) = payable(vault).call{value: msg.value}("");
            if (!ok) revert Invalid();
        }
        emit VaultCreated(msg.sender, vault, msg.value);
    }

    function vaultCount() external view returns (uint256) { return allVaults.length; }
}

