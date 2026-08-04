// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ArcAgentPayV5,IArcPayAgentV5,IAgentPassportV5} from "./ArcAgentPayV5.sol";

/// @notice Factory for additive V5 Agent Pay vaults with ERC-1271 support.
contract ArcAgentPayFactoryV5 {
    IArcPayAgentV5 public immutable arcPay;
    IAgentPassportV5 public immutable passport;
    mapping(address=>address) public vaultOf;
    address[] public allVaults;
    error Invalid(); error VaultExists();
    event VaultCreated(address indexed owner,address indexed vault,uint256 initialFunding);
    constructor(IArcPayAgentV5 arcPay_,IAgentPassportV5 passport_){if(address(arcPay_)==address(0)||address(passport_)==address(0))revert Invalid();arcPay=arcPay_;passport=passport_;}
    function createVault() external payable returns(address vault){
        if(vaultOf[msg.sender]!=address(0))revert VaultExists();
        ArcAgentPayV5 created=new ArcAgentPayV5(msg.sender,arcPay,passport);vault=address(created);vaultOf[msg.sender]=vault;allVaults.push(vault);
        if(msg.value!=0){(bool ok,)=payable(vault).call{value:msg.value}("");if(!ok)revert Invalid();}
        emit VaultCreated(msg.sender,vault,msg.value);
    }
    function vaultCount() external view returns(uint256){return allVaults.length;}
}
