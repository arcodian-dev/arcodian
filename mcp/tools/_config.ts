// On-chain constants for the MCP tools. Self-contained ON PURPOSE: the MCP server
// runs under raw `node` (type-stripping), which cannot load `src/config.ts` — that
// module uses Vite-only `import.meta.env`. These are frozen Arc-testnet deployments;
// mirror of src/config.ts. Keep addresses/ABIs in sync with src/config.ts if they change.

export const ARC = {
  id: 5042002,
  hexId: "0x4cef52",
  explorer: "https://testnet.arcscan.app",
  nativeToken: "0x3600000000000000000000000000000000000000",
} as const;

export const IDENTITY_REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const IDENTITY_REGISTRY_ABI = ["function register(string metadataURI) returns(uint256)","function ownerOf(uint256) view returns(address)","function tokenURI(uint256) view returns(string)","event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"];

export const AGENT_JOBS_ADDRESS = "0x3ceb2eb2fdf41396e20cc55b9096933d208ba8a6";
export const AGENT_JOBS_ABI = ["function createJob(address provider,address evaluator,uint64 expiry,bytes32 descHash,uint256 providerAgentId) payable returns(uint256)","function submit(uint256 jobId,bytes32 deliverableHash)","function evaluate(uint256 jobId,bool approve,bytes32 evidenceHash)","function reclaimExpired(uint256 jobId)","function jobs(uint256) view returns(address client,address provider,address evaluator,uint128 budget,uint64 expiry,uint8 status,bytes32 descHash,bytes32 deliverableHash,uint256 providerAgentId)","function jobCount() view returns(uint256)","function arcPay() view returns(address)","event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 budget,uint64 expiry,bytes32 descHash,uint256 providerAgentId)","event JobSubmitted(uint256 indexed jobId,bytes32 deliverableHash)","event JobCompleted(uint256 indexed jobId,address indexed provider,uint256 budget,uint256 providerAgentId,bytes32 evidenceHash)","event JobRejected(uint256 indexed jobId,address indexed client,uint256 budget,bytes32 evidenceHash)","event JobExpired(uint256 indexed jobId,address indexed client,uint256 budget)"];

export const AGENT_PAY_V3_FACTORY_ADDRESS = "0xE39bae31254C45151ABd9dC53dA3C0c92B529Ad5";
export const AGENT_PAY_V3_FACTORY_ABI = ["function arcPay() view returns(address)","function passport() view returns(address)","function vaultOf(address) view returns(address)","function vaultCount() view returns(uint256)","function createVault() payable returns(address)"];
export const AGENT_PAY_V3_VAULT_ABI = ["function owner() view returns(address)","function policies(uint256) view returns(uint128 perPayment,uint128 dailyLimit,uint128 spentToday,uint64 validUntil,uint32 spendDay,bool enabled)","function merchantAllowed(uint256,address) view returns(bool)","function setPolicy(uint256,uint128,uint128,uint64,bool)","function setMerchant(uint256,address,bool)","function payInvoice(bytes32,address,uint256,uint64,bytes32)","function withdraw(address,uint256)"];

export const REPUTATION_REGISTRY_ADDRESS = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const REPUTATION_REGISTRY_ABI = ["function getIdentityRegistry() view returns(address)","function getClients(uint256 agentId) view returns(address[])","function getLastIndex(uint256 agentId,address client) view returns(uint64)","function readFeedback(uint256 agentId,address client,uint64 index) view returns(int128 score,uint8 decimals,string tag1,string tag2,bool isRevoked)","function giveFeedback(uint256 agentId,int128 score,uint8 decimals,string tag1,string tag2,string endpoint,string fileuri,bytes32 filehash)"];

export const VALIDATION_REGISTRY_ADDRESS = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";
export const VALIDATION_REGISTRY_ABI = ["function getIdentityRegistry() view returns(address)","function getAgentValidations(uint256 agentId) view returns(bytes32[])","function getValidationStatus(bytes32 dataHash) view returns(address validator,uint256 agentId,uint8 response,uint256 lastUpdate)","function validationRequest(address validatorAddress,uint256 agentId,string requestUri,bytes32 dataHash)","function validationResponse(bytes32 dataHash,uint8 response,string responseUri,bytes32 responseHash,string tag)"];

// ArcPay settlement contract (from developers/contracts.json).
export const ARC_PAY_ADDRESS = "0x5E3d1B63213B8608539116D1C6248A36819684b5";
