// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {IERC20} from "../src/ArcFxPool.sol";
import {ArcCrossBuyRouter, IArcFxPool} from "../src/ArcCrossBuyRouter.sol";

contract DeployCrossBuyRouter is Script {
    function run() external {
        address fxPool = vm.envAddress("FX_POOL");
        address usdc = vm.envAddress("USDC");
        address eurc = vm.envAddress("EURC");
        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        ArcCrossBuyRouter router = new ArcCrossBuyRouter(IArcFxPool(fxPool), IERC20(usdc), IERC20(eurc));
        vm.stopBroadcast();
        console2.log("ArcCrossBuyRouter", address(router));
    }
}
