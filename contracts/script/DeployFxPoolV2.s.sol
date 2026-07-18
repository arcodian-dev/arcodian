// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {IERC20} from "../src/ArcFxPool.sol";
import {ArcFxPoolV2} from "../src/ArcFxPoolV2.sol";

contract DeployFxPoolV2 is Script {
    function run() external {
        address usdc = vm.envAddress("USDC");
        address eurc = vm.envAddress("EURC");
        address treasury = vm.envAddress("TREASURY");
        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        ArcFxPoolV2 pool = new ArcFxPoolV2(IERC20(usdc), IERC20(eurc), treasury);
        vm.stopBroadcast();
        console2.log("ArcFxPoolV2", address(pool));
    }
}
