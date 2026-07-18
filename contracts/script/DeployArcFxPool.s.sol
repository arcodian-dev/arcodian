// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcFxPool, IERC20} from "../src/ArcFxPool.sol";

contract DeployArcFxPool is Script {
    function run(address usdc, address eurc) external returns (ArcFxPool pool) {
        require(usdc != address(0) && eurc != address(0), "ZERO_ADDRESS");
        vm.startBroadcast();
        pool = new ArcFxPool(IERC20(usdc), IERC20(eurc));
        vm.stopBroadcast();
        require(address(pool.usdc()) == usdc && address(pool.eurc()) == eurc, "BAD_WIRING");
    }
}
