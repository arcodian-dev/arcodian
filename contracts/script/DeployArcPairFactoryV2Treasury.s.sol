// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcPairFactoryV2} from "../src/ArcPairFactoryV2.sol";

/// @notice Re-deploy of ArcPairFactoryV2 with the correct treasury address.
/// Same root cause as DeployArcPumpFactoryV9Treasury: the original mainnet
/// factory (0xadb7d3d229F78198c4dE827607c89F95E9cE7722) was constructed with
/// the deployer EOA instead of the treasury multisig. allPairsLength() == 0
/// on the old factory (nobody has used the "Create pool" flow yet), so this
/// is a clean swap with no pairs to migrate. graduationAuthority is left
/// unset (V8 curve graduation is retired; "Create pool" is a standalone
/// permissionless pair-creation feature unrelated to curve graduation).
contract DeployArcPairFactoryV2Treasury is Script {
    function run() external returns (ArcPairFactoryV2 factory) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY");
        vm.startBroadcast(key);
        factory = new ArcPairFactoryV2(treasury);
        vm.stopBroadcast();
    }
}
