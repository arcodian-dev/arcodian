// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPumpSuiteV7, ArcDexFactoryV7, ArcPumpFactoryV7} from "../src/ArcPumpV7.sol";

contract DeployArcPumpV7 is Script {
    function run(uint256 graduationThreshold, address payable treasury) external returns (ArcPumpSuiteV7 suite) {
        require(graduationThreshold > 1_000 ether, "BAD_THRESHOLD");
        require(treasury != address(0), "ZERO_TREASURY");

        vm.startBroadcast();
        suite = new ArcPumpSuiteV7(graduationThreshold, treasury);
        vm.stopBroadcast();

        ArcDexFactoryV7 dex = suite.dexFactory();
        ArcPumpFactoryV7 pump = suite.pumpFactory();
        require(suite.ENGINE_VERSION() == 7, "BAD_ENGINE_VERSION");
        require(dex.ENGINE_VERSION() == 7, "BAD_DEX_VERSION");
        require(pump.ENGINE_VERSION() == 7, "BAD_PUMP_VERSION");
        require(dex.pumpFactory() == address(pump), "BAD_FACTORY_WIRING");
        require(address(dex.treasury()) == treasury, "BAD_DEX_TREASURY");
        require(address(pump.treasury()) == treasury, "BAD_PUMP_TREASURY");
        require(pump.graduationThreshold() == graduationThreshold, "BAD_THRESHOLD_WIRING");
    }
}
