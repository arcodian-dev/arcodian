// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPay} from "../src/ArcPay.sol";

contract DeployArcPay is Script {
    function run() external returns (ArcPay deployed) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address payable treasury = payable(vm.envAddress("ARC_PAY_TREASURY"));
        vm.startBroadcast(deployerKey);
        deployed = new ArcPay(treasury);
        vm.stopBroadcast();
    }
}

