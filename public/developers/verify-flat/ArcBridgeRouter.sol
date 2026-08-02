// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// src/ArcBridgeRouter.sol

interface IERC20Bridge {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ITokenMessengerV2 {
    // The real mainnet TokenMessengerV2.depositForBurn returns nothing
    // (verified against the deployed, verified implementation's own ABI —
    // CCTP v2 dropped the nonce return that v1 had). Declaring `returns
    // (uint64 nonce)` here, as an earlier version of this file did, makes
    // Solidity try to ABI-decode a uint64 out of empty return data — which
    // reverts unconditionally, after the burn has already happened. Every
    // route on every deployed instance of this router failed this way until
    // fixed; there is no working nonce to recover from the call itself.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

/// @title ArcBridgeRouter
/// @notice Atomically charges the Arcodian bridge fee and starts a CCTP V2 burn.
/// @dev One immutable instance is deployed per source chain and token.
contract ArcBridgeRouter {
    uint16 public constant FEE_BPS = 150;
    uint16 public constant BPS = 10_000;

    IERC20Bridge public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;
    address public immutable treasury;

    uint256 private unlocked = 1;

    event BridgeStarted(
        address indexed sender,
        bytes32 indexed mintRecipient,
        uint32 indexed destinationDomain,
        uint256 grossAmount,
        uint256 protocolFee,
        uint256 burnAmount
    );

    error ZeroAddress();
    error InvalidAmount();
    error FeeConsumesAmount();
    error TokenTransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address usdc_, address tokenMessenger_, address treasury_) {
        if (usdc_ == address(0) || tokenMessenger_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20Bridge(usdc_);
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        treasury = treasury_;
    }

    function quote(uint256 grossAmount) public pure returns (uint256 protocolFee, uint256 burnAmount) {
        if (grossAmount == 0) revert InvalidAmount();
        protocolFee = (grossAmount * FEE_BPS + BPS - 1) / BPS;
        if (protocolFee >= grossAmount) revert FeeConsumesAmount();
        burnAmount = grossAmount - protocolFee;
    }

    function bridge(
        uint256 grossAmount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external nonReentrant {
        (uint256 protocolFee, uint256 burnAmount) = quote(grossAmount);
        if (!_transferFrom(msg.sender, address(this), grossAmount)) revert TokenTransferFailed();
        if (!_transfer(treasury, protocolFee)) revert TokenTransferFailed();
        if (!_approve(address(tokenMessenger), 0)) revert TokenTransferFailed();
        if (!_approve(address(tokenMessenger), burnAmount)) revert TokenTransferFailed();

        tokenMessenger.depositForBurn(
            burnAmount,
            destinationDomain,
            mintRecipient,
            address(usdc),
            bytes32(0),
            maxFee,
            minFinalityThreshold
        );
        emit BridgeStarted(
            msg.sender,
            mintRecipient,
            destinationDomain,
            grossAmount,
            protocolFee,
            burnAmount
        );
    }

    function _transferFrom(address from, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeCall(IERC20Bridge.transferFrom, (from, to, amount)));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _transfer(address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeCall(IERC20Bridge.transfer, (to, amount)));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _approve(address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeCall(IERC20Bridge.approve, (spender, amount)));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }
}

