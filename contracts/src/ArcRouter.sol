// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./ArcFxPool.sol";
import {ArcPair} from "./ArcPair.sol";
import {ArcPairFactory} from "./ArcPairFactory.sol";

/// @notice Stateless convenience layer for multi-hop swaps across ArcPair
/// markets. Holds no funds between transactions and has no privileges — a user
/// can always trade directly against a pair instead.
///
/// Route selection happens off-chain; the caller supplies the path. Slippage is
/// checked once, on the final output, as in ArcCrossBuyRouter: intermediate hops
/// are not user-visible value, and the end-to-end bound constrains the route.
contract ArcRouter {
    ArcPairFactory public immutable factory;
    /// @dev Only the volatile tier is routed through for now. Stable-tier pairs
    /// are traded directly until the UI can pick the deeper of the two tiers —
    /// routing to the wrong tier would silently give users a worse price.
    uint16 public constant ROUTE_TIER = 30;

    bool private locked;

    modifier nonReentrant() {
        require(!locked, "REENTRANCY");
        locked = true;
        _;
        locked = false;
    }

    constructor(ArcPairFactory factory_) {
        require(address(factory_) != address(0), "ZERO_FACTORY");
        factory = factory_;
    }

    function swapExactTokensForTokens(address[] calldata path, uint256 amountIn, uint256 minOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        require(path.length >= 2, "BAD_PATH");
        require(amountIn > 0, "ZERO_IN");

        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "TOKEN_IN");

        amountOut = amountIn;
        for (uint256 i = 0; i + 1 < path.length; i++) {
            address pairAddress = factory.getPair(path[i], path[i + 1], ROUTE_TIER);
            require(pairAddress != address(0), "NO_PAIR");
            ArcPair pair = ArcPair(pairAddress);

            require(IERC20(path[i]).approve(pairAddress, amountOut), "APPROVE");
            bool zeroForOne = path[i] < path[i + 1];
            // Intermediate hops pass minOut = 0; the final bound below covers the route.
            amountOut = pair.swap(zeroForOne, amountOut, 0, deadline);
        }

        require(amountOut >= minOut, "SLIPPAGE");
        require(IERC20(path[path.length - 1]).transfer(msg.sender, amountOut), "TOKEN_OUT");
    }
}
