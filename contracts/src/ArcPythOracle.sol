// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArcPriceOracle} from "./ArcLend.sol";

interface IPythArc {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}

/// @notice Read-only EUR/USD adapter for the official Pyth deployment on Arc.
/// @dev Freshness is enforced by ArcLend. Confidence is checked here so a wide
///      or malformed report fails closed before it reaches the market.
contract ArcPythOracle is IArcPriceOracle {
    uint256 public constant BPS = 10_000;
    IPythArc public immutable pyth;
    bytes32 public immutable priceId;
    uint256 public immutable maxConfidenceBps;

    error InvalidPrice();
    error ConfidenceTooWide();

    constructor(IPythArc pyth_, bytes32 priceId_, uint256 maxConfidenceBps_) {
        if (address(pyth_) == address(0) || priceId_ == bytes32(0) || maxConfidenceBps_ == 0 || maxConfidenceBps_ > 500)
        {
            revert InvalidPrice();
        }
        pyth = pyth_;
        priceId = priceId_;
        maxConfidenceBps = maxConfidenceBps_;
    }

    function price() external view returns (uint256 value, uint64 updatedAt) {
        IPythArc.Price memory report = pyth.getPriceUnsafe(priceId);
        if (report.price <= 0 || report.publishTime == 0 || report.publishTime > type(uint64).max) {
            revert InvalidPrice();
        }
        uint256 unsignedPrice = uint64(report.price);
        if (uint256(report.conf) * BPS > unsignedPrice * maxConfidenceBps) revert ConfidenceTooWide();

        int256 scale = int256(report.expo) + 18;
        if (scale < 0 || scale > 36) revert InvalidPrice();
        value = unsignedPrice * (10 ** uint256(scale));
        updatedAt = uint64(report.publishTime);
    }
}
