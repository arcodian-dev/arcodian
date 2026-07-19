// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGraduationAuthority} from "./ArcPairFactoryV2.sol";

/// @notice One graduation authority standing in front of several pump factories.
///
/// ArcPairFactoryV2 accepts exactly one authority, set once and then frozen —
/// deliberately, so nobody can hand the privilege elsewhere later. That leaves
/// no room for a second launchpad: the USDC factory took the slot, and the EURC
/// factory had nowhere to register.
///
/// The hub takes the slot instead and answers on behalf of every member. Adding
/// a quote currency later means registering a member here, not redeploying the
/// pair registry — which matters because the registry accumulates pools, and a
/// second registry would split liquidity and routing in two.
///
/// The deployer registers members and then seals. After `seal()` the membership
/// is immutable and the deployer has no remaining privilege. Sealing is what
/// makes the hub safe: an unsealed hub could admit a hostile "factory" that
/// claims any address is one of its curves, which would hand that address the
/// power to open graduation pairs.
contract ArcGraduationHub {
    address private immutable deployer;
    bool public sealed_;

    address[] public members;
    mapping(address => bool) public isMember;

    event MemberRegistered(address indexed member);
    event Sealed(uint256 memberCount);

    constructor() {
        deployer = msg.sender;
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    function register(address member) external {
        require(msg.sender == deployer, "NOT_DEPLOYER");
        require(!sealed_, "SEALED");
        require(member != address(0), "ZERO_MEMBER");
        require(!isMember[member], "ALREADY_MEMBER");
        isMember[member] = true;
        members.push(member);
        emit MemberRegistered(member);
    }

    /// One-way. Requires at least one member so a hub cannot be sealed empty,
    /// which would permanently disable graduation for the registry it fronts.
    function seal() external {
        require(msg.sender == deployer, "NOT_DEPLOYER");
        require(!sealed_, "SEALED");
        require(members.length > 0, "NO_MEMBERS");
        sealed_ = true;
        emit Sealed(members.length);
    }

    /// Reserved if ANY member still runs a curve for this token.
    ///
    /// A member that reverts is read as "no opinion" rather than propagating the
    /// failure: one broken factory must not be able to freeze pair creation for
    /// every token on the exchange. ArcPairFactoryV2 makes the same choice one
    /// level up, for the same reason.
    function isUngraduatedLaunchToken(address token) external view returns (bool) {
        uint256 length = members.length;
        for (uint256 i = 0; i < length; ++i) {
            try IGraduationAuthority(members[i]).isUngraduatedLaunchToken(token) returns (bool reserved) {
                if (reserved) return true;
            } catch {}
        }
        return false;
    }

    /// A curve of ANY member. Failure is read as "not a curve" — here that
    /// denies access rather than granting it, so the safe default is the same.
    function isCurve(address account) external view returns (bool) {
        uint256 length = members.length;
        for (uint256 i = 0; i < length; ++i) {
            try IGraduationAuthority(members[i]).isCurve(account) returns (bool result) {
                if (result) return true;
            } catch {}
        }
        return false;
    }
}
