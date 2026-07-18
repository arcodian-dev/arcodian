// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {IERC20} from "../src/ArcFxPool.sol";
import {ArcPair} from "../src/ArcPair.sol";
import {ArcPairFactory} from "../src/ArcPairFactory.sol";

/// Minimal 18-decimal ERC-20 used only to exercise the AMM end to end on testnet.
contract SmokeToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply, address to) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply;
        balanceOf[to] = supply;
        emit Transfer(address(0), to, supply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}

/// End-to-end smoke test against the live ArcPairFactory: deploy two tokens,
/// create a pair, add liquidity, swap small, swap large, then withdraw.
/// Deliberately uses throwaway tokens so the real USDC/EURC liquidity is not
/// fragmented across a third venue.
contract SmokeTestAmm is Script {
    function run() external {
        ArcPairFactory factory = ArcPairFactory(vm.envAddress("FACTORY"));
        uint256 pk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(pk);
        ArcPair pair = _setup(factory, vm.addr(pk));
        _trade(pair, vm.addr(pk));
        vm.stopBroadcast();
    }

    function _setup(ArcPairFactory factory, address me) internal returns (ArcPair pair) {
        SmokeToken a = new SmokeToken("Smoke A", "SMKA", 1_000_000 ether, me);
        SmokeToken b = new SmokeToken("Smoke B", "SMKB", 1_000_000 ether, me);
        console2.log("tokenA", address(a));
        console2.log("tokenB", address(b));

        pair = ArcPair(factory.createPair(address(a), address(b), 30));
        console2.log("pair", address(pair));

        a.approve(address(pair), type(uint256).max);
        b.approve(address(pair), type(uint256).max);

        uint256 shares = pair.addLiquidity(1000 ether, 1000 ether, 1, uint64(block.timestamp + 3600));
        console2.log("shares minted", shares);
        console2.log("reserve0", pair.reserve0());
        console2.log("reserve1", pair.reserve1());
    }

    function _trade(ArcPair pair, address me) internal {
        uint64 deadline = uint64(block.timestamp + 3600);

        console2.log("small quote", pair.quote(true, 1 ether));
        console2.log("small out  ", pair.swap(true, 1 ether, 1, deadline));

        // Large swap: 300 into a 1000 pool — the case a user must be warned about.
        console2.log("large quote", pair.quote(true, 300 ether));
        console2.log("large out  ", pair.swap(true, 300 ether, 1, deadline));

        console2.log("protocol0 accrued", pair.protocol0());
        console2.log("protocol1 accrued", pair.protocol1());

        (uint256 out0, uint256 out1) = pair.removeLiquidity(pair.balanceOf(me), 1, 1, deadline);
        console2.log("withdrawn0", out0);
        console2.log("withdrawn1", out1);
    }
}
