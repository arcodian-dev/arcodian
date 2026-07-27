// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArcPayJobsV2 {
    function pay(
        bytes32 invoiceId,
        address payable merchant,
        uint256 amount,
        uint64 expiresAt,
        address expectedPayer,
        bytes32 memoHash
    ) external payable;
}

interface IAgentPassportJobsV2 {
    function walletOf(uint256 agentId) external view returns (address);
}

/// @notice Identity-enforced successor to ArcAgentJobs. A non-zero
/// providerAgentId is accepted only when the named provider is the wallet
/// currently bound to that ERC-8004 identity in ArcAgentPassport.
contract ArcAgentJobsV2 {
    enum Status {
        None,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        address client;
        address provider;
        address evaluator;
        uint128 budget;
        uint64 expiry;
        Status status;
        bytes32 descHash;
        bytes32 deliverableHash;
        uint256 providerAgentId;
    }

    uint64 public constant MAX_EXPIRY = 90 days;
    uint64 public constant SETTLE_WINDOW = 1 days;
    IArcPayJobsV2 public immutable arcPay;
    IAgentPassportJobsV2 public immutable passport;
    mapping(uint256 => Job) public jobs;
    uint256 public jobCount;
    uint256 private unlocked = 1;

    error NotProvider();
    error NotEvaluator();
    error BadState();
    error Expired();
    error NotYetExpired();
    error Invalid();
    error IdentityMismatch();
    error Reentrancy();
    error TransferFailed();
    error SelfDealing();

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 budget,
        uint64 expiry,
        bytes32 descHash,
        uint256 providerAgentId
    );
    event JobSubmitted(uint256 indexed jobId, bytes32 deliverableHash);
    event JobCompleted(
        uint256 indexed jobId,
        address indexed provider,
        uint256 budget,
        uint256 providerAgentId,
        bytes32 evidenceHash
    );
    event JobRejected(
        uint256 indexed jobId,
        address indexed client,
        uint256 budget,
        bytes32 evidenceHash
    );
    event JobExpired(uint256 indexed jobId, address indexed client, uint256 budget);

    modifier lock() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(IArcPayJobsV2 arcPay_, IAgentPassportJobsV2 passport_) {
        if (address(arcPay_) == address(0) || address(passport_) == address(0)) {
            revert Invalid();
        }
        arcPay = arcPay_;
        passport = passport_;
    }

    function createJob(
        address provider,
        address evaluator,
        uint64 expiry,
        bytes32 descHash,
        uint256 providerAgentId
    ) external payable returns (uint256 jobId) {
        if (provider == address(0) || evaluator == address(0)) revert Invalid();
        if (msg.value == 0 || msg.value > type(uint128).max) revert Invalid();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_EXPIRY) {
            revert Invalid();
        }
        // The escrow's entire fairness guarantee is a neutral evaluator: the
        // client can't unilaterally reject a legitimate delivery, and the
        // provider can't self-approve their own work. Naming either party as
        // evaluator defeats that purpose, so it's rejected at creation rather
        // than left as a silent trap only visible after the fact.
        if (evaluator == msg.sender || evaluator == provider) revert SelfDealing();
        if (providerAgentId != 0 && passport.walletOf(providerAgentId) != provider) {
            revert IdentityMismatch();
        }

        jobId = ++jobCount;
        jobs[jobId] = Job(
            msg.sender,
            provider,
            evaluator,
            uint128(msg.value),
            expiry,
            Status.Funded,
            descHash,
            bytes32(0),
            providerAgentId
        );
        emit JobCreated(
            jobId,
            msg.sender,
            provider,
            evaluator,
            msg.value,
            expiry,
            descHash,
            providerAgentId
        );
    }

    function submit(uint256 jobId, bytes32 deliverableHash) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != Status.Funded) revert BadState();
        if (block.timestamp > job.expiry) revert Expired();
        job.deliverableHash = deliverableHash;
        job.status = Status.Submitted;
        emit JobSubmitted(jobId, deliverableHash);
    }

    function evaluate(uint256 jobId, bool approve, bytes32 evidenceHash) external lock {
        Job storage job = jobs[jobId];
        if (msg.sender != job.evaluator) revert NotEvaluator();
        if (job.status != Status.Submitted) revert BadState();
        uint256 budget = job.budget;
        if (approve) {
            job.status = Status.Completed;
            bytes32 invoiceId = keccak256(abi.encodePacked("arcjob-v2", jobId));
            arcPay.pay{value: budget}(
                invoiceId,
                payable(job.provider),
                budget,
                uint64(block.timestamp + SETTLE_WINDOW),
                address(this),
                evidenceHash
            );
            emit JobCompleted(
                jobId,
                job.provider,
                budget,
                job.providerAgentId,
                evidenceHash
            );
        } else {
            job.status = Status.Rejected;
            (bool ok,) = job.client.call{value: budget}("");
            if (!ok) revert TransferFailed();
            emit JobRejected(jobId, job.client, budget, evidenceHash);
        }
    }

    function reclaimExpired(uint256 jobId) external lock {
        Job storage job = jobs[jobId];
        if (job.status != Status.Funded && job.status != Status.Submitted) {
            revert BadState();
        }
        if (block.timestamp <= job.expiry) revert NotYetExpired();
        uint256 budget = job.budget;
        job.status = Status.Expired;
        (bool ok,) = job.client.call{value: budget}("");
        if (!ok) revert TransferFailed();
        emit JobExpired(jobId, job.client, budget);
    }
}
