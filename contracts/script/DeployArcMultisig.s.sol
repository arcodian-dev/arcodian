// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcMultisig} from "../src/ArcGovernance.sol";

contract DeployArcMultisig is Script {
    function run() external returns (ArcMultisig ms) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address signer1 = vm.envAddress("MULTISIG_SIGNER_1");
        address signer2 = vm.envAddress("MULTISIG_SIGNER_2");
        address signer3 = vm.envAddress("MULTISIG_SIGNER_3");
        uint256 threshold = vm.envOr("MULTISIG_THRESHOLD", uint256(2));
        address[] memory owners = new address[](3);
        owners[0] = signer1;
        owners[1] = signer2;
        owners[2] = signer3;
        vm.startBroadcast(key);
        ms = new ArcMultisig(owners, threshold);
        vm.stopBroadcast();
    }
}
