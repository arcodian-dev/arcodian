// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcAgentPayFactoryV4} from "../src/ArcAgentPayFactoryV4.sol";
import {IArcPayAgentV4,IAgentPassportV4} from "../src/ArcAgentPayV4.sol";
contract DeployArcAgentPayFactoryV4 is Script {function run() external returns(ArcAgentPayFactoryV4 f){uint256 key=vm.envUint("PRIVATE_KEY");address arcPay=vm.envAddress("ARC_PAY_ADDRESS");address passport=vm.envAddress("AGENT_PASSPORT_ADDRESS");vm.startBroadcast(key);f=new ArcAgentPayFactoryV4(IArcPayAgentV4(arcPay),IAgentPassportV4(passport));vm.stopBroadcast();}}
