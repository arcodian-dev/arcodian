// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPumpSuiteV6, ArcDexFactoryV6, ArcPumpFactoryV6} from "../src/ArcPumpV6.sol";

contract DeployArcPumpV6 is Script {
    function run(uint256 graduationThreshold, address payable treasury) external returns (ArcPumpSuiteV6 suite) {
        require(graduationThreshold > 1_000 ether, "BAD_THRESHOLD");
        require(treasury != address(0), "ZERO_TREASURY");

        vm.startBroadcast();
        suite = new ArcPumpSuiteV6(graduationThreshold, treasury);
        vm.stopBroadcast();

        ArcDexFactoryV6 dex = suite.dexFactory();
        ArcPumpFactoryV6 pump = suite.pumpFactory();
        require(suite.ENGINE_VERSION() == 6, "BAD_ENGINE_VERSION");
        require(dex.ENGINE_VERSION() == 6, "BAD_DEX_VERSION");
        require(pump.ENGINE_VERSION() == 6, "BAD_PUMP_VERSION");
        require(dex.pumpFactory() == address(pump), "BAD_FACTORY_WIRING");
        require(address(dex.treasury()) == treasury, "BAD_DEX_TREASURY");
        require(address(pump.treasury()) == treasury, "BAD_PUMP_TREASURY");
        require(pump.graduationThreshold() == graduationThreshold, "BAD_THRESHOLD_WIRING");
    }
}
