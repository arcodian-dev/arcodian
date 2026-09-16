// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcPumpFactoryEurcV11} from "../src/ArcPumpEurcV11.sol";
import {IUniswapV3FactoryV10, INonfungiblePositionManagerV10} from "../src/ArcPumpV10.sol";
import {IERC20} from "../src/ArcFxPool.sol";

/// Arc Mainnet deploy for the EURC launch engine.
///
/// Every argument below is read off the LIVE USDC ArcPumpFactoryV11
/// (0x12ae88784D1CB2A23408BBA483B4bBBc88226FF9) rather than chosen here, so
/// the two engines graduate into the same venue on the same terms and differ
/// only in quote currency: v3Factory, positionManager and treasury are
/// byte-for-byte what that factory returns, and the 12,000 threshold is its
/// 12,000 in EURC's 6 decimals instead of native USDC's 18.
///
/// Takes no key: the mainnet deployer lives in an encrypted Foundry keystore,
/// so `forge script --account` supplies the sender.
contract DeployArcPumpEurcV11Mainnet is Script {
    address constant V3_FACTORY = 0x886694Bc4c5aCc545669E60a6694BA6a0B22d3bd;
    address constant POSITION_MANAGER = 0x332733D05a942da29087Ee4AF3497DE1911bA620;
    // Circle's Arc Mainnet EURC, verified on-chain 2026-09-16. NOT the testnet
    // address, which has no code on this chain.
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    // The treasury multisig, not the deployer EOA — `treasury` is immutable in
    // the vault, and getting it wrong is what forced ArcPay and two factories
    // to be redeployed on 2026-09-05.
    address payable constant TREASURY = payable(0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF);
    // 12,000 EURC at 6 decimals — the live USDC engine's 12,000, in this
    // engine's own quote units.
    uint256 constant THRESHOLD = 12_000e6;

    function run() external returns (ArcPumpFactoryEurcV11 factory) {
        require(block.chainid == 5042, "NOT_ARC_MAINNET");
        vm.startBroadcast();
        factory = new ArcPumpFactoryEurcV11(
            IUniswapV3FactoryV10(V3_FACTORY),
            INonfungiblePositionManagerV10(POSITION_MANAGER),
            IERC20(EURC),
            TREASURY,
            THRESHOLD
        );
        vm.stopBroadcast();

        // Fail the run rather than leave a mis-wired factory to be discovered
        // by the first launch that tries to graduate.
        require(address(factory.v3Factory()) == V3_FACTORY, "BAD_V3_FACTORY");
        require(address(factory.positionManager()) == POSITION_MANAGER, "BAD_POSITION_MANAGER");
        require(address(factory.quote()) == EURC, "BAD_QUOTE");
        require(factory.treasury() == TREASURY, "BAD_TREASURY");
        require(factory.graduationThreshold() == THRESHOLD, "BAD_THRESHOLD");
        require(factory.ENGINE_VERSION() == 11 && factory.QUOTE_KIND() == 1, "BAD_ENGINE");
        console2.log("ArcPumpFactoryEurcV11 (Arc Mainnet)", address(factory));
    }
}
