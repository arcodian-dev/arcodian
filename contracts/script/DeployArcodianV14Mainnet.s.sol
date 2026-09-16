// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ArcodianLaunchHookV14} from "../src/ArcodianLaunchHookV14.sol";
import {ArcodianLaunchFactoryV14} from "../src/ArcodianLaunchFactoryV14.sol";

/// Arc Mainnet deploy for the V4 launch engine, V14 (fees in USDC, 0% LP
/// tier, optional launch buy). A new hook is required, not optional: V13
/// pools are bound to the V13 hook forever, and the V14 hook needs different
/// permission bits (0x20CC), which means a different address.
///
/// Order matters and is not interchangeable:
///   1. The hook goes out through the deterministic CREATE2 deployer with a
///      mined salt, because Uniswap V4 reads a hook's permissions from its
///      own address. Deployed anywhere else it is simply never called.
///   2. The factory is deployed normally and takes the hook's address.
///   3. setFactory binds them, once, and self-locks.
/// Run scripts/mine-hook-address.mjs first; the salt it prints is HOOK_SALT.
contract DeployArcodianV14Mainnet is Script {
    /// Uniswap V4 PoolManager on Arc Mainnet. Verified canonical before use:
    /// it answers extsload, protocolFeesAccrued and protocolFeeController.
    /// NOT the address V4 uses on Ethereum — that one has no code here.
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    /// Native USDC's ERC-20 view, the quote every launch is priced in.
    Currency constant QUOTE = Currency.wrap(0x3600000000000000000000000000000000000000);
    address payable constant TREASURY = payable(0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF);
    /// Foundry's deterministic CREATE2 deployer, confirmed live on Arc.
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external returns (ArcodianLaunchHookV14 hook, ArcodianLaunchFactoryV14 factory) {
        require(block.chainid == 5042, "NOT_ARC_MAINNET");
        bytes32 salt = vm.envBytes32("HOOK_SALT");
        address expected = vm.envAddress("HOOK_ADDRESS");

        vm.startBroadcast();
        // The admin is passed explicitly: deploying through the CREATE2
        // deployer means the constructor's msg.sender is that contract.
        hook = new ArcodianLaunchHookV14{salt: salt}(POOL_MANAGER, msg.sender, TREASURY, QUOTE);
        require(address(hook) == expected, "SALT_MISMATCH");

        factory = new ArcodianLaunchFactoryV14(POOL_MANAGER, hook, QUOTE, TREASURY);
        hook.setFactory(address(factory));
        vm.stopBroadcast();

        // Assert the wiring here rather than discovering it on someone's
        // first launch.
        require(factory.wiringOk(), "WIRING");
        require(address(factory.poolManager()) == address(POOL_MANAGER), "BAD_MANAGER");
        require(Currency.unwrap(factory.quote()) == Currency.unwrap(QUOTE), "BAD_QUOTE");
        require(factory.treasury() == TREASURY, "BAD_TREASURY");
        require(hook.treasury() == TREASURY, "BAD_HOOK_TREASURY");
        require(factory.ENGINE_VERSION() == 14, "BAD_ENGINE");
        require(factory.POOL_FEE() == 0, "BAD_POOL_FEE");
        require(Currency.unwrap(hook.quote()) == Currency.unwrap(QUOTE), "BAD_HOOK_QUOTE");
        // The permissions the PoolManager will read off the address.
        require(uint160(address(hook)) & 0x3FFF == 0x20CC, "BAD_HOOK_FLAGS");

        console2.log("ArcodianLaunchHookV14   ", address(hook));
        // The fix itself, asserted against the deployed bytecode.
        require(factory.LAUNCH_TICK_TOKEN0() == -398_400 && factory.LAUNCH_TICK_TOKEN1() == 398_400, "BAD_LAUNCH_TICK");
        console2.log("ArcodianLaunchFactoryV14", address(factory));
    }
}
