// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {IERC20} from "../src/ArcFxPool.sol";

/// The single assumption `_graduate()` rests on: a contract that holds native
/// USDC can spend the same balance through the ERC-20 interface at 0x3600…,
/// scaled by 1e12.
///
/// The Foundry tests prove this against an etched mock, which proves only that
/// the code path is wired correctly — a mock cannot confirm the chain actually
/// behaves this way. This probe checks it against the real token, from inside a
/// contract, which is where graduation runs.
contract DualInterfaceProbe {
    address public constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 public constant NATIVE_TO_UNIT_6 = 1e12;

    receive() external payable {}

    /// Returns the ERC-20 view of this contract's own native balance.
    function erc20View() external view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this));
    }

    function nativeBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// Approve and move `units6` of the ERC-20 view to `to`, exactly as
    /// graduation does when seeding the pair.
    function pushAsErc20(address to, uint256 units6) external returns (bool) {
        require(IERC20(USDC).approve(to, units6), "APPROVE");
        return IERC20(USDC).transfer(to, units6);
    }
}

contract ProbeDualInterface is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address me = vm.addr(pk);

        vm.startBroadcast(pk);
        DualInterfaceProbe probe = new DualInterfaceProbe();

        // Fund with a deliberately small amount — this is a behaviour check,
        // not a capacity test.
        (bool sent,) = address(probe).call{value: 0.05 ether}("");
        require(sent, "FUND");

        uint256 nativeAfter = address(probe).balance;
        uint256 erc20After = probe.erc20View();

        // If these disagree, graduation's premise is wrong and it must not ship.
        require(erc20After == nativeAfter / 1e12, "DUAL_INTERFACE_MISMATCH");

        uint256 before = IERC20(0x3600000000000000000000000000000000000000).balanceOf(me);
        probe.pushAsErc20(me, erc20After / 2);
        uint256 gained = IERC20(0x3600000000000000000000000000000000000000).balanceOf(me) - before;

        vm.stopBroadcast();

        console2.log("probe            ", address(probe));
        console2.log("native (18dec)   ", nativeAfter);
        console2.log("erc20  ( 6dec)   ", erc20After);
        console2.log("pushed to caller ", gained);
        console2.log("probe erc20 left ", probe.erc20View());
    }
}
