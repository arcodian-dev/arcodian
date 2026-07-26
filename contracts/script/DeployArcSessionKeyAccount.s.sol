// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcSessionKeyAccount} from "../src/ArcSessionKeyAccount.sol";

contract DeployArcSessionKeyAccount is Script {
    function run() external returns (ArcSessionKeyAccount acct) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(key);
        vm.startBroadcast(key);
        acct = new ArcSessionKeyAccount(owner);
        vm.stopBroadcast();
    }
}
