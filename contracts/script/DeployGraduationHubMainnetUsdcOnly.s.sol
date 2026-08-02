// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPairFactoryV2} from "../src/ArcPairFactoryV2.sol";
import {ArcGraduationHub} from "../src/ArcGraduationHub.sol";
import {ArcPumpFactoryV8} from "../src/ArcPumpV8.sol";
import {ArcRouter} from "../src/ArcRouter.sol";
import {ArcPairFactory} from "../src/ArcPairFactory.sol";

/// Mainnet USDC-only graduation stack. Circle has not yet published an
/// official mainnet EURC address for Arc chain 5042 (confirmed by probing —
/// the testnet EURC address has no code on mainnet), so the EURC pump
/// factory is deliberately left out of hub membership this round. The hub is
/// sealed with exactly one member (USDC), same one-shot pattern as
/// DeployGraduationHub.s.sol. Adding EURC later requires a full stack
/// redeploy (hub membership is permanent once sealed) — same precedent as
/// the 2026-07-26 testnet v10 migration.
contract DeployGraduationHubMainnetUsdcOnly is Script {
    function run() external {
        address payable treasury = payable(vm.envAddress("TREASURY"));
        uint256 thresholdUsdc = vm.envUint("GRADUATION_THRESHOLD");

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ArcGraduationHub hub = new ArcGraduationHub();
        ArcPairFactoryV2 pairFactory = new ArcPairFactoryV2(treasury);
        pairFactory.setGraduationAuthority(address(hub));

        ArcPumpFactoryV8 usdcPump = new ArcPumpFactoryV8(pairFactory, treasury, thresholdUsdc);

        hub.register(address(usdcPump));
        hub.seal();

        ArcRouter router = new ArcRouter(ArcPairFactory(address(pairFactory)));

        vm.stopBroadcast();

        console2.log("ArcGraduationHub      ", address(hub));
        console2.log("ArcPairFactoryV2      ", address(pairFactory));
        console2.log("ArcPumpFactoryV8      ", address(usdcPump));
        console2.log("ArcRouter             ", address(router));
        console2.log("authority             ", pairFactory.graduationAuthority());
        console2.log("hub sealed            ", hub.sealed_());
        console2.log("hub members           ", hub.memberCount());
    }
}
