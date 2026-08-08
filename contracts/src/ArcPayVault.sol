// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Non-custodial prepaid-credit payment vault. A payer deposits native USDC, allocates to a
/// provider, and signs EIP-712 `Voucher{payer,provider,cumulative}` off-chain (cumulative monotonic).
/// The provider redeems the latest voucher on-chain; fee to FEE_TREASURY. Funds can only leave to a
/// provider that holds the payer's voucher, capped by that payer's allocation to it.
contract ArcPayVault {
    struct Sub { uint256 allocated; uint256 redeemed; uint64 deallocateAt; }

    address payable public immutable feeTreasury;
    uint16 public immutable feeBps;              // 50 = 0.50%
    uint16 public constant BPS = 10_000;
    uint64 public constant CHALLENGE_WINDOW = 1 days;

    mapping(address => uint256) public freeBalance;              // payer => unallocated deposit
    mapping(address => mapping(address => Sub)) public subs;     // payer => provider => sub-channel

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 private constant VOUCHER_TYPEHASH = keccak256("Voucher(address payer,address provider,uint256 cumulative)");

    error ZeroValue();
    error InsufficientFree();
    error BadSignature();
    error ExceedsAllocated();
    error NotIncreasing();
    error TransferFailed();
    error DeallocateNotReady();
    error NoRequest();

    event Deposited(address indexed payer, uint256 amount, uint256 freeBalance);
    event Allocated(address indexed payer, address indexed provider, uint256 amount, uint256 allocated);
    event Redeemed(address indexed provider, address indexed payer, uint256 cumulative, uint256 paid, uint256 fee);
    event FreeWithdrawn(address indexed payer, uint256 amount);
    event DeallocateRequested(address indexed payer, address indexed provider, uint64 readyAt);
    event Deallocated(address indexed payer, address indexed provider, uint256 returned);

    constructor(address payable feeTreasury_, uint16 feeBps_) {
        feeTreasury = feeTreasury_;
        feeBps = feeBps_;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("AgentRail")), keccak256(bytes("1")), block.chainid, address(this)
        ));
    }

    function deposit() external payable {
        if (msg.value == 0) revert ZeroValue();
        freeBalance[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, freeBalance[msg.sender]);
    }

    function allocate(address provider, uint256 amount) external {
        if (amount == 0) revert ZeroValue();
        if (freeBalance[msg.sender] < amount) revert InsufficientFree();
        freeBalance[msg.sender] -= amount;
        Sub storage s = subs[msg.sender][provider];
        s.allocated += amount;
        s.deallocateAt = 0; // re-allocating cancels a pending reclaim
        emit Allocated(msg.sender, provider, amount, s.allocated);
    }

    function _digest(address payer, address provider, uint256 cumulative) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, payer, provider, cumulative));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(digest, v, r, s);
    }

    /// @notice Provider (msg.sender) redeems the payer's latest voucher for this provider.
    function redeem(address payer, uint256 cumulative, bytes calldata signature) external {
        Sub storage sub = subs[payer][msg.sender];
        if (cumulative > sub.allocated) revert ExceedsAllocated();
        if (cumulative <= sub.redeemed) revert NotIncreasing();
        address signer = _recover(_digest(payer, msg.sender, cumulative), signature);
        if (signer == address(0) || signer != payer) revert BadSignature();

        uint256 pay = cumulative - sub.redeemed;
        sub.redeemed = cumulative;
        uint256 fee = (pay * feeBps) / BPS;
        uint256 providerAmount = pay - fee;
        (bool ok1,) = payable(msg.sender).call{value: providerAmount}("");
        if (!ok1) revert TransferFailed();
        if (fee > 0) { (bool ok2,) = feeTreasury.call{value: fee}(""); if (!ok2) revert TransferFailed(); }
        emit Redeemed(msg.sender, payer, cumulative, providerAmount, fee);
    }

    function withdrawFree(uint256 amount) external {
        if (amount == 0) revert ZeroValue();
        if (freeBalance[msg.sender] < amount) revert InsufficientFree();
        freeBalance[msg.sender] -= amount;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FreeWithdrawn(msg.sender, amount);
    }

    function requestDeallocate(address provider) external {
        Sub storage s = subs[msg.sender][provider];
        s.deallocateAt = uint64(block.timestamp) + CHALLENGE_WINDOW;
        emit DeallocateRequested(msg.sender, provider, s.deallocateAt);
    }

    function finalizeDeallocate(address provider) external {
        Sub storage s = subs[msg.sender][provider];
        if (s.deallocateAt == 0) revert NoRequest();
        if (block.timestamp < s.deallocateAt) revert DeallocateNotReady();
        uint256 remaining = s.allocated - s.redeemed;
        s.allocated = s.redeemed;   // no headroom left for new vouchers
        s.deallocateAt = 0;
        freeBalance[msg.sender] += remaining;
        emit Deallocated(msg.sender, provider, remaining);
    }
}
