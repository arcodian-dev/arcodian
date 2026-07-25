// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ArcAgentPayV3,IArcPayAgent,IAgentPassport} from "./ArcAgentPayV3.sol";

/// @notice Permissionless factory creating one isolated identity-aware Agent Pay vault per owner.
contract ArcAgentPayFactoryV3 {
    IArcPayAgent public immutable arcPay;
    IAgentPassport public immutable passport;
    mapping(address=>address) public vaultOf;
    address[] public allVaults;
    error Invalid(); error VaultExists();
    event VaultCreated(address indexed owner,address indexed vault,uint256 initialFunding);
    constructor(IArcPayAgent arcPay_,IAgentPassport passport_){if(address(arcPay_)==address(0)||address(passport_)==address(0))revert Invalid();arcPay=arcPay_;passport=passport_;}
    function createVault() external payable returns(address vault){
        if(vaultOf[msg.sender]!=address(0))revert VaultExists();
        ArcAgentPayV3 created=new ArcAgentPayV3(msg.sender,arcPay,passport);vault=address(created);
        vaultOf[msg.sender]=vault;allVaults.push(vault);
        if(msg.value!=0){(bool ok,)=payable(vault).call{value:msg.value}("");if(!ok)revert Invalid();}
        emit VaultCreated(msg.sender,vault,msg.value);
    }
    function vaultCount() external view returns(uint256){return allVaults.length;}
}
