// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/ArcServiceRegistry.sol";
import "../src/ArcPayVault.sol";

contract DeployAgentRail is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address passport = vm.envAddress("PASSPORT_ADDR");   // 0xDaCEF31c...2cCf
        address treasury = vm.envAddress("FEE_TREASURY");    // 0xF1CBe360...105CaF
        uint16 feeBps = uint16(vm.envUint("FEE_BPS"));       // 50

        vm.startBroadcast(pk);
        ArcServiceRegistry reg = new ArcServiceRegistry(passport);
        ArcPayVault vault = new ArcPayVault(payable(treasury), feeBps);
        vm.stopBroadcast();

        console.log("ArcServiceRegistry", address(reg));
        console.log("ArcPayVault", address(vault));
    }
}
