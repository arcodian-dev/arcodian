// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcAgentPayFactoryV5} from "../src/ArcAgentPayFactoryV5.sol";
import {IArcPayAgentV5,IAgentPassportV5} from "../src/ArcAgentPayV5.sol";

contract DeployArcAgentPayFactoryV5 is Script {
    function run() external returns (ArcAgentPayFactoryV5 factory) {
        uint256 key=vm.envUint("PRIVATE_KEY");
        address arcPay=vm.envAddress("ARC_PAY_ADDRESS");
        address passport=vm.envAddress("AGENT_PASSPORT_ADDRESS");
        vm.startBroadcast(key);
        factory=new ArcAgentPayFactoryV5(IArcPayAgentV5(arcPay),IAgentPassportV5(passport));
        vm.stopBroadcast();
    }
}
