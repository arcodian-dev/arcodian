// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArcPay
/// @notice Exact-value native USDC settlement for Arc merchant invoices.
/// @dev Arc represents native USDC with 18 native decimals. No funds remain
///      custodied after a successful payment or refund.
contract ArcPay {
    uint16 public constant FEE_BPS = 30; // 0.30%
    uint16 public constant BPS = 10_000;
    uint64 public constant MAX_EXPIRY_WINDOW = 30 days;

    address payable public immutable treasury;
    uint256 public accruedFees;
    uint256 private unlocked = 1;

    struct Payment {
        address payer;
        address merchant;
        uint128 amount;
        uint128 fee;
        uint64 paidAt;
        bool refunded;
    }

    mapping(bytes32 => Payment) public payments;

    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed payer,
        address indexed merchant,
        uint256 grossAmount,
        uint256 merchantAmount,
        uint256 protocolFee,
        bytes32 memoHash
    );
    event PaymentRefunded(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 amount);
    event ProtocolFeesWithdrawn(address indexed treasury, uint256 amount);

    error Reentrancy();
    error ZeroAddress();
    error InvalidAmount();
    error InvalidExpiry();
    error InvoiceAlreadyPaid();
    error WrongPayer();
    error MerchantOnly();
    error AlreadyRefunded();
    error TransferFailed();
    error TreasuryOnly();

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address payable treasury_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
    }

    function quoteFee(uint256 amount) public pure returns (uint256) {
        if (amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        return (amount * FEE_BPS + BPS - 1) / BPS;
    }

    /// @param expectedPayer Zero permits any payer; otherwise only that address may settle.
    function pay(
        bytes32 invoiceId,
        address payable merchant,
        uint256 amount,
        uint64 expiresAt,
        address expectedPayer,
        bytes32 memoHash
    ) external payable nonReentrant {
        if (merchant == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > type(uint128).max || msg.value != amount) revert InvalidAmount();
        if (expiresAt < block.timestamp || expiresAt > block.timestamp + MAX_EXPIRY_WINDOW) revert InvalidExpiry();
        if (payments[invoiceId].payer != address(0)) revert InvoiceAlreadyPaid();
        if (expectedPayer != address(0) && expectedPayer != msg.sender) revert WrongPayer();

        uint256 fee = quoteFee(amount);
        uint256 merchantAmount = amount - fee;
        payments[invoiceId] = Payment({
            payer: msg.sender,
            merchant: merchant,
            amount: uint128(amount),
            fee: uint128(fee),
            paidAt: uint64(block.timestamp),
            refunded: false
        });
        accruedFees += fee;

        (bool merchantOk,) = merchant.call{value: merchantAmount}("");
        if (!merchantOk) revert TransferFailed();

        emit InvoicePaid(invoiceId, msg.sender, merchant, amount, merchantAmount, fee, memoHash);
    }

    function withdrawProtocolFees() external nonReentrant {
        if (msg.sender != treasury) revert TreasuryOnly();
        uint256 amount = accruedFees;
        if (amount == 0) revert InvalidAmount();
        accruedFees = 0;
        (bool ok,) = treasury.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ProtocolFeesWithdrawn(treasury, amount);
    }

    /// @notice Refunds the payer in full. The merchant funds the gross refund;
    ///         the already-settled protocol fee is not pulled back from treasury.
    function refund(bytes32 invoiceId) external payable nonReentrant {
        Payment storage payment = payments[invoiceId];
        if (payment.payer == address(0)) revert InvalidAmount();
        if (msg.sender != payment.merchant) revert MerchantOnly();
        if (payment.refunded) revert AlreadyRefunded();
        if (msg.value != payment.amount) revert InvalidAmount();

        payment.refunded = true;
        (bool ok,) = payable(payment.payer).call{value: msg.value}("");
        if (!ok) revert TransferFailed();
        emit PaymentRefunded(invoiceId, msg.sender, payment.payer, msg.value);
    }
}
