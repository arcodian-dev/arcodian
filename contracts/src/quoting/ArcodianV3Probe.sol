// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUniswapV3PoolSwap {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @notice Exact quotes for any Uniswap V3 pool, without deploying anything.
///
/// This contract is never deployed. The FX desk places its runtime code at a
/// throwaway address through eth_call's state override and calls quote(): the
/// pool runs its real swap — every tick crossed, fee charged — then calls back
/// here, and the callback reverts with the output before any token moves. So
/// the quote is exactly what the same swap would pay right now, with no
/// venue-specific Quoter (the external factory on Arc has none) and no
/// single-tick approximation.
contract ArcodianV3Probe {
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// @param amountIn exact input, in the input token's own units.
    function quote(address pool, bool zeroForOne, uint256 amountIn) external returns (uint256 amountOut) {
        try IUniswapV3PoolSwap(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            ""
        ) {
            revert("NO_CALLBACK");
        } catch (bytes memory reason) {
            if (reason.length != 32) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
            amountOut = abi.decode(reason, (uint256));
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external pure {
        // The negative delta is what the pool pays out.
        uint256 out = uint256(-(amount0Delta < 0 ? amount0Delta : amount1Delta));
        assembly {
            mstore(0, out)
            revert(0, 32)
        }
    }
}
