// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcBridgeRouter} from "../src/ArcBridgeRouter.sol";

contract DeployArcBridgeRouter is Script {
    function run() external returns (ArcBridgeRouter router) {
        address usdc = vm.envAddress("USDC");
        address tokenMessenger = vm.envAddress("TOKEN_MESSENGER");
        address treasury = vm.envAddress("TREASURY");

        vm.startBroadcast();
        router = new ArcBridgeRouter(usdc, tokenMessenger, treasury);
        vm.stopBroadcast();
    }
}
