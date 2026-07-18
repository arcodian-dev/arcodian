// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./ArcFxPool.sol";

interface IArcFxPool {
    function swap(bool usdcToEurc, uint256 amountIn, uint256 minOut, uint64 deadline) external returns (uint256);
}

interface IArcPumpCurveEurc {
    function buy(uint256 quoteIn, uint256 minTokensOut, uint64 deadline) external returns (uint256);
    function token() external view returns (address);
}

/// @notice Atomic cross-currency buy: USDC -> EURC (via ArcFxPool) -> EURC-quoted
/// bonding curve. Either the caller receives tokens or the whole transaction
/// reverts and they keep their USDC. There is no state in which a caller is left
/// holding EURC they did not ask for — that is the sole reason this contract
/// exists, since a multi-transaction frontend flow cannot guarantee it.
///
/// Immutable and ownerless by design. Callers grant this contract a USDC
/// allowance, so it deliberately has no owner, no withdraw, no pause and no
/// upgrade path: nobody, including the deployer, can move a user's funds.
///
/// All amounts are 6-decimal throughout (ArcFxPool, EURC, and the curve's
/// quoteIn are all 6-dec). The 18-decimal native USDC interface is never used here.
contract ArcCrossBuyRouter {
    IERC20 public immutable usdc;
    IERC20 public immutable eurc;
    IArcFxPool public immutable fxPool;
    bool private locked;

    event CrossBought(
        address indexed buyer, address indexed curve, uint256 usdcIn, uint256 eurcMid, uint256 tokensOut
    );

    modifier nonReentrant() {
        require(!locked, "REENTRANCY");
        locked = true;
        _;
        locked = false;
    }

    constructor(IArcFxPool fxPool_, IERC20 usdc_, IERC20 eurc_) {
        require(
            address(fxPool_) != address(0) && address(usdc_) != address(0) && address(eurc_) != address(0),
            "ZERO_ADDRESS"
        );
        fxPool = fxPool_;
        usdc = usdc_;
        eurc = eurc_;
    }

    /// @param curve         An ArcPumpCurveEurc to buy from.
    /// @param usdcIn        USDC to spend, 6 decimals.
    /// @param minTokensOut  Slippage bound on the FINAL token output. Checked once,
    ///                      at the end. The intermediate FX leg passes minOut = 0
    ///                      deliberately: the mid-leg EURC is not user-visible value,
    ///                      and this end-to-end bound already constrains the whole
    ///                      route. Do not "fix" this into a two-stage check.
    /// @param deadline      Applies to both legs.
    function buyWithUsdc(address curve, uint256 usdcIn, uint256 minTokensOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        require(usdcIn > 0, "ZERO_IN");
        require(minTokensOut > 0, "NO_MIN");

        require(usdc.transferFrom(msg.sender, address(this), usdcIn), "USDC_IN");
        require(usdc.approve(address(fxPool), usdcIn), "USDC_APPROVE");
        uint256 eurcMid = fxPool.swap(true, usdcIn, 0, deadline);
        require(eurcMid > 0, "NO_FX_OUT");

        IERC20 outToken = IERC20(IArcPumpCurveEurc(curve).token());
        uint256 balBefore = outToken.balanceOf(address(this));

        require(eurc.approve(curve, eurcMid), "EURC_APPROVE");
        IArcPumpCurveEurc(curve).buy(eurcMid, minTokensOut, deadline);

        tokensOut = outToken.balanceOf(address(this)) - balBefore;
        require(tokensOut >= minTokensOut, "SLIPPAGE");
        require(outToken.transfer(msg.sender, tokensOut), "TOKEN_OUT");

        _sweep(usdc, msg.sender);
        _sweep(eurc, msg.sender);

        emit CrossBought(msg.sender, curve, usdcIn, eurcMid, tokensOut);
    }

    /// @dev Rounding dust never stays in the router; it goes back to the caller
    /// in the same transaction.
    function _sweep(IERC20 t, address to) private {
        uint256 bal = t.balanceOf(address(this));
        if (bal > 0) require(t.transfer(to, bal), "SWEEP");
    }
}
