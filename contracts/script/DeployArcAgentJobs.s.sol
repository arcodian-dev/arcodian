// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcAgentJobs,IArcPayAgent} from "../src/ArcAgentJobs.sol";
contract DeployArcAgentJobs is Script {
    function run() external returns(ArcAgentJobs j){
        uint256 key=vm.envUint("PRIVATE_KEY");
        address arcPay=vm.envAddress("ARC_PAY_ADDRESS");
        vm.startBroadcast(key);
        j=new ArcAgentJobs(IArcPayAgent(arcPay));
        vm.stopBroadcast();
    }
}
