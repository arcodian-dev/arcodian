// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {IERC20} from "../src/ArcFxPool.sol";
import {ArcFxPoolV2} from "../src/ArcFxPoolV2.sol";

/// Arc Mainnet deploy for the USDC/EURC FX pool.
///
/// Separate from DeployFxPoolV2.s.sol because that one reads a raw
/// DEPLOYER_PK out of the environment. The mainnet deployer key is held in an
/// encrypted Foundry keystore (`arcodian-mainnet-deployer`), so this script
/// takes no key at all and lets `forge script --account` supply the sender.
///
/// Addresses are hardcoded rather than passed in: these are Circle's
/// published Arc Mainnet contracts, each verified on-chain by eth_getCode
/// (and EURC additionally by reading name/symbol/decimals) on 2026-09-16, and
/// a typo in a constructor argument here is permanent.
contract DeployFxPoolV2Mainnet is Script {
    // Native USDC ERC-20 view precompile — same fixed address on both networks.
    address constant USDC = 0x3600000000000000000000000000000000000000;
    // Circle's Arc Mainnet EURC. NOT the testnet address, which has no code here.
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    // The real treasury multisig, not the deployer EOA. Getting this wrong is
    // the exact bug that forced ArcPay and two factories to be redeployed on
    // 2026-09-05, because `treasury` is immutable.
    address constant TREASURY = 0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF;

    function run() external returns (ArcFxPoolV2 pool) {
        require(block.chainid == 5042, "NOT_ARC_MAINNET");
        vm.startBroadcast();
        pool = new ArcFxPoolV2(IERC20(USDC), IERC20(EURC), TREASURY);
        vm.stopBroadcast();

        // Fail the run rather than leave a mis-wired pool discovered later.
        require(address(pool.usdc()) == USDC, "BAD_USDC");
        require(address(pool.eurc()) == EURC, "BAD_EURC");
        require(pool.treasury() == TREASURY, "BAD_TREASURY");
        console2.log("ArcFxPoolV2 (Arc Mainnet)", address(pool));
    }
}
