// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IIdentityRegistry { function ownerOf(uint256 tokenId) external view returns(address); }

/// @notice Binds an ERC-8004 agentId (owned in the official Identity Registry) to one operational agent wallet.
/// Identity itself is never re-implemented; ownership is read from the registry at bind time.
contract ArcAgentPassport {
    IIdentityRegistry public immutable identity;
    mapping(uint256=>address) public walletOf;   // agentId -> authorized wallet
    mapping(address=>uint256) public agentIdOf;   // wallet -> agentId (0 = none)
    error NotAgentOwner(); error ZeroWallet(); error WalletTaken(); error NotBound();
    event WalletBound(uint256 indexed agentId,address indexed oldWallet,address indexed newWallet,address owner);
    event WalletUnbound(uint256 indexed agentId,address indexed oldWallet,address owner);
    constructor(IIdentityRegistry identity_){identity=identity_;}
    modifier onlyAgentOwner(uint256 agentId){if(identity.ownerOf(agentId)!=msg.sender)revert NotAgentOwner();_;}
    function bindWallet(uint256 agentId,address wallet) external onlyAgentOwner(agentId){
        if(wallet==address(0))revert ZeroWallet();
        uint256 taken=agentIdOf[wallet];if(taken!=0&&taken!=agentId)revert WalletTaken();
        address old=walletOf[agentId];if(old!=address(0))agentIdOf[old]=0;
        walletOf[agentId]=wallet;agentIdOf[wallet]=agentId;
        emit WalletBound(agentId,old,wallet,msg.sender);
    }
    function unbind(uint256 agentId) external onlyAgentOwner(agentId){
        address old=walletOf[agentId];if(old==address(0))revert NotBound();
        agentIdOf[old]=0;walletOf[agentId]=address(0);
        emit WalletUnbound(agentId,old,msg.sender);
    }
    function ownerOfAgent(uint256 agentId) external view returns(address){return identity.ownerOf(agentId);}
}
