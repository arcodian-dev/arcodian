// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ArcMultisig,ArcTimelock} from "../src/ArcGovernance.sol";
import {ArcLend,IERC20Collateral,IArcPriceOracle} from "../src/ArcLend.sol";

contract DeployArcLendGoverned is Script {
    function run() external returns(ArcMultisig multisig,ArcTimelock timelock,ArcLend market){
        uint256 key=vm.envUint("PRIVATE_KEY");
        address[] memory owners=new address[](2);
        owners[0]=vm.envAddress("GOV_TREASURY_OWNER");
        owners[1]=vm.envAddress("GOV_OPERATIONS_OWNER");
        vm.startBroadcast(key);
        multisig=new ArcMultisig(owners,2);
        timelock=new ArcTimelock(address(multisig),uint64(vm.envUint("GOV_TIMELOCK_DELAY")));
        market=new ArcLend(
            IERC20Collateral(vm.envAddress("LEND_COLLATERAL")),
            IArcPriceOracle(vm.envAddress("LEND_ORACLE")),
            address(timelock),
            vm.envAddress("LEND_GUARDIAN"),
            vm.envUint("LEND_SUPPLY_CAP"),
            vm.envUint("LEND_BORROW_CAP"),
            vm.envUint("LEND_ANNUAL_RATE_WAD")
        );
        vm.stopBroadcast();
    }
}
