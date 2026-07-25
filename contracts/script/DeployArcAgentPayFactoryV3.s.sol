// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcAgentPayFactoryV3} from "../src/ArcAgentPayFactoryV3.sol";
import {IArcPayAgent,IAgentPassport} from "../src/ArcAgentPayV3.sol";
contract DeployArcAgentPayFactoryV3 is Script {function run() external returns(ArcAgentPayFactoryV3 f){uint256 key=vm.envUint("PRIVATE_KEY");address arcPay=vm.envAddress("ARC_PAY_ADDRESS");address passport=vm.envAddress("AGENT_PASSPORT_ADDRESS");vm.startBroadcast(key);f=new ArcAgentPayFactoryV3(IArcPayAgent(arcPay),IAgentPassport(passport));vm.stopBroadcast();}}
