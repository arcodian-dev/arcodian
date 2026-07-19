// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPairFactoryV2} from "../src/ArcPairFactoryV2.sol";
import {ArcPumpFactoryV8} from "../src/ArcPumpV8.sol";
import {ArcRouter} from "../src/ArcRouter.sol";
import {ArcPairFactory} from "../src/ArcPairFactory.sol";

/// Deploys the reserved-pair factory, the V8 pump factory, and a router bound
/// to the new factory, then seals the graduation authority.
///
/// Sealing happens here, in the same broadcast, on purpose: between deployment
/// and sealing the factory is permissionless, so a launch created in that gap
/// would have an unreserved pair. Doing it as a separate manual step invites
/// exactly that window.
contract DeployGraduationV8 is Script {
    function run() external {
        address payable treasury = payable(vm.envAddress("TREASURY"));
        uint256 threshold = vm.envUint("GRADUATION_THRESHOLD");

        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));

        ArcPairFactoryV2 pairFactory = new ArcPairFactoryV2(treasury);
        ArcPumpFactoryV8 pumpFactory = new ArcPumpFactoryV8(pairFactory, treasury, threshold);
        pairFactory.setGraduationAuthority(address(pumpFactory));
        // ArcRouter types its factory as V1, but only calls getPair, whose
        // signature is identical in V2. The cast is safe for that reason and
        // no other — if the router ever calls createPair it must be retyped.
        ArcRouter router = new ArcRouter(ArcPairFactory(address(pairFactory)));

        vm.stopBroadcast();

        console2.log("ArcPairFactoryV2 ", address(pairFactory));
        console2.log("ArcPumpFactoryV8 ", address(pumpFactory));
        console2.log("ArcRouter        ", address(router));
        console2.log("authority sealed ", pairFactory.graduationAuthority());
    }
}
