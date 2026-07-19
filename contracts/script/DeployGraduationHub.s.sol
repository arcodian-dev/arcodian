// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPairFactoryV2} from "../src/ArcPairFactoryV2.sol";
import {ArcGraduationHub} from "../src/ArcGraduationHub.sol";
import {ArcPumpFactoryV8} from "../src/ArcPumpV8.sol";
import {ArcPumpFactoryEurcV8} from "../src/ArcPumpEurcV8.sol";
import {ArcRouter} from "../src/ArcRouter.sol";
import {ArcPairFactory} from "../src/ArcPairFactory.sol";
import {IERC20} from "../src/ArcFxPool.sol";

/// Redeploys the graduation stack behind ArcGraduationHub, so USDC and EURC
/// launchpads share one pair registry instead of one taking the single
/// authority slot and locking the other out.
///
/// Everything happens in one broadcast on purpose. Between deploying the
/// registry and sealing the hub the registry reserves nothing, and between
/// registering a member and sealing the hub the deployer could still admit
/// another. Both gaps are closed before the transaction batch ends rather than
/// left to a follow-up step someone might forget.
///
/// The previous instances are not touched. They keep working for whatever has
/// already graduated; the frontend retires them by address.
contract DeployGraduationHub is Script {
    function run() external {
        address payable treasury = payable(vm.envAddress("TREASURY"));
        uint256 thresholdUsdc = vm.envUint("GRADUATION_THRESHOLD");
        uint256 thresholdEurc = vm.envUint("GRADUATION_THRESHOLD_EURC");
        address eurc = vm.envAddress("EURC_ADDRESS");

        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));

        ArcGraduationHub hub = new ArcGraduationHub();
        ArcPairFactoryV2 pairFactory = new ArcPairFactoryV2(treasury);
        pairFactory.setGraduationAuthority(address(hub));

        ArcPumpFactoryV8 usdcPump = new ArcPumpFactoryV8(pairFactory, treasury, thresholdUsdc);
        ArcPumpFactoryEurcV8 eurcPump =
            new ArcPumpFactoryEurcV8(pairFactory, IERC20(eurc), treasury, thresholdEurc);

        hub.register(address(usdcPump));
        hub.register(address(eurcPump));
        hub.seal();

        // ArcRouter types its factory as V1, but only calls getPair, whose
        // signature is identical in V2. The cast is safe for that reason and no
        // other — if the router ever calls createPair it must be retyped.
        ArcRouter router = new ArcRouter(ArcPairFactory(address(pairFactory)));

        vm.stopBroadcast();

        console2.log("ArcGraduationHub      ", address(hub));
        console2.log("ArcPairFactoryV2      ", address(pairFactory));
        console2.log("ArcPumpFactoryV8      ", address(usdcPump));
        console2.log("ArcPumpFactoryEurcV8  ", address(eurcPump));
        console2.log("ArcRouter             ", address(router));
        console2.log("authority             ", pairFactory.graduationAuthority());
        console2.log("hub sealed            ", hub.sealed_());
        console2.log("hub members           ", hub.memberCount());
    }
}
