// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcAgentPassport,IIdentityRegistry} from "../src/ArcAgentPassport.sol";
contract DeployArcAgentPassport is Script {function run() external returns(ArcAgentPassport pp){uint256 key=vm.envUint("PRIVATE_KEY");address idreg=vm.envAddress("IDENTITY_REGISTRY_ADDRESS");vm.startBroadcast(key);pp=new ArcAgentPassport(IIdentityRegistry(idreg));vm.stopBroadcast();}}
