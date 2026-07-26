// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcLendV2, IERC20Collateral, IArcPriceOracle} from "../src/ArcLendV2.sol";

/// Deploys the utilization-rate ArcLend market, reusing the live ArcLendPyth
/// market's oracle, admin (governance timelock), guardian, and caps — only
/// the interest model changes. The prior market held zero deposits and zero
/// borrows at migration time, so nothing needed a withdraw-only wind-down.
contract DeployArcLendV2 is Script {
    function run() external returns (ArcLendV2 market) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(key);
        market = new ArcLendV2(
            IERC20Collateral(vm.envAddress("LEND_COLLATERAL")),
            IArcPriceOracle(vm.envAddress("LEND_ORACLE")),
            vm.envAddress("LEND_ADMIN"),
            vm.envAddress("LEND_GUARDIAN"),
            vm.envUint("LEND_SUPPLY_CAP"),
            vm.envUint("LEND_BORROW_CAP"),
            vm.envUint("LEND_BASE_RATE_WAD"),
            vm.envUint("LEND_MULTIPLIER_WAD"),
            vm.envUint("LEND_JUMP_MULTIPLIER_WAD"),
            vm.envUint("LEND_KINK_WAD")
        );
        vm.stopBroadcast();

        console2.log("ArcLendV2   ", address(market));
        console2.log("utilization ", market.utilization());
        console2.log("borrowRate  ", market.borrowRatePerYear());
    }
}
