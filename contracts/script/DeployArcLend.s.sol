// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcLend, ArcManualOracle, IERC20Collateral} from "../src/ArcLend.sol";

contract DeployArcLend is Script {
    function run() external returns (ArcManualOracle oracle, ArcLend market) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address admin = vm.envAddress("LEND_ADMIN");
        address guardian = vm.envAddress("LEND_GUARDIAN");
        address collateral = vm.envAddress("LEND_COLLATERAL");
        uint256 price = vm.envUint("LEND_INITIAL_PRICE");
        vm.startBroadcast(key);
        oracle = new ArcManualOracle(admin, price);
        market = new ArcLend(
            IERC20Collateral(collateral),
            oracle,
            admin,
            guardian,
            vm.envUint("LEND_SUPPLY_CAP"),
            vm.envUint("LEND_BORROW_CAP"),
            vm.envUint("LEND_ANNUAL_RATE_WAD")
        );
        vm.stopBroadcast();
    }
}
