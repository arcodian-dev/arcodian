// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcAgentPayFactoryV6} from "../src/ArcAgentPayFactoryV6.sol";
import {IArcPayAgentV6,IAgentPassportV6} from "../src/ArcAgentPayV6.sol";

contract DeployArcAgentPayFactoryV6 is Script {
    function run() external returns (ArcAgentPayFactoryV6 factory) {
        uint256 key=vm.envUint("PRIVATE_KEY"); address arcPay=vm.envAddress("ARC_PAY_ADDRESS"); address passport=vm.envAddress("AGENT_PASSPORT_ADDRESS");
        vm.startBroadcast(key); factory=new ArcAgentPayFactoryV6(IArcPayAgentV6(arcPay),IAgentPassportV6(passport)); vm.stopBroadcast();
    }
}
