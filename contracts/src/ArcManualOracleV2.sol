// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArcPriceOracle} from "./ArcLend.sol";

/// @notice Bounded fallback oracle. Not the live path today (ArcLendV2 uses
/// the real ArcPythOracle) — this exists only so a future reactivation isn't
/// stuck with ArcManualOracle's original zero-check design: a single admin
/// key could previously push ANY nonzero price in one call, with no bound on
/// how far it could move in a single update. A compromised (or fat-fingered)
/// keeper key meant unbounded, instant price manipulation — engineered
/// liquidations or bad debt with no circuit breaker at all, unlike
/// ArcPythOracle's confidence check or ArcLendV2.syncOracle's 20% deviation
/// gate (both of which only ever see whatever THIS oracle reports, so they
/// can't protect against a bad report at the source).
///
/// This version caps how far a single setPrice() call may move the price
/// (maxMoveBps, WAD-relative to the current value) and rejects zero/absurd
/// inputs. It does not, and cannot, replace a real decentralized feed — it
/// only bounds the blast radius of a single compromised or mistaken key.
contract ArcManualOracleV2 is IArcPriceOracle {
    uint256 constant BPS = 10_000;
    uint256 public constant MIN_MOVE_BPS_BOUND = 100; // 1% floor: a cap this tight is unusable
    uint256 public constant MAX_MOVE_BPS_BOUND = 5_000; // 50% ceiling: anything looser isn't a real bound

    address public immutable admin;
    uint256 public immutable maxMoveBps;
    uint256 public value;
    uint64 public updatedAt;

    error Invalid();
    error Unauthorized();
    error MoveTooLarge();

    event PriceUpdated(uint256 oldValue, uint256 newValue, uint64 updatedAt);

    constructor(address admin_, uint256 initialPrice, uint256 maxMoveBps_) {
        if (admin_ == address(0) || initialPrice == 0) revert Invalid();
        if (maxMoveBps_ < MIN_MOVE_BPS_BOUND || maxMoveBps_ > MAX_MOVE_BPS_BOUND) revert Invalid();
        admin = admin_;
        maxMoveBps = maxMoveBps_;
        value = initialPrice;
        updatedAt = uint64(block.timestamp);
    }

    function setPrice(uint256 next) external {
        if (msg.sender != admin) revert Unauthorized();
        if (next == 0) revert Invalid();
        uint256 current = value;
        uint256 delta = next > current ? next - current : current - next;
        if (delta * BPS > current * maxMoveBps) revert MoveTooLarge();
        uint256 old = current;
        value = next;
        updatedAt = uint64(block.timestamp);
        emit PriceUpdated(old, next, updatedAt);
    }

    function price() external view returns (uint256, uint64) {
        return (value, updatedAt);
    }
}
