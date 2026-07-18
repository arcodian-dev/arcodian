// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPairFactory} from "../src/ArcPairFactory.sol";
import {ArcRouter} from "../src/ArcRouter.sol";

contract DeployArcAmm is Script {
    function run() external {
        address treasury = vm.envAddress("TREASURY");
        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        ArcPairFactory factory = new ArcPairFactory(treasury);
        ArcRouter router = new ArcRouter(factory);
        vm.stopBroadcast();
        console2.log("ArcPairFactory", address(factory));
        console2.log("ArcRouter", address(router));
    }
}
