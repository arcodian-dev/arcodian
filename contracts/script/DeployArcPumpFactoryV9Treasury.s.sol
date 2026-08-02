// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcPumpFactoryV9, IUniswapV3FactoryMinimal, INonfungiblePositionManagerMinimal} from "../src/ArcPumpV9.sol";

/// @notice Re-deploy of ArcPumpFactoryV9 with the correct treasury address.
/// The original mainnet factory (0x071f978A9e7b8Ea0Ad914cba0d4C2c097f327066)
/// was constructed with the deployer EOA as `treasury_` instead of the real
/// treasury multisig — found 2026-08-02 while verifying fee routing.
/// `treasury` is immutable per-factory (and per-curve, since each curve is
/// spawned with the factory's `treasury`), so the only fix is a fresh
/// factory with the right address; the old one's one existing launch keeps
/// running on its original (wrong-treasury) curve since that can't migrate.
contract DeployArcPumpFactoryV9Treasury is Script {
    function run() external returns (ArcPumpFactoryV9 factory) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address v3Factory = vm.envAddress("V3_FACTORY");
        address positionManager = vm.envAddress("POSITION_MANAGER");
        address payable treasury = payable(vm.envAddress("TREASURY"));
        uint256 threshold = vm.envUint("GRADUATION_THRESHOLD");
        vm.startBroadcast(key);
        factory = new ArcPumpFactoryV9(
            IUniswapV3FactoryMinimal(v3Factory),
            INonfungiblePositionManagerMinimal(positionManager),
            treasury,
            threshold
        );
        vm.stopBroadcast();
    }
}
