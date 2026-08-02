// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// src/ArcSessionKeyAccount.sol

/// @title ArcSessionKeyAccount — Phase F4 session-key executor spike (Arc Testnet).
/// @notice A self-custodied smart account whose owner installs scoped session-key
/// capabilities. A session key executes autonomously (signs its own tx, no owner
/// signature per call); the account enforces capability (target + function
/// selector), amount (per-call + rolling daily), time window, and revocation
/// on-chain AT EXECUTION TIME. The owner keeps ultimate custody via withdraw and
/// can revoke instantly. Spike only — not ERC-4337, not audited, not for mainnet.
contract ArcSessionKeyAccount {
    // Packed capability keyed by session-key address.
    struct Capability {
        address target;     // only contract this key may call
        bytes4 selector;    // only function it may invoke
        uint128 perCallCap; // max value per execute
        uint128 dailyCap;   // rolling per-UTC-day value cap
        uint128 spentToday;
        uint64 validAfter;
        uint64 validUntil;
        uint32 spendDay;
        uint256 agentId;    // Passport attribution (0 = unbound); not custody
        bool enabled;
        bool revoked;
    }

    address public immutable owner;
    mapping(address => Capability) public capabilities;
    uint256 private unlocked = 1;

    event KeyInstalled(address indexed key, address indexed target, bytes4 selector, uint128 perCallCap, uint128 dailyCap, uint64 validAfter, uint64 validUntil, uint256 agentId);
    event KeyRevoked(address indexed key);
    event SessionExecuted(address indexed key, address indexed target, bytes4 selector, uint256 value, uint256 spentToday, uint256 agentId);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error OwnerOnly();
    error Invalid();
    error NotAuthorized();
    error NotYetValid();
    error Expired();
    error TargetDenied();
    error SelectorDenied();
    error Limit();
    error CallFailed();
    error TransferFailed();
    error Reentrancy();

    modifier onlyOwner() { if (msg.sender != owner) revert OwnerOnly(); _; }
    modifier lock() { if (unlocked != 1) revert Reentrancy(); unlocked = 2; _; unlocked = 1; }

    constructor(address owner_) { if (owner_ == address(0)) revert Invalid(); owner = owner_; }

    receive() external payable { emit Funded(msg.sender, msg.value); }

    /// @notice Owner installs or replaces a scoped capability for a session key.
    function installKey(
        address key,
        address target,
        bytes4 selector,
        uint128 perCallCap,
        uint128 dailyCap,
        uint64 validAfter,
        uint64 validUntil,
        uint256 agentId
    ) external onlyOwner {
        if (key == address(0) || target == address(0)) revert Invalid();
        if (perCallCap == 0 || dailyCap < perCallCap) revert Invalid();
        if (validUntil <= block.timestamp || validAfter >= validUntil) revert Invalid();
        capabilities[key] = Capability({
            target: target,
            selector: selector,
            perCallCap: perCallCap,
            dailyCap: dailyCap,
            spentToday: 0,
            validAfter: validAfter,
            validUntil: validUntil,
            spendDay: 0,
            agentId: agentId,
            enabled: true,
            revoked: false
        });
        emit KeyInstalled(key, target, selector, perCallCap, dailyCap, validAfter, validUntil, agentId);
    }

    /// @notice Owner revokes a session key instantly. Enforced on the next execute.
    function revokeKey(address key) external onlyOwner {
        Capability storage c = capabilities[key];
        c.revoked = true;
        c.enabled = false;
        emit KeyRevoked(key);
    }

    /// @notice Session key executes a bounded call. All checks fail closed.
    function execute(address target, uint256 value, bytes calldata data) external lock returns (bytes memory) {
        Capability storage c = capabilities[msg.sender];
        if (!c.enabled || c.revoked) revert NotAuthorized();
        if (block.timestamp < c.validAfter) revert NotYetValid();
        if (block.timestamp > c.validUntil) revert Expired();
        if (target != c.target) revert TargetDenied();
        if (data.length < 4 || bytes4(data[:4]) != c.selector) revert SelectorDenied();
        if (value == 0 || value > c.perCallCap || value > address(this).balance) revert Limit();

        uint32 day = uint32(block.timestamp / 1 days);
        if (c.spendDay != day) { c.spendDay = day; c.spentToday = 0; }
        uint256 next = uint256(c.spentToday) + value;
        if (next > c.dailyCap) revert Limit();
        c.spentToday = uint128(next);

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed();
        emit SessionExecuted(msg.sender, target, c.selector, value, next, c.agentId);
        return ret;
    }

    /// @notice Owner retains ultimate custody.
    function withdraw(address payable to, uint256 amount) external onlyOwner lock {
        if (to == address(0) || amount == 0 || amount > address(this).balance) revert Invalid();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }
}

