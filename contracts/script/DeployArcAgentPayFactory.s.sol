// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcAgentPayFactory} from "../src/ArcAgentPayFactory.sol";
import {IArcPayAgent} from "../src/ArcAgentPay.sol";
contract DeployArcAgentPayFactory is Script {function run() external returns(ArcAgentPayFactory factory){uint256 key=vm.envUint("PRIVATE_KEY");address arcPay=vm.envAddress("ARC_PAY_ADDRESS");vm.startBroadcast(key);factory=new ArcAgentPayFactory(IArcPayAgent(arcPay));vm.stopBroadcast();}}
