// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal testnet multisig. Owners and threshold are immutable.
contract ArcMultisig {
    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;
    uint256 public nonce;
    struct Transaction { address target; uint256 value; bytes data; uint256 confirmations; bool executed; }
    mapping(uint256 => Transaction) public transactions;
    mapping(uint256 => mapping(address => bool)) public confirmed;
    error Unauthorized(); error Invalid(); error Failed();
    event Submitted(uint256 indexed id,address indexed owner,address indexed target,uint256 value,bytes data);
    event Confirmed(uint256 indexed id,address indexed owner);
    event Executed(uint256 indexed id,bytes result);

    constructor(address[] memory owners_,uint256 threshold_){
        if(owners_.length<2||threshold_<2||threshold_>owners_.length)revert Invalid();
        for(uint256 i;i<owners_.length;i++){address owner=owners_[i];if(owner==address(0)||isOwner[owner])revert Invalid();isOwner[owner]=true;owners.push(owner);}
        threshold=threshold_;
    }
    modifier onlyOwner(){if(!isOwner[msg.sender])revert Unauthorized();_;}
    function submit(address target,uint256 value,bytes calldata data) external onlyOwner returns(uint256 id){
        if(target==address(0))revert Invalid();id=nonce++;transactions[id]=Transaction(target,value,data,1,false);confirmed[id][msg.sender]=true;emit Submitted(id,msg.sender,target,value,data);emit Confirmed(id,msg.sender);
    }
    function confirm(uint256 id) external onlyOwner {Transaction storage txn=transactions[id];if(txn.target==address(0)||txn.executed||confirmed[id][msg.sender])revert Invalid();confirmed[id][msg.sender]=true;txn.confirmations++;emit Confirmed(id,msg.sender);}
    function execute(uint256 id) external returns(bytes memory result){Transaction storage txn=transactions[id];if(txn.executed||txn.confirmations<threshold)revert Invalid();txn.executed=true;(bool ok,bytes memory output)=txn.target.call{value:txn.value}(txn.data);if(!ok)revert Failed();emit Executed(id,output);return output;}
    receive() external payable {}
}

/// @notice Multisig-controlled execution delay. Anyone may execute a mature queued action.
contract ArcTimelock {
    address public immutable admin;
    uint64 public immutable minDelay;
    mapping(bytes32=>bool) public queued;
    error Unauthorized(); error Invalid(); error Failed();
    event Queued(bytes32 indexed id,address indexed target,uint256 value,bytes data,uint64 eta);
    event Cancelled(bytes32 indexed id);
    event Executed(bytes32 indexed id,bytes result);
    constructor(address admin_,uint64 minDelay_){if(admin_==address(0)||minDelay_<1 hours)revert Invalid();admin=admin_;minDelay=minDelay_;}
    function operationId(address target,uint256 value,bytes calldata data,uint64 eta) public pure returns(bytes32){return keccak256(abi.encode(target,value,data,eta));}
    function queue(address target,uint256 value,bytes calldata data,uint64 eta) external returns(bytes32 id){if(msg.sender!=admin)revert Unauthorized();if(target==address(0)||eta<block.timestamp+minDelay)revert Invalid();id=operationId(target,value,data,eta);if(queued[id])revert Invalid();queued[id]=true;emit Queued(id,target,value,data,eta);}
    function cancel(address target,uint256 value,bytes calldata data,uint64 eta) external {if(msg.sender!=admin)revert Unauthorized();bytes32 id=operationId(target,value,data,eta);if(!queued[id])revert Invalid();delete queued[id];emit Cancelled(id);}
    function execute(address target,uint256 value,bytes calldata data,uint64 eta) external returns(bytes memory result){bytes32 id=operationId(target,value,data,eta);if(!queued[id]||block.timestamp<eta)revert Invalid();delete queued[id];(bool ok,bytes memory output)=target.call{value:value}(data);if(!ok)revert Failed();emit Executed(id,output);return output;}
    receive() external payable {}
}
