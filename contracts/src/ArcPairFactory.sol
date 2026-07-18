// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./ArcFxPool.sol";
import {ArcPair} from "./ArcPair.sol";

/// @notice Deploys and registers ArcPair markets. Permissionless: anyone may
/// create a pair for any two tokens at either fee tier.
///
/// No owner. The treasury is immutable and passed to every pair created, so a
/// deployed pair can never be repointed or reconfigured.
contract ArcPairFactory {
    address public immutable treasury;

    /// @dev token0 => token1 => feeBps => pair. Tokens are stored ordered, so a
    /// couple resolves to the same entry regardless of argument order.
    mapping(address => mapping(address => mapping(uint16 => address))) private pairs;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, uint16 feeBps, address pair);

    constructor(address treasury_) {
        require(treasury_ != address(0), "ZERO_TREASURY");
        treasury = treasury_;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function getPair(address tokenA, address tokenB, uint16 feeBps) public view returns (address) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return pairs[t0][t1][feeBps];
    }

    function createPair(address tokenA, address tokenB, uint16 feeBps) external returns (address pair) {
        require(tokenA != tokenB, "IDENTICAL");
        require(tokenA != address(0) && tokenB != address(0), "ZERO_ADDRESS");
        require(feeBps == 10 || feeBps == 30, "BAD_FEE_TIER");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(pairs[t0][t1][feeBps] == address(0), "PAIR_EXISTS");

        pair = address(new ArcPair(IERC20(t0), IERC20(t1), feeBps, treasury));
        pairs[t0][t1][feeBps] = pair;
        allPairs.push(pair);

        emit PairCreated(t0, t1, feeBps, pair);
    }
}
