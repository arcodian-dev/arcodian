// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPair} from "../src/ArcPair.sol";
import {IERC20} from "../src/ArcFxPool.sol";

/// Skims a percentage on every transfer — the classic reserve-accounting breaker.
contract FeeOnTransferToken {
    uint8 public constant decimals = 18;
    uint256 public immutable feePct;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint256 feePct_) { feePct = feePct_; }

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        uint256 fee = amount * feePct / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee; // the fee simply vanishes
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }
}

/// Balances can be inflated externally with no transfer.
contract RebasingToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function rebaseInto(address who, uint256 amount) external { balanceOf[who] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Re-enters the pair from its transfer hook.
contract ReentrantToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    ArcPair public pair;
    bool public attacking;

    function setPair(ArcPair pair_) external { pair = pair_; }
    function arm() external { attacking = true; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _hook() private {
        if (attacking && address(pair) != address(0)) {
            attacking = false;
            pair.swap(true, 1 ether, 1, uint64(block.timestamp + 1));
        }
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        _hook();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        _hook();
        return true;
    }
}

contract PlainToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ArcPairHostileTokensTest is Test {
    address treasury = address(0xFEE);
    address alice = address(0xA11CE);
    address attacker = address(0xBAD);
    uint64 constant DEADLINE = 4102444800;

    function _order(address a, address b) internal pure returns (address, address) {
        return a < b ? (a, b) : (b, a);
    }

    function _assertReservesMatchBalances(ArcPair pair) internal view {
        assertEq(
            pair.reserve0(),
            pair.token0().balanceOf(address(pair)) - pair.protocol0(),
            "reserve0 == measured balance"
        );
        assertEq(
            pair.reserve1(),
            pair.token1().balanceOf(address(pair)) - pair.protocol1(),
            "reserve1 == measured balance"
        );
    }

    // --- Fee-on-transfer ---

    function testFeeOnTransferKeepsReservesEqualToMeasuredBalances() public {
        FeeOnTransferToken hostile = new FeeOnTransferToken(1); // 1% skim
        PlainToken plain = new PlainToken();
        (address t0, address t1) = _order(address(hostile), address(plain));
        ArcPair pair = new ArcPair(IERC20(t0), IERC20(t1), 30, treasury);

        hostile.mint(alice, 10_000 ether);
        plain.mint(alice, 10_000 ether);
        vm.startPrank(alice);
        hostile.approve(address(pair), type(uint256).max);
        plain.approve(address(pair), type(uint256).max);
        pair.addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        vm.stopPrank();

        _assertReservesMatchBalances(pair);
    }

    function testFeeOnTransferSwapperCannotExtractMoreThanTheyPaid() public {
        FeeOnTransferToken hostile = new FeeOnTransferToken(1);
        PlainToken plain = new PlainToken();
        (address t0, address t1) = _order(address(hostile), address(plain));
        ArcPair pair = new ArcPair(IERC20(t0), IERC20(t1), 30, treasury);

        hostile.mint(alice, 10_000 ether);
        plain.mint(alice, 10_000 ether);
        vm.startPrank(alice);
        hostile.approve(address(pair), type(uint256).max);
        plain.approve(address(pair), type(uint256).max);
        pair.addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        vm.stopPrank();

        hostile.mint(attacker, 100 ether);
        vm.startPrank(attacker);
        hostile.approve(address(pair), type(uint256).max);
        bool hostileIsZero = t0 == address(hostile);
        uint256 out = pair.swap(hostileIsZero, 100 ether, 1, DEADLINE);
        vm.stopPrank();

        // A 1%-skimming input token must yield strictly less than a clean swap of
        // the same nominal size, never more.
        assertLt(out, 100 ether, "no free value extracted");
        _assertReservesMatchBalances(pair);
    }

    // --- Reentrancy ---

    function testReentrantTokenCannotReenterSwap() public {
        ReentrantToken hostile = new ReentrantToken();
        PlainToken plain = new PlainToken();
        (address t0, address t1) = _order(address(hostile), address(plain));
        ArcPair pair = new ArcPair(IERC20(t0), IERC20(t1), 30, treasury);
        hostile.setPair(pair);

        hostile.mint(alice, 10_000 ether);
        plain.mint(alice, 10_000 ether);
        vm.startPrank(alice);
        hostile.approve(address(pair), type(uint256).max);
        plain.approve(address(pair), type(uint256).max);
        pair.addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        vm.stopPrank();

        hostile.mint(attacker, 100 ether);
        hostile.arm();
        vm.startPrank(attacker);
        hostile.approve(address(pair), type(uint256).max);
        vm.expectRevert(bytes("REENTRANCY"));
        pair.swap(t0 == address(hostile), 100 ether, 1, DEADLINE);
        vm.stopPrank();
    }

    // --- Rebasing ---

    function testRebaseIsAbsorbedIntoReservesNotLost() public {
        RebasingToken hostile = new RebasingToken();
        PlainToken plain = new PlainToken();
        (address t0, address t1) = _order(address(hostile), address(plain));
        ArcPair pair = new ArcPair(IERC20(t0), IERC20(t1), 30, treasury);

        hostile.mint(alice, 10_000 ether);
        plain.mint(alice, 10_000 ether);
        vm.startPrank(alice);
        hostile.approve(address(pair), type(uint256).max);
        plain.approve(address(pair), type(uint256).max);
        uint256 shares = pair.addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        vm.stopPrank();

        // Balance grows with no transfer.
        hostile.rebaseInto(address(pair), 500 ether);

        // The next mutating call resyncs reserves from measured balances.
        vm.prank(alice);
        pair.removeLiquidity(shares / 2, 1, 1, DEADLINE);

        _assertReservesMatchBalances(pair);
    }
}
