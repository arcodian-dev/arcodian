// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {ArcodianV4Router} from "../src/ArcodianV4Router.sol";

/// Deployed directly from the EOA, not through the CREATE2 deployer: a router
/// has no address constraint, and a top-level creation is what lets
/// arcexplorer index the contract and publish its source — the V12 hook,
/// which did need CREATE2, cannot be verified there for exactly that reason.
contract DeployArcodianV4RouterMainnet is Script {
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    function run() external returns (ArcodianV4Router router) {
        require(block.chainid == 5042, "NOT_ARC_MAINNET");
        vm.startBroadcast();
        router = new ArcodianV4Router(POOL_MANAGER);
        vm.stopBroadcast();
        require(address(router.poolManager()) == address(POOL_MANAGER), "BAD_MANAGER");
        console2.log("ArcodianV4Router", address(router));
    }
}
