// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {
    ArcAgentJobsV2,
    IArcPayJobsV2,
    IAgentPassportJobsV2
} from "../src/ArcAgentJobsV2.sol";

contract DeployArcAgentJobsV2 is Script {
    function run() external returns (ArcAgentJobsV2 jobs) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address arcPay = vm.envAddress("ARC_PAY_ADDRESS");
        address passport = vm.envAddress("AGENT_PASSPORT_ADDRESS");
        vm.startBroadcast(key);
        jobs = new ArcAgentJobsV2(
            IArcPayJobsV2(arcPay),
            IAgentPassportJobsV2(passport)
        );
        vm.stopBroadcast();
    }
}
