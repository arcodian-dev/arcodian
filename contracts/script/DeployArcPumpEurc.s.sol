// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPumpSuiteEurc, ArcDexFactoryEurc, ArcPumpFactoryEurc} from "../src/ArcPumpEurc.sol";
import {IERC20} from "../src/ArcFxPool.sol";

contract DeployArcPumpEurc is Script {
    function run(address eurc, uint256 graduationThreshold, address payable treasury)
        external
        returns (ArcPumpSuiteEurc suite)
    {
        require(eurc != address(0) && treasury != address(0), "ZERO");
        require(graduationThreshold > 1_000_000_000, "BAD_THRESHOLD");
        vm.startBroadcast();
        suite = new ArcPumpSuiteEurc(IERC20(eurc), graduationThreshold, treasury);
        vm.stopBroadcast();

        ArcDexFactoryEurc dex = suite.dexFactory();
        ArcPumpFactoryEurc pump = suite.pumpFactory();
        require(suite.ENGINE_VERSION() == 7 && suite.QUOTE_KIND() == 1, "BAD_ENGINE");
        require(dex.pumpFactory() == address(pump), "BAD_WIRING");
        require(address(pump.quote()) == eurc, "BAD_QUOTE");
        require(pump.graduationThreshold() == graduationThreshold, "BAD_THRESHOLD_WIRING");
    }
}
