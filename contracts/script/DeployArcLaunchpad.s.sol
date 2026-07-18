// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcLaunchpadFactory} from "../src/ArcLaunchpad.sol";

contract DeployArcLaunchpad is Script {
    function run() external returns (ArcLaunchpadFactory factory) {
        vm.startBroadcast();
        factory = new ArcLaunchpadFactory();
        vm.stopBroadcast();
    }
}
