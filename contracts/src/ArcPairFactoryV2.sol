// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./ArcFxPool.sol";
import {ArcPair} from "./ArcPair.sol";

interface IGraduationAuthority {
    /// True while `token` belongs to a launch whose curve has not graduated.
    function isUngraduatedLaunchToken(address token) external view returns (bool);
    /// True if `account` is a curve this authority deployed.
    function isCurve(address account) external view returns (bool);
}

/// @notice Deploys and registers ArcPair markets.
///
/// Same as ArcPairFactory, plus one rule: while a launchpad token's curve is
/// still running, only that curve may open its pair.
///
/// Without that rule graduation is stealable. The pair address is fixed by
/// (token, quote, tier), so anyone could buy the token, create the pair first,
/// seed it at an absurd ratio, and wait. At graduation `addLiquidity` credits
/// `min(by0, by1)` — the curve would deposit both sides in full, be credited on
/// the bad ratio, and the difference would be absorbed into the pool and shared
/// with whoever already held shares. Refusing the deposit afterwards only turns
/// theft into griefing; refusing the *creation* removes the position entirely.
///
/// Ownership note: this contract has no owner, but `graduationAuthority` cannot
/// be an immutable, because the authority needs this factory's address in its
/// own constructor. It is set exactly once by the deployer and is permanently
/// frozen afterwards. Until it is set, no token is reserved and the factory
/// behaves exactly like the permissionless one.
contract ArcPairFactoryV2 {
    address public immutable treasury;
    address private immutable deployer;

    address public graduationAuthority;

    mapping(address => mapping(address => mapping(uint16 => address))) private pairs;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, uint16 feeBps, address pair);
    event GraduationAuthoritySet(address indexed authority);

    constructor(address treasury_) {
        require(treasury_ != address(0), "ZERO_TREASURY");
        treasury = treasury_;
        deployer = msg.sender;
    }

    /// One-time and self-locking. After this call the deployer has no remaining
    /// privilege of any kind over this contract.
    function setGraduationAuthority(address authority) external {
        require(msg.sender == deployer, "NOT_DEPLOYER");
        require(graduationAuthority == address(0), "ALREADY_SET");
        require(authority != address(0), "ZERO_AUTHORITY");
        graduationAuthority = authority;
        emit GraduationAuthoritySet(authority);
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function getPair(address tokenA, address tokenB, uint16 feeBps) public view returns (address) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return pairs[t0][t1][feeBps];
    }

    /// True while the token's pair may only be opened by its own curve.
    function isReserved(address token) public view returns (bool) {
        address authority = graduationAuthority;
        if (authority == address(0)) return false;
        // A malfunctioning authority must not be able to freeze pair creation
        // for every token, so a failed call is read as "not reserved".
        try IGraduationAuthority(authority).isUngraduatedLaunchToken(token) returns (bool reserved) {
            return reserved;
        } catch {
            return false;
        }
    }

    function createPair(address tokenA, address tokenB, uint16 feeBps) external returns (address pair) {
        require(!isReserved(tokenA) && !isReserved(tokenB), "RESERVED_UNTIL_GRADUATION");
        return _create(tokenA, tokenB, feeBps);
    }

    /// Graduation path. Callable only by a curve deployed by the authority, and
    /// only for its own token — a curve cannot open a pair for someone else's.
    function createGraduationPair(address tokenA, address tokenB, uint16 feeBps) external returns (address pair) {
        address authority = graduationAuthority;
        require(authority != address(0), "NO_AUTHORITY");
        require(IGraduationAuthority(authority).isCurve(msg.sender), "NOT_A_CURVE");
        return _create(tokenA, tokenB, feeBps);
    }

    function _create(address tokenA, address tokenB, uint16 feeBps) private returns (address pair) {
        require(tokenA != tokenB, "IDENTICAL");
        require(tokenA != address(0) && tokenB != address(0), "ZERO_ADDRESS");
        require(feeBps == 10 || feeBps == 30, "BAD_FEE_TIER");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(pairs[t0][t1][feeBps] == address(0), "PAIR_EXISTS");

        pair = address(new ArcPair(IERC20(t0), IERC20(t1), feeBps, treasury));
        pairs[t0][t1][feeBps] = pair;
        allPairs.push(pair);

        emit PairCreated(t0, t1, feeBps, pair);
    }
}
