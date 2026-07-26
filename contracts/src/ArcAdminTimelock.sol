// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArcAdminTimelock — Phase F5 governed-administration spike (Arc Testnet).
/// @notice A minimal role-gated timelock controller. Proposers schedule an
/// operation; it can only be executed by an executor after an enforced delay;
/// pending operations can be cancelled. The controller's own `minDelay` can only
/// be changed through a delayed, self-governed operation. Intended for a
/// production deployment whose proposer/executor sets are a multisig — the spike
/// uses an EOA to prove the mechanics. Not audited, not for mainnet.
contract ArcAdminTimelock {
    uint256 internal constant _DONE = 1;

    uint256 public minDelay;
    address public admin;
    mapping(bytes32 => uint256) public timestamps; // op id => 0 unset, 1 done, else eta
    mapping(address => bool) public isProposer;
    mapping(address => bool) public isExecutor;

    event OperationScheduled(bytes32 indexed id, address indexed target, uint256 value, bytes data, bytes32 predecessor, uint256 eta);
    event OperationExecuted(bytes32 indexed id, address indexed target, uint256 value, bytes data);
    event OperationCancelled(bytes32 indexed id);
    event MinDelayChanged(uint256 oldDelay, uint256 newDelay);
    event ProposerSet(address indexed account, bool enabled);
    event ExecutorSet(address indexed account, bool enabled);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);

    error NotAdmin();
    error NotProposer();
    error NotExecutor();
    error NotSelf();
    error BadDelay();
    error ZeroTarget();
    error AlreadyScheduled();
    error NotScheduled();
    error NotReady();
    error PredecessorNotDone();
    error CallReverted();
    error Invalid();

    modifier onlyAdmin() { if (msg.sender != admin) revert NotAdmin(); _; }
    modifier onlyProposer() { if (!isProposer[msg.sender]) revert NotProposer(); _; }
    modifier onlyExecutor() { if (!isExecutor[msg.sender]) revert NotExecutor(); _; }
    modifier onlySelf() { if (msg.sender != address(this)) revert NotSelf(); _; }

    constructor(uint256 minDelay_, address admin_, address[] memory proposers, address[] memory executors) {
        if (admin_ == address(0)) revert Invalid();
        minDelay = minDelay_;
        admin = admin_;
        emit AdminChanged(address(0), admin_);
        emit MinDelayChanged(0, minDelay_);
        for (uint256 i = 0; i < proposers.length; i++) { isProposer[proposers[i]] = true; emit ProposerSet(proposers[i], true); }
        for (uint256 i = 0; i < executors.length; i++) { isExecutor[executors[i]] = true; emit ExecutorSet(executors[i], true); }
    }

    receive() external payable {}

    function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, predecessor, salt));
    }

    /// @notice Operation state: 0 Unset, 1 Waiting, 2 Ready, 3 Done.
    function state(bytes32 id) public view returns (uint8) {
        uint256 t = timestamps[id];
        if (t == 0) return 0;
        if (t == _DONE) return 3;
        if (block.timestamp >= t) return 2;
        return 1;
    }

    function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay) external onlyProposer {
        if (target == address(0)) revert ZeroTarget();
        if (delay < minDelay) revert BadDelay();
        bytes32 id = hashOperation(target, value, data, predecessor, salt);
        if (timestamps[id] != 0) revert AlreadyScheduled();
        uint256 eta = block.timestamp + delay;
        timestamps[id] = eta;
        emit OperationScheduled(id, target, value, data, predecessor, eta);
    }

    function cancel(bytes32 id) external onlyProposer {
        if (timestamps[id] <= _DONE) revert NotScheduled();
        delete timestamps[id];
        emit OperationCancelled(id);
    }

    function execute(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) external payable onlyExecutor {
        bytes32 id = hashOperation(target, value, data, predecessor, salt);
        uint256 eta = timestamps[id];
        if (eta == 0 || eta == _DONE) revert NotScheduled();
        if (block.timestamp < eta) revert NotReady();
        if (predecessor != bytes32(0) && timestamps[predecessor] != _DONE) revert PredecessorNotDone();
        timestamps[id] = _DONE;
        (bool ok, ) = target.call{value: value}(data);
        if (!ok) revert CallReverted();
        emit OperationExecuted(id, target, value, data);
    }

    // ---- governed / admin controls ----

    /// @notice minDelay changes only through a delayed, self-governed operation.
    function updateDelay(uint256 newDelay) external onlySelf {
        emit MinDelayChanged(minDelay, newDelay);
        minDelay = newDelay;
    }

    function setProposer(address account, bool enabled) external onlyAdmin { if (account == address(0)) revert Invalid(); isProposer[account] = enabled; emit ProposerSet(account, enabled); }
    function setExecutor(address account, bool enabled) external onlyAdmin { if (account == address(0)) revert Invalid(); isExecutor[account] = enabled; emit ExecutorSet(account, enabled); }

    /// @notice Hand administration to the multisig, or renounce to address(0).
    function transferAdmin(address newAdmin) external onlyAdmin { emit AdminChanged(admin, newAdmin); admin = newAdmin; }
}
