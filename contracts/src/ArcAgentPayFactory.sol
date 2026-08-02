// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArcAgentPay, IArcPayAgent} from "./ArcAgentPay.sol";

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
