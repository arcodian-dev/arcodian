// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract MockPassport {
    mapping(address => uint256) public agentIdOf;
    function setAgent(address wallet, uint256 agentId) external { agentIdOf[wallet] = agentId; }
}
