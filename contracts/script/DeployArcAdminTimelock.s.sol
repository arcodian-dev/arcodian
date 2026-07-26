// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcAdminTimelock} from "../src/ArcAdminTimelock.sol";

contract DeployArcAdminTimelock is Script {
    function run() external returns (ArcAdminTimelock tl) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(key);
        uint256 minDelay = vm.envOr("TIMELOCK_MIN_DELAY", uint256(90));
        address[] memory proposers = new address[](1);
        proposers[0] = deployer;
        address[] memory executors = new address[](1);
        executors[0] = deployer;
        vm.startBroadcast(key);
        tl = new ArcAdminTimelock(minDelay, deployer, proposers, executors);
        vm.stopBroadcast();
    }
}
