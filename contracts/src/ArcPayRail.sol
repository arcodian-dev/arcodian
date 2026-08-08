// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IServiceRegistry {
    struct Service { address provider; uint256 agentId; uint256 price; string endpointURI; string metadataURI; bool active; }
    function getService(bytes32 serviceId) external view returns (Service memory);
}

/// @notice Per-call native-USDC settlement. Provider is paid before serving (no escrow); reputation
/// is the accountability layer. Fee goes to FEE_TREASURY. callId is single-use.
contract ArcPayRail {
    struct Call { address payer; bytes32 serviceId; uint256 amount; }

    IServiceRegistry public immutable registry;
    address payable public immutable feeTreasury;
    uint16 public immutable feeBps;      // 50 = 0.50%
    uint16 public constant BPS = 10_000;

    mapping(bytes32 => Call) public calls;
    uint256 public callNonce;

    error ServiceInactive();
    error WrongValue();
    error TransferFailed();

    event Paid(bytes32 indexed callId, bytes32 indexed serviceId, address indexed payer, address provider, uint256 amount, uint256 fee, uint256 timestamp);

    constructor(address registry_, address payable feeTreasury_, uint16 feeBps_) {
        registry = IServiceRegistry(registry_);
        feeTreasury = feeTreasury_;
        feeBps = feeBps_;
    }

    function pay(bytes32 serviceId) external payable returns (bytes32 callId) {
        IServiceRegistry.Service memory s = registry.getService(serviceId);
        if (!s.active) revert ServiceInactive();
        if (msg.value != s.price) revert WrongValue();

        uint256 fee = (msg.value * feeBps) / BPS;
        uint256 providerAmount = msg.value - fee;

        callId = keccak256(abi.encode(msg.sender, serviceId, ++callNonce, block.chainid));
        calls[callId] = Call(msg.sender, serviceId, msg.value);

        (bool ok1,) = payable(s.provider).call{value: providerAmount}("");
        if (!ok1) revert TransferFailed();
        if (fee > 0) {
            (bool ok2,) = feeTreasury.call{value: fee}("");
            if (!ok2) revert TransferFailed();
        }
        emit Paid(callId, serviceId, msg.sender, s.provider, providerAmount, fee, block.timestamp);
    }
}
