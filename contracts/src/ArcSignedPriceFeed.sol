// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPyth} from "./ArcStockMarket.sol";

/// @title ArcSignedPriceFeed
/// @notice Arcodian's own stock price oracle, shaped like the slice of Pyth
/// that ArcStockMarket uses (getUpdateFee / updatePriceFeeds /
/// getPriceNoOlderThan), so the market runs on it unchanged and can move back
/// to Pyth by pointing a market at Pyth instead.
///
/// Prices are signed off-chain by one authorized signer: Arcodian's price
/// service, which takes the median of several independent public quotes and
/// only signs when they agree. Updates ride along with each trade exactly like
/// Pyth updates do. The trust assumption is that signer key — whoever holds it
/// can post any price — which is why the market's per-stock caps stay small.
contract ArcSignedPriceFeed {
    /// Domain tag hashed into every signed price, so a signature can never be
    /// replayed as anything else.
    bytes32 public constant PRICE_TYPEHASH = keccak256("ArcodianPrice(uint256 chainId,address feed,bytes32 id,int64 price,uint64 conf,int32 expo,uint64 publishTime)");
    /// A signed price may be at most this far ahead of the block clock.
    uint256 public constant MAX_FUTURE_SKEW = 10;
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public admin;
    address public signer;
    mapping(bytes32 => IPyth.Price) private latest;

    event SignerSet(address signer);
    event AdminSet(address admin);
    event PriceUpdated(bytes32 indexed id, int64 price, uint64 conf, int32 expo, uint64 publishTime);

    error Unauthorized();
    error BadSignature();
    error FromFuture();
    error PriceFeedNotFound();
    error StalePrice();

    constructor(address admin_, address signer_) {
        if (admin_ == address(0) || signer_ == address(0)) revert Unauthorized();
        admin = admin_;
        signer = signer_;
        emit AdminSet(admin_);
        emit SignerSet(signer_);
    }

    // --- Pyth-shaped interface ---------------------------------------------

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    /// @notice Each update is abi.encode(id, price, conf, expo, publishTime, v, r, s).
    /// Older-than-stored updates are skipped rather than reverting, so two
    /// trades racing with the same bundle both go through.
    function updatePriceFeeds(bytes[] calldata updates) external payable {
        for (uint256 i; i < updates.length; i++) {
            (bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime, uint8 v, bytes32 r, bytes32 s) =
                abi.decode(updates[i], (bytes32, int64, uint64, int32, uint64, uint8, bytes32, bytes32));
            if (publishTime > block.timestamp + MAX_FUTURE_SKEW) revert FromFuture();
            if (price <= 0) revert BadSignature();
            if (_recover(digest(id, price, conf, expo, publishTime), v, r, s) != signer) revert BadSignature();
            if (publishTime <= latest[id].publishTime) continue;
            latest[id] = IPyth.Price(price, conf, expo, publishTime);
            emit PriceUpdated(id, price, conf, expo, publishTime);
        }
        if (msg.value > 0) {
            (bool ok,) = msg.sender.call{value: msg.value}("");
            if (!ok) revert Unauthorized();
        }
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (IPyth.Price memory p) {
        p = latest[id];
        if (p.publishTime == 0) revert PriceFeedNotFound();
        if (block.timestamp > p.publishTime && block.timestamp - p.publishTime > age) revert StalePrice();
    }

    function getPriceUnsafe(bytes32 id) external view returns (IPyth.Price memory p) {
        p = latest[id];
        if (p.publishTime == 0) revert PriceFeedNotFound();
    }

    // --- signing -----------------------------------------------------------

    /// @notice The EIP-191 digest the signer signs for one price.
    function digest(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(PRICE_TYPEHASH, block.chainid, address(this), id, price, conf, expo, publishTime));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    function _recover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) private pure returns (address who) {
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) revert BadSignature();
        who = ecrecover(hash, v, r, s);
        if (who == address(0)) revert BadSignature();
    }

    // --- admin -------------------------------------------------------------

    function setSigner(address next) external {
        if (msg.sender != admin) revert Unauthorized();
        if (next == address(0)) revert Unauthorized();
        signer = next;
        emit SignerSet(next);
    }

    function setAdmin(address next) external {
        if (msg.sender != admin) revert Unauthorized();
        if (next == address(0)) revert Unauthorized();
        admin = next;
        emit AdminSet(next);
    }
}
