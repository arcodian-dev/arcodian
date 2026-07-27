// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcManualOracleV2} from "../src/ArcManualOracleV2.sol";

/// Not the live oracle path (ArcLendV2 uses real ArcPythOracle) — deployed
/// only so a bounded fallback exists and is ready if Pyth ever needs one.
contract DeployArcManualOracleV2 is Script {
    function run() external returns (ArcManualOracleV2 oracle) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address admin = vm.envAddress("MANUAL_ORACLE_ADMIN");
        uint256 initialPrice = vm.envUint("MANUAL_ORACLE_INITIAL_PRICE");
        uint256 maxMoveBps = vm.envOr("MANUAL_ORACLE_MAX_MOVE_BPS", uint256(2_000));
        vm.startBroadcast(key);
        oracle = new ArcManualOracleV2(admin, initialPrice, maxMoveBps);
        vm.stopBroadcast();
    }
}
