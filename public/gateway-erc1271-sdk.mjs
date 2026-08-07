import { Contract, id, parseUnits } from "https://cdn.jsdelivr.net/npm/ethers@6.17.0/+esm";

// Circle Gateway ERC-1271 transfer helpers. These builders are intentionally
// testnet-only until Circle lists Arc Mainnet as a supported Gateway chain.
export const ARC_GATEWAY_TESTNET = {
  chainId: 5042002,
  domain: 26,
  chainName: "arcTestnet",
  apiBase: "https://gateway-api-testnet.circle.com",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
};

export const GATEWAY_ERC1271_TYPES = {
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "address" },
    { name: "destinationContract", type: "address" },
    { name: "sourceToken", type: "address" },
    { name: "destinationToken", type: "address" },
    { name: "sourceDepositor", type: "address" },
    { name: "destinationRecipient", type: "address" },
    { name: "sourceSigner", type: "address" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
};

export const GATEWAY_ERC1271_DOMAIN = {
  name: "GatewayWallet",
  version: "1",
};

const GATEWAY_MINT_ABI = ["function gatewayMint(bytes attestation,bytes signature)"];

function bytes32(value, label) {
  const result = /^0x[0-9a-fA-F]{64}$/.test(String(value)) ? String(value) : id(String(value));
  if (result.length !== 66) throw new Error(`${label} must resolve to bytes32`);
  return result;
}

function requireTestnet(chainId = ARC_GATEWAY_TESTNET.chainId) {
  if (Number(chainId) !== ARC_GATEWAY_TESTNET.chainId) {
    throw new Error("Circle Gateway ERC-1271 helper currently supports Arc Testnet only");
  }
}

export function buildGatewayBurnIntent({
  sourceDepositor,
  sourceSigner,
  destinationDomain,
  destinationContract,
  destinationToken,
  destinationRecipient,
  sourceToken,
  value,
  salt,
  hookData = "0x",
  maxBlockHeight,
  maxFee = 0,
  sourceDomain = ARC_GATEWAY_TESTNET.domain,
  sourceContract = ARC_GATEWAY_TESTNET.gatewayWallet,
  version = 1,
  chainId = ARC_GATEWAY_TESTNET.chainId,
}) {
  requireTestnet(chainId);
  if (sourceDomain !== ARC_GATEWAY_TESTNET.domain) throw new Error("sourceDomain must be Arc Testnet Gateway domain 26");
  if (!sourceDepositor || !sourceSigner || !destinationContract || !destinationToken || !destinationRecipient || !sourceToken) {
    throw new Error("Gateway transfer requires depositor, signer, contracts, tokens, and recipient");
  }
  if (maxBlockHeight == null) throw new Error("maxBlockHeight is required");
  const spec = {
    version,
    sourceDomain,
    destinationDomain,
    sourceContract,
    destinationContract,
    sourceToken,
    destinationToken,
    sourceDepositor,
    destinationRecipient,
    sourceSigner,
    value: typeof value === "string" ? parseUnits(value, 6) : BigInt(value),
    salt: bytes32(salt ?? crypto.randomUUID(), "salt"),
    hookData,
  };
  return { maxBlockHeight: BigInt(maxBlockHeight), maxFee: BigInt(maxFee), spec };
}

export async function signGatewayErc1271BurnIntent(signer, params) {
  if (!signer?.signTypedData) throw new Error("signGatewayErc1271BurnIntent requires a typed-data signer");
  const burnIntent = buildGatewayBurnIntent(params);
  const domain = { ...GATEWAY_ERC1271_DOMAIN, chainId: ARC_GATEWAY_TESTNET.chainId, verifyingContract: burnIntent.spec.sourceContract };
  const signature = await signer.signTypedData(domain, GATEWAY_ERC1271_TYPES, burnIntent);
  return { burnIntent, signature, domain, types: GATEWAY_ERC1271_TYPES, contractSigner: true };
}

export function buildGatewayTransferRequest(result) {
  if (!result?.burnIntent || !result?.signature) throw new Error("Signed Gateway burn intent is required");
  // Keep the signature opaque. Circle's ERC-1271 path accepts arbitrary bytes.
  return { burnIntent: result.burnIntent, signature: result.signature, contractSigner: true };
}

export function serializeGatewayTransfer(result) {
  const request = buildGatewayTransferRequest(result);
  return JSON.stringify(request, (_, value) => typeof value === "bigint" ? String(value) : value);
}

export function gatewayTransferUrl(apiBase = ARC_GATEWAY_TESTNET.apiBase) {
  return `${apiBase.replace(/\/$/, "")}/v1/transfer`;
}

export function gatewayMint(signer, attestation, signature) {
  return new Contract(ARC_GATEWAY_TESTNET.gatewayMinter, GATEWAY_MINT_ABI, signer).gatewayMint(attestation, signature);
}
