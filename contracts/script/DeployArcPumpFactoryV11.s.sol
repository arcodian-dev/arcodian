// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPumpFactoryV11, IUniswapV3FactoryV10, INonfungiblePositionManagerV10} from "../src/ArcPumpV11.sol";

contract DeployArcPumpFactoryV11 is Script {
    function run() external returns (ArcPumpFactoryV11 factory) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address v3Factory = vm.envAddress("V3_FACTORY");
        address positionManager = vm.envAddress("POSITION_MANAGER");
        address payable treasury = payable(vm.envAddress("TREASURY"));
        uint256 threshold = vm.envUint("GRADUATION_THRESHOLD");
        vm.startBroadcast(key);
        factory = new ArcPumpFactoryV11(
            IUniswapV3FactoryV10(v3Factory),
            INonfungiblePositionManagerV10(positionManager),
            treasury,
            threshold
        );
        vm.stopBroadcast();
    }
}
