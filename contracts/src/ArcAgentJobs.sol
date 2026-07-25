// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArcPayAgent { function pay(bytes32 invoiceId,address payable merchant,uint256 amount,uint64 expiresAt,address expectedPayer,bytes32 memoHash) external payable; }

/// @notice Shared, permissionless, multi-tenant job escrow. Any wallet may create and
/// fund a job (becoming its client); a named provider delivers; a named evaluator
/// approves (settle to provider via ArcPay, 0.3% fee) or rejects (refund client).
/// Unfunded state is elided: createJob funds atomically. Jobs are registry entries
/// keyed by jobId, not NFTs; providerAgentId optionally binds an ERC-8004 identity.
contract ArcAgentJobs {
    enum Status { None, Funded, Submitted, Completed, Rejected, Expired }
    struct Job {
        address client;
        address provider;
        address evaluator;
        uint128 budget;
        uint64  expiry;
        Status  status;
        bytes32 descHash;
        bytes32 deliverableHash;
        uint256 providerAgentId;
    }
    uint64 public constant MAX_EXPIRY = 90 days;
    uint64 public constant SETTLE_WINDOW = 1 days; // <= ArcPay MAX_EXPIRY_WINDOW (30 days)
    IArcPayAgent public immutable arcPay;
    mapping(uint256 => Job) public jobs;
    uint256 public jobCount;
    uint256 private unlocked = 1;

    error NotClient(); error NotProvider(); error NotEvaluator(); error BadState();
    error Expired(); error NotYetExpired(); error Invalid(); error Reentrancy(); error TransferFailed();

    event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 budget,uint64 expiry,bytes32 descHash,uint256 providerAgentId);
    event JobSubmitted(uint256 indexed jobId,bytes32 deliverableHash);
    event JobCompleted(uint256 indexed jobId,address indexed provider,uint256 budget,uint256 providerAgentId,bytes32 evidenceHash);
    event JobRejected(uint256 indexed jobId,address indexed client,uint256 budget,bytes32 evidenceHash);
    event JobExpired(uint256 indexed jobId,address indexed client,uint256 budget);

    modifier lock(){if(unlocked!=1)revert Reentrancy();unlocked=2;_;unlocked=1;}
    constructor(IArcPayAgent arcPay_){if(address(arcPay_)==address(0))revert Invalid();arcPay=arcPay_;}
}
