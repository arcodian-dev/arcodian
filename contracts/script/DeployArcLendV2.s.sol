// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcLendV2, IERC20Collateral, IArcPriceOracle} from "../src/ArcLendV2.sol";

/// Deploys the utilization-rate ArcLend market against a real IArcPriceOracle
/// (ArcPythOracle in practice), reusing the governance timelock as admin and
/// the existing guardian/collateral/caps. LEND_MAX_ORACLE_AGE must be sized to
/// the feed's real publish cadence — a traditional FX feed (EUR/USD) only
/// updates during NY market hours and goes quiet the full weekend, so a
/// crypto-feed-style 1-hour bound would falsely revert OracleStale() every
/// Friday close through Sunday reopen.
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
            vm.envUint("LEND_KINK_WAD"),
            vm.envUint("LEND_MAX_ORACLE_AGE")
        );
        vm.stopBroadcast();

        console2.log("ArcLendV2   ", address(market));
        console2.log("utilization ", market.utilization());
        console2.log("borrowRate  ", market.borrowRatePerYear());
    }
}
