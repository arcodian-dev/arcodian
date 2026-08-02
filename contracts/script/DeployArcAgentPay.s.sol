// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";import {ArcAgentPay,IArcPayAgent} from "../src/ArcAgentPay.sol";
contract DeployArcAgentPay is Script {function run() external returns(ArcAgentPay wallet){uint256 key=vm.envUint("PRIVATE_KEY");address owner=vm.envAddress("AGENT_PAY_OWNER");address arcPay=vm.envAddress("ARC_PAY_ADDRESS");vm.startBroadcast(key);wallet=new ArcAgentPay(owner,IArcPayAgent(arcPay));vm.stopBroadcast();}}
