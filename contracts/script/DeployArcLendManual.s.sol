// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcLendV2, IERC20Collateral, IArcPriceOracle} from "../src/ArcLendV2.sol";
import {ArcManualOracle} from "../src/ArcLend.sol";

/// Interim deploy while Pyth's EUR/USD feed on Arc Testnet is stale upstream
/// (Hermes itself serves the same frozen publish_time — nothing on our side
/// can force a refresh). Admin is the keeper hot key already running
/// systemd-scheduled price pushes, not governance, so updates can stay
/// automated; swap-back to ArcPythOracle is a follow-up once Pyth resumes.
contract DeployArcLendManual is Script {
    function run() external returns (ArcManualOracle oracle, ArcLendV2 market) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(key);
        oracle = new ArcManualOracle(vm.envAddress("LEND_ORACLE_ADMIN"), vm.envUint("LEND_INITIAL_PRICE"));
        market = new ArcLendV2(
            IERC20Collateral(vm.envAddress("LEND_COLLATERAL")),
            IArcPriceOracle(address(oracle)),
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

        console2.log("ArcManualOracle", address(oracle));
        console2.log("ArcLendV2      ", address(market));
    }
}
