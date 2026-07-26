// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPumpSuite, ArcDexFactory, ArcPumpFactory} from "../src/ArcPump.sol";

/// Deploys the engine-v9 pump suite (ArcPump.sol) with a caller-supplied
/// graduation threshold. Threshold is immutable per suite by design — raising
/// it means deploying a new suite, never mutating a live one, so existing
/// curves keep the terms their buyers bought under.
contract DeployArcPump is Script {
    function run(uint256 graduationThreshold, address payable treasury) external returns (ArcPumpSuite suite) {
        require(graduationThreshold > 1_000 ether, "BAD_THRESHOLD");
        require(treasury != address(0), "ZERO_TREASURY");

        vm.startBroadcast();
        suite = new ArcPumpSuite(graduationThreshold, treasury);
        vm.stopBroadcast();

        ArcDexFactory dex = suite.dexFactory();
        ArcPumpFactory pump = suite.pumpFactory();
        require(dex.pumpFactory() == address(pump), "BAD_FACTORY_WIRING");
        require(address(dex.treasury()) == treasury, "BAD_DEX_TREASURY");
        require(address(pump.treasury()) == treasury, "BAD_PUMP_TREASURY");
        require(pump.graduationThreshold() == graduationThreshold, "BAD_THRESHOLD_WIRING");

        console2.log("ArcPumpSuite   ", address(suite));
        console2.log("ArcDexFactory  ", address(dex));
        console2.log("ArcPumpFactory ", address(pump));
        console2.log("threshold      ", graduationThreshold);
    }
}
