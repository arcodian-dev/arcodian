// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcLend, IERC20Collateral} from "../src/ArcLend.sol";
import {ArcPythOracle, IPythArc} from "../src/ArcPythOracle.sol";

contract DeployArcLendPyth is Script {
    function run() external returns (ArcPythOracle oracle, ArcLend market) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(key);
        oracle = new ArcPythOracle(
            IPythArc(vm.envAddress("PYTH_ADDRESS")),
            vm.envBytes32("PYTH_EUR_USD_ID"),
            vm.envUint("PYTH_MAX_CONFIDENCE_BPS")
        );
        market = new ArcLend(
            IERC20Collateral(vm.envAddress("LEND_COLLATERAL")),
            oracle,
            vm.envAddress("LEND_ADMIN"),
            vm.envAddress("LEND_GUARDIAN"),
            vm.envUint("LEND_SUPPLY_CAP"),
            vm.envUint("LEND_BORROW_CAP"),
            vm.envUint("LEND_ANNUAL_RATE_WAD")
        );
        vm.stopBroadcast();
    }
}
