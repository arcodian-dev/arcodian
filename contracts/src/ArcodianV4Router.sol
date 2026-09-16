// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @notice Exact-input swaps and quotes against Uniswap V4 pools, for
/// arcodian.fun's own trade flow.
///
/// V12 launches trade in V4 pools, and nothing on arcodian.fun could trade
/// V4: the swap surface and both terminals understood bonding curves and V3
/// pools only. External bots could buy a V12 coin; its own launchpad could
/// not. This closes that.
///
/// Why a small router of our own rather than the Universal Router, which does
/// exist on Arc: the Universal Router wants Permit2 approvals and a
/// command-encoded payload, which is two signatures and a fragile encoding in
/// the browser. This takes one ordinary ERC-20 approval, reverts on slippage
/// and on an expired deadline, and quotes by running the real swap and
/// reverting with the result — so the quote includes the launch hook's 1%
/// exactly as the trade will, instead of approximating it.
///
/// It holds nothing between calls. Every token it touches arrives and leaves
/// inside the same unlock.
contract ArcodianV4Router is IUnlockCallback {
    IPoolManager public immutable poolManager;

    error NotPoolManager();
    error Expired();
    error TooLittleReceived(uint256 received, uint256 minimum);
    error QuoteResult(uint256 amountOut);
    error TransferFailed();

    struct Call {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        uint256 minOut;
        address payer;
        address recipient;
        bool quoteOnly;
    }

    constructor(IPoolManager poolManager_) {
        require(address(poolManager_) != address(0), "ZERO");
        poolManager = poolManager_;
    }

    /// @notice Swap exactly `amountIn` of the input currency.
    /// @dev The caller must have approved this router for `amountIn` of the
    /// input token. Output goes to the caller.
    function swapExactInputSingle(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        returns (uint256 amountOut)
    {
        if (block.timestamp > deadline) revert Expired();
        bytes memory result = poolManager.unlock(abi.encode(Call(key, zeroForOne, amountIn, minOut, msg.sender, msg.sender, false)));
        amountOut = abi.decode(result, (uint256));
    }

    /// @notice What `swapExactInputSingle` would return right now.
    /// @dev Not a view: it runs the real swap inside an unlock and reverts
    /// with the output, so hooks, fees and price impact are all included.
    /// Call it with eth_call.
    function quoteExactInputSingle(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external returns (uint256 amountOut) {
        try poolManager.unlock(abi.encode(Call(key, zeroForOne, amountIn, 0, address(0), address(0), true))) {
            revert("NO_QUOTE");
        } catch (bytes memory reason) {
            if (reason.length == 36 && bytes4(reason) == QuoteResult.selector) {
                assembly {
                    amountOut := mload(add(reason, 36))
                }
            } else {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Call memory call = abi.decode(data, (Call));

        BalanceDelta delta = poolManager.swap(
            call.key,
            SwapParams({
                zeroForOne: call.zeroForOne,
                amountSpecified: -int256(call.amountIn),
                sqrtPriceLimitX96: call.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // Signs are from this router's side of the swap: negative is owed to
        // the pool, positive is owed to us. A hook's returned delta is already
        // folded in, so `paid` is the full input including the 1% fee.
        int128 inputDelta = call.zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = call.zeroForOne ? delta.amount1() : delta.amount0();
        uint256 paid = uint256(uint128(-inputDelta));
        uint256 received = uint256(uint128(outputDelta));

        if (call.quoteOnly) revert QuoteResult(received);
        if (received < call.minOut) revert TooLittleReceived(received, call.minOut);

        Currency input = call.zeroForOne ? call.key.currency0 : call.key.currency1;
        Currency output = call.zeroForOne ? call.key.currency1 : call.key.currency0;

        poolManager.sync(input);
        _transferFrom(Currency.unwrap(input), call.payer, address(poolManager), paid);
        poolManager.settle();
        poolManager.take(output, call.recipient, received);
        return abi.encode(received);
    }

    function _transferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
