// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPassport { function agentIdOf(address wallet) external view returns (uint256); }

/// @notice Catalog of pay-per-call agent services, each bound to an ERC-8004 agentId via the passport.
contract ArcServiceRegistry {
    struct Service {
        address provider;
        uint256 agentId;
        uint256 price;        // native USDC (18 decimals) per call
        string endpointURI;
        string metadataURI;
        bool active;
    }

    IPassport public immutable passport;
    mapping(bytes32 => Service) private services;
    uint256 public nonce;

    error NoAgentId();
    error NotProvider();
    error NotFound();
    error ZeroPrice();

    event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, uint256 indexed agentId, uint256 price, string endpointURI, string metadataURI);
    event ServiceUpdated(bytes32 indexed serviceId, uint256 price, string endpointURI, string metadataURI);
    event ServiceDeactivated(bytes32 indexed serviceId);

    constructor(address passport_) { passport = IPassport(passport_); }

    function registerService(uint256 price, string calldata endpointURI, string calldata metadataURI)
        external returns (bytes32 serviceId)
    {
        if (price == 0) revert ZeroPrice();
        uint256 agentId = passport.agentIdOf(msg.sender);
        if (agentId == 0) revert NoAgentId();
        serviceId = keccak256(abi.encode(msg.sender, agentId, ++nonce));
        services[serviceId] = Service(msg.sender, agentId, price, endpointURI, metadataURI, true);
        emit ServiceRegistered(serviceId, msg.sender, agentId, price, endpointURI, metadataURI);
    }

    function updateService(bytes32 serviceId, uint256 price, string calldata endpointURI, string calldata metadataURI) external {
        Service storage s = services[serviceId];
        if (s.provider == address(0)) revert NotFound();
        if (s.provider != msg.sender) revert NotProvider();
        if (price == 0) revert ZeroPrice();
        s.price = price; s.endpointURI = endpointURI; s.metadataURI = metadataURI;
        emit ServiceUpdated(serviceId, price, endpointURI, metadataURI);
    }

    function deactivateService(bytes32 serviceId) external {
        Service storage s = services[serviceId];
        if (s.provider == address(0)) revert NotFound();
        if (s.provider != msg.sender) revert NotProvider();
        s.active = false;
        emit ServiceDeactivated(serviceId);
    }

    function getService(bytes32 serviceId) external view returns (Service memory) { return services[serviceId]; }
}
