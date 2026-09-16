// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PumpToken} from "../src/ArcPump.sol";
import {ArcodianLaunchHook} from "../src/ArcodianLaunchHook.sol";
import {ArcodianLaunchFactoryV12} from "../src/ArcodianLaunchFactoryV12.sol";

contract QuoteToken {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public constant decimals = 6;
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

/// End to end against a real PoolManager: launch a coin, then have a
/// completely unrelated trader buy it through a router that knows nothing
/// about Arcodian. That second half is the whole point of the engine — it is
/// what a Telegram buy bot does, and what no previous engine allowed.
contract ArcodianLaunchFactoryV12Test is Test {
    PoolManager manager;
    PoolSwapTest swapRouter;
    ArcodianLaunchHook hook;
    ArcodianLaunchFactoryV12 factory;
    QuoteToken usdc;

    address payable treasury = payable(address(0xFEE));
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0B);

    function setUp() public {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        usdc = new QuoteToken();

        address flagged = address(uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) | uint160(0x7777 << 20));
        deployCodeTo("ArcodianLaunchHook.sol:ArcodianLaunchHook", abi.encode(manager, address(0), treasury), flagged);
        hook = ArcodianLaunchHook(flagged);

        factory = new ArcodianLaunchFactoryV12(manager, hook, Currency.wrap(address(usdc)), treasury);
        hook.setFactory(address(factory));
    }

    function _launch() internal returns (PumpToken token, PoolKey memory key) {
        vm.prank(creator);
        (address tokenAddress,) = factory.createLaunch("Arc Bee", "ARCBEE", "ipfs://x");
        token = PumpToken(tokenAddress);
        bool tokenIsZero = tokenAddress < address(usdc);
        key = PoolKey({
            currency0: tokenIsZero ? Currency.wrap(tokenAddress) : Currency.wrap(address(usdc)),
            currency1: tokenIsZero ? Currency.wrap(address(usdc)) : Currency.wrap(tokenAddress),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    // --- the launch --------------------------------------------------------

    function testLaunchOpensATradeablePoolImmediately() public {
        (PumpToken token, PoolKey memory key) = _launch();
        // The supply is in the pool, not on a curve — which is exactly what
        // makes it indexable from the outside.
        assertGt(token.balanceOf(address(manager)), 0, "pool holds the supply");
        assertEq(factory.launchCount(), 1);
        assertEq(factory.tokenByLaunch(1), address(token));
        assertTrue(factory.isLaunch(address(token)));
        assertEq(PoolId.unwrap(factory.poolForToken(address(token))), PoolId.unwrap(key.toId()));
    }

    /// Nobody funds the pool. The token side is minted, the quote side starts
    /// empty and fills up as people buy.
    function testTheLaunchCostsNoQuoteCapital() public {
        assertEq(usdc.balanceOf(address(factory)), 0, "factory spends no quote");
        _launch();
        assertEq(usdc.balanceOf(address(manager)), 0, "pool starts with no quote at all");
    }

    function testLaunchFeeIsOnePercentOfSupplyToTreasury() public {
        (PumpToken token,) = _launch();
        assertEq(token.balanceOf(treasury), token.totalSupply() / 100, "1% one-time launch fee");
    }

    function testCreatorIsBoundToThePool() public {
        (PumpToken token,) = _launch();
        assertEq(hook.creatorOf(factory.poolForToken(address(token))), creator);
    }

    // --- an outsider buying it --------------------------------------------

    function testAStrangerCanBuyItThroughAnUnrelatedRouter() public {
        (PumpToken token, PoolKey memory key) = _launch();
        bool tokenIsZero = address(token) < address(usdc);

        usdc.mint(buyer, 1_000e6);
        vm.startPrank(buyer);
        usdc.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            // Buying the token means spending the quote: zeroForOne is true
            // when the quote is currency0.
            SwapParams({
                zeroForOne: !tokenIsZero,
                amountSpecified: -int256(100e6),
                sqrtPriceLimitX96: !tokenIsZero ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
        vm.stopPrank();

        assertGt(token.balanceOf(buyer), 0, "a stranger received tokens");
        assertLt(usdc.balanceOf(buyer), 1_000e6, "and paid quote for them");
    }

    function testThatBuyPaysTheOnePercentSplitEvenly() public {
        (PumpToken token, PoolKey memory key) = _launch();
        bool tokenIsZero = address(token) < address(usdc);
        Currency quoteCurrency = Currency.wrap(address(usdc));

        usdc.mint(buyer, 1_000e6);
        vm.startPrank(buyer);
        usdc.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: !tokenIsZero,
                amountSpecified: -int256(100e6),
                sqrtPriceLimitX96: !tokenIsZero ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
        vm.stopPrank();

        uint256 expectedFee = (100e6 * 100) / 10_000;
        uint256 creatorShare = hook.claimable(creator, quoteCurrency);
        uint256 treasuryShare = hook.claimable(treasury, quoteCurrency);
        assertEq(creatorShare + treasuryShare, expectedFee, "1% of the buy");
        assertEq(creatorShare, expectedFee / 2, "half to the creator");
    }

    // --- safety ------------------------------------------------------------

    /// Liquidity is locked by construction: the factory owns the position and
    /// has no function that removes it. There is nothing to rug.
    function testFactoryExposesNoWayToRemoveLiquidity() public {
        _launch();
        // modifyLiquidity is only ever reached through unlockCallback, and
        // that is callable by the PoolManager alone.
        vm.expectRevert(ArcodianLaunchFactoryV12.NotPoolManager.selector);
        factory.unlockCallback("");
    }

    function testHookFactoryCannotBeReassigned() public {
        vm.expectRevert(ArcodianLaunchHook.FactoryAlreadySet.selector);
        hook.setFactory(address(0xBAD));
    }

    function testOnlyTheDeployerCouldEverSetTheFactory() public {
        address flagged = address(uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) | uint160(0x5555 << 20));
        deployCodeTo("ArcodianLaunchHook.sol:ArcodianLaunchHook", abi.encode(manager, address(0), treasury), flagged);
        vm.prank(address(0xBAD));
        vm.expectRevert(ArcodianLaunchHook.NotDeployer.selector);
        ArcodianLaunchHook(flagged).setFactory(address(0xBAD));
    }

    function testRejectsBadMetadata() public {
        vm.expectRevert(ArcodianLaunchFactoryV12.BadMetadata.selector);
        factory.createLaunch("Arc Bee", "A", "");
    }

    function testTwoLaunchesGetSeparatePools() public {
        (PumpToken first,) = _launch();
        vm.prank(address(0xD00D));
        (address second,) = factory.createLaunch("Second", "SEC", "");
        assertTrue(PoolId.unwrap(factory.poolForToken(address(first))) != PoolId.unwrap(factory.poolForToken(second)));
        assertEq(factory.launchCount(), 2);
    }
}
