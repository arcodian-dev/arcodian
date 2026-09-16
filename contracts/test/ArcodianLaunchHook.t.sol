// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";

using CurrencyLibrary for Currency;
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ArcodianLaunchHook} from "../src/ArcodianLaunchHook.sol";

contract MintableToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 x = allowance[f][msg.sender];
        if (x != type(uint256).max) allowance[f][msg.sender] = x - a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/// Real PoolManager, real swap router, real hook. A mocked manager would not
/// exercise the delta accounting, which is the only part of a fee hook that
/// can silently be wrong.
contract ArcodianLaunchHookTest is Test {
    using PoolIdLibrary for PoolKey;

    PoolManager manager;
    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest liquidityRouter;
    ArcodianLaunchHook hook;

    MintableToken tokenA;
    MintableToken tokenB;
    Currency currency0;
    Currency currency1;
    PoolKey key;

    address factory = address(0xFAC);
    address payable treasury = payable(address(0xFEE));
    address creator = address(0xC0FFEE);
    address trader = address(0xB0B);

    function setUp() public {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        liquidityRouter = new PoolModifyLiquidityTest(manager);

        // A hook's permissions live in its address. Placing the code at an
        // address with exactly the beforeSwap + beforeSwapReturnDelta bits is
        // what the PoolManager validates at initialize(); mining a CREATE2
        // salt is the deploy-time equivalent of this.
        address flagged = address(uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) | uint160(0x4444 << 20));
        deployCodeTo("ArcodianLaunchHook.sol:ArcodianLaunchHook", abi.encode(manager, factory, treasury), flagged);
        hook = ArcodianLaunchHook(flagged);

        tokenA = new MintableToken();
        tokenB = new MintableToken();
        (currency0, currency1) = address(tokenA) < address(tokenB)
            ? (Currency.wrap(address(tokenA)), Currency.wrap(address(tokenB)))
            : (Currency.wrap(address(tokenB)), Currency.wrap(address(tokenA)));

        key = PoolKey({ currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook)) });
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));

        vm.prank(factory);
        hook.registerLaunch(key.toId(), creator);

        _mintAndApprove(address(this), 1_000_000 ether);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({ tickLower: -600, tickUpper: 600, liquidityDelta: 100_000 ether, salt: 0 }),
            ""
        );
        _mintAndApprove(trader, 10_000 ether);
    }

    function _mintAndApprove(address who, uint256 amount) internal {
        tokenA.mint(who, amount);
        tokenB.mint(who, amount);
        vm.startPrank(who);
        tokenA.approve(address(swapRouter), type(uint256).max);
        tokenB.approve(address(swapRouter), type(uint256).max);
        tokenA.approve(address(liquidityRouter), type(uint256).max);
        tokenB.approve(address(liquidityRouter), type(uint256).max);
        vm.stopPrank();
    }

    function _swap(address who, bool zeroForOne, uint256 amountIn) internal {
        vm.prank(who);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
    }

    // --- the fee -----------------------------------------------------------

    function testTakesOnePercentAndSplitsItEvenly() public {
        uint256 amountIn = 1_000 ether;
        _swap(trader, true, amountIn);

        uint256 expectedFee = (amountIn * 100) / 10_000;
        uint256 expectedHalf = expectedFee / 2;
        assertEq(hook.claimable(creator, currency0), expectedHalf, "creator half");
        assertEq(hook.claimable(treasury, currency0), expectedFee - expectedHalf, "treasury half");
        assertEq(
            hook.claimable(creator, currency0) + hook.claimable(treasury, currency0),
            expectedFee,
            "the two halves must sum to exactly 1%"
        );
    }

    /// The fee has to survive a swap nobody from Arcodian initiated — that is
    /// the entire reason for using a hook instead of a curve.
    function testChargesASwapFromAnUnrelatedRouter() public {
        PoolSwapTest foreign = new PoolSwapTest(manager);
        address stranger = address(0xDEADBEEF);
        tokenA.mint(stranger, 1_000 ether);
        vm.startPrank(stranger);
        tokenA.approve(address(foreign), type(uint256).max);
        foreign.swap(
            key,
            SwapParams({ zeroForOne: true, amountSpecified: -int256(500 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
        vm.stopPrank();
        assertEq(hook.claimable(creator, currency0), (500 ether * 50) / 10_000, "a foreign router's swap pays the same fee");
    }

    function testChargesBothDirections() public {
        _swap(trader, true, 400 ether);
        _swap(trader, false, 400 ether);
        assertGt(hook.claimable(creator, currency0), 0, "buy side");
        assertGt(hook.claimable(creator, currency1), 0, "sell side");
    }

    function testFeeAccumulatesAcrossSwaps() public {
        _swap(trader, true, 100 ether);
        uint256 afterFirst = hook.claimable(treasury, currency0);
        _swap(trader, true, 100 ether);
        assertEq(hook.claimable(treasury, currency0), afterFirst * 2, "second swap adds the same again");
    }

    /// An exact-output swap specifies what it wants out, not what it puts in.
    /// Taking a cut of that would charge an amount the trader never named,
    /// which is how a hook quietly breaks routers — so it is left alone.
    function testLeavesExactOutputSwapsAlone() public {
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({ zeroForOne: true, amountSpecified: int256(10 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
        assertEq(hook.claimable(creator, currency0), 0);
        assertEq(hook.claimable(treasury, currency0), 0);
    }

    // --- claiming ----------------------------------------------------------

    function testCreatorAndTreasuryCanPullTheirOwnShare() public {
        _swap(trader, true, 1_000 ether);
        uint256 creatorOwed = hook.claimable(creator, currency0);
        uint256 treasuryOwed = hook.claimable(treasury, currency0);

        vm.prank(creator);
        hook.claim(currency0);
        vm.prank(treasury);
        hook.claim(currency0);

        assertEq(tokenA.balanceOf(creator) + tokenB.balanceOf(creator), creatorOwed, "creator paid");
        assertEq(tokenA.balanceOf(treasury) + tokenB.balanceOf(treasury), treasuryOwed, "treasury paid");
        assertEq(hook.claimable(creator, currency0), 0, "not claimable twice");
    }

    function testClaimingNothingReverts() public {
        vm.prank(creator);
        vm.expectRevert(ArcodianLaunchHook.NothingToClaim.selector);
        hook.claim(currency0);
    }

    function testOneAccountCannotClaimAnothersShare() public {
        _swap(trader, true, 1_000 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert(ArcodianLaunchHook.NothingToClaim.selector);
        hook.claim(currency0);
    }

    // --- registration ------------------------------------------------------

    function testOnlyTheFactoryCanRegisterALaunch() public {
        PoolId id = PoolId.wrap(bytes32(uint256(1234)));
        vm.prank(address(0xBAD));
        vm.expectRevert(ArcodianLaunchHook.NotFactory.selector);
        hook.registerLaunch(id, creator);
    }

    /// A reassignable creator would let whoever reassigned it collect the
    /// creator's half of every future trade.
    function testACreatorCannotBeReassigned() public {
        vm.prank(factory);
        vm.expectRevert(ArcodianLaunchHook.AlreadyRegistered.selector);
        hook.registerLaunch(key.toId(), address(0xBAD));
    }

    function testOnlyThePoolManagerCanCallTheHook() public {
        vm.expectRevert(ArcodianLaunchHook.NotPoolManager.selector);
        hook.beforeSwap(
            address(this),
            key,
            SwapParams({ zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            ""
        );
    }

    // --- invariant ---------------------------------------------------------

    /// The hook must never owe out more of a currency than it holds.
    ///
    /// What it holds is ERC-6909 claims inside the PoolManager, not ERC-20 in
    /// its own balance — the fee is minted as claims because beforeSwap runs
    /// before the trader settles, so there is nothing in the manager to take
    /// yet. The claims become real tokens in claim().
    function testFuzzHookStaysSolvent(uint96 a, uint96 b) public {
        uint256 first = uint256(a) % 500 ether;
        uint256 second = uint256(b) % 500 ether;
        if (first > 1e6) _swap(trader, true, first);
        if (second > 1e6) _swap(trader, false, second);
        assertGe(
            manager.balanceOf(address(hook), currency0.toId()),
            hook.claimable(creator, currency0) + hook.claimable(treasury, currency0),
            "currency0 claims cover what is owed"
        );
        assertGe(
            manager.balanceOf(address(hook), currency1.toId()),
            hook.claimable(creator, currency1) + hook.claimable(treasury, currency1),
            "currency1 claims cover what is owed"
        );
    }

    /// And a claim really does hand over the underlying token, not a claim.
    function testClaimRedeemsClaimsForTheRealToken() public {
        _swap(trader, true, 1_000 ether);
        uint256 owed = hook.claimable(treasury, currency0);
        assertGt(owed, 0);
        uint256 before = Currency.unwrap(currency0) == address(tokenA) ? tokenA.balanceOf(treasury) : tokenB.balanceOf(treasury);
        vm.prank(treasury);
        hook.claim(currency0);
        uint256 after_ = Currency.unwrap(currency0) == address(tokenA) ? tokenA.balanceOf(treasury) : tokenB.balanceOf(treasury);
        assertEq(after_ - before, owed, "paid in the real ERC-20");
        assertEq(manager.balanceOf(address(hook), currency0.toId()), hook.claimable(creator, currency0), "claims burned on withdrawal");
    }
}
