import { Contract, JsonRpcProvider } from "ethers";
import { ARC, CCTP_MAINNET_DOMAIN, CCTP_MAINNET_MESSAGE_TRANSMITTER_V2, CCTP_MAINNET_TOKEN_MESSENGER_V2 } from "./config";

/**
 * Direct CCTP v2 recovery — independent of the bridge SDK.
 *
 * The SDK confirms the burn through the wallet's RPC, which on a flaky endpoint
 * can wrongly report a landed burn as "failed". When that happens the USDC is
 * already burned and only the destination mint is missing. This module lets the
 * app verify the burn on a reliable RPC, pull the attestation from Circle, and
 * finish the mint with a single receiveMessage — so a burned transfer can always
 * be claimed and never looks lost.
 */

// CCTP v2 domain IDs (same numbering across testnet and mainnet — but the
// *contract addresses* differ between the two environments, see below).
export const CCTP_DOMAIN: Record<number, number> = {
  11155111: 0, // Ethereum Sepolia
  43113: 1, // Avalanche Fuji
  11155420: 2, // OP Sepolia
  421614: 3, // Arbitrum Sepolia
  84532: 6, // Base Sepolia
  80002: 7, // Polygon Amoy
  [ARC.id]: 26, // Arc Testnet
  ...CCTP_MAINNET_DOMAIN, // Ethereum, Arbitrum One, Optimism, Base, Arc Mainnet — real chain IDs, no collision with the testnet ones above.
};

const MAINNET_CCTP_CHAIN_IDS = new Set(Object.keys(CCTP_MAINNET_DOMAIN).map(Number));
const isMainnetChain = (chainId: number) => MAINNET_CCTP_CHAIN_IDS.has(chainId);
export const isMainnetBridgeChainId = (chainId: number) => isMainnetChain(chainId);

// CCTP v2 MessageTransmitterV2 / TokenMessengerV2 — one deterministic address
// per environment (testnet vs mainnet are separate deployments; within each
// environment every chain shares the same address). Verified live on-chain
// 2026-07-30 for every mainnet chain in CCTP_MAINNET_DOMAIN, including Arc.
const MESSAGE_TRANSMITTER_V2_TESTNET = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const TOKEN_MESSENGER_V2_TESTNET = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
export const messageTransmitterFor = (chainId: number) => isMainnetChain(chainId) ? CCTP_MAINNET_MESSAGE_TRANSMITTER_V2 : MESSAGE_TRANSMITTER_V2_TESTNET;
export const tokenMessengerFor = (chainId: number) => isMainnetChain(chainId) ? CCTP_MAINNET_TOKEN_MESSENGER_V2 : TOKEN_MESSENGER_V2_TESTNET;
// Back-compat default (testnet) for any caller that hasn't switched to the
// per-chain helpers above yet.
export const MESSAGE_TRANSMITTER_V2 = MESSAGE_TRANSMITTER_V2_TESTNET;
export const MESSAGE_TRANSMITTER_ABI = [
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
];

const IRIS_TESTNET = "https://iris-api-sandbox.circle.com/v2";
const IRIS_MAINNET = "https://iris-api.circle.com/v2";
const irisFor = (chainId: number) => isMainnetChain(chainId) ? IRIS_MAINNET : IRIS_TESTNET;

export type Attestation = { status: string; ready: boolean; message: string; attestation: string; amount?: string };
export type PendingClaim = { burnHash: string; fromChainId: number; toChainId: number; amount?: string; recipient?: string; createdAt?: number };
export type BridgeHistoryItem = PendingClaim & { status: "pending" | "completed" | "failed"; mintHash?: string; updatedAt: number; note?: string };

export function attestationCountdown(claim: PendingClaim, now = Date.now()) {
  const estimateMs = (claim.fromChainId === 1 ? 25 : 20) * 60 * 1000;
  const createdAt = claim.createdAt || now;
  const remainingMs = Math.max(0, createdAt + estimateMs - now);
  return {
    remainingSeconds: Math.ceil(remainingMs / 1000),
    delayed: remainingMs === 0,
  };
}

/** Fetch the CCTP message + attestation for a burn. `ready` means the mint can be sent now. */
export async function fetchCctpAttestation(sourceChainId: number, burnHash: string): Promise<Attestation | null> {
  const domain = CCTP_DOMAIN[sourceChainId];
  try {
    // Same-origin proxy sweeps every CCTP domain server-side, so a burn is found
    // even if the stored source domain is wrong, and browser rate limits are avoided.
    const hint = domain === undefined ? "" : `&domain=${domain}`;
    const env = isMainnetChain(sourceChainId) ? "&env=mainnet" : "";
    const res = await fetch(`https://arcodian.fun/api/attest.php?hash=${burnHash}${hint}${env}`);
    if (!res.ok) return null;
    const data = await res.json();
    const message = data?.messages?.[0];
    if (!message) return null; // Circle has no record on any domain yet
    const ready = message.status === "complete" && typeof message.attestation === "string" && message.attestation.startsWith("0x");
    // While a burn is still confirming (e.g. Ethereum finality), `message` is null
    // and status is "pending_confirmations" — surface that instead of a null so the
    // UI shows "still attesting" rather than "not on Circle's records".
    return {
      status: String(message.status || "pending_confirmations"),
      ready,
      message: message.message || "",
      attestation: typeof message.attestation === "string" ? message.attestation : "",
      amount: message.decodedMessage?.decodedMessageBody?.amount,
    };
  } catch {
    return null;
  }
}

/**
 * Pick the CCTP transfer speed for a lane. Circle exposes a fee schedule per
 * source→destination domain: finalityThreshold 1000 = Fast Transfer (soft
 * finality, attested in seconds–minutes for a tiny bps fee), 2000 = Standard
 * (hard finality, ~13–19 min on Ethereum). We prefer Fast whenever the lane
 * offers it so a bridge never appears to hang, and fall back to Standard.
 * `feeBps` is the minimum fee in basis points for the chosen tier.
 */
export async function fetchCctpFee(sourceChainId: number, destChainId: number): Promise<{ threshold: number; feeBps: number } | null> {
  const source = CCTP_DOMAIN[sourceChainId], dest = CCTP_DOMAIN[destChainId];
  if (source === undefined || dest === undefined) return null;
  try {
    const res = await fetch(`${irisFor(sourceChainId)}/burn/USDC/fees/${source}/${dest}`);
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ finalityThreshold: number; minimumFee: number }>;
    if (!Array.isArray(rows) || !rows.length) return null;
    const fast = rows.find((row) => row.finalityThreshold <= 1000);
    if (fast) return { threshold: 1000, feeBps: Number(fast.minimumFee) || 0 };
    const standard = rows.find((row) => row.finalityThreshold >= 2000) || rows[0];
    return { threshold: standard.finalityThreshold, feeBps: Number(standard.minimumFee) || 0 };
  } catch {
    return null;
  }
}

// Circle's TokenMinter enforces a per-message burn ceiling per token
// (`burnLimitsPerMessage`) that it can raise over time as a chain matures —
// confirmed live 2026-08-30 that Arc Mainnet's had already gone from
// 1,000,000 (1 USDC, true on 2026-07-31 when this cap was first hardcoded)
// to 100,000,000,000 (100,000 USDC) with no code change on our side to
// notice it. Reading it live instead of hardcoding a number means the next
// increase (or an unrelated chain's different limit) is picked up
// automatically instead of silently under-capping users again.
const burnLimitCache = new Map<string, { value: bigint; at: number }>();
const BURN_LIMIT_TTL_MS = 5 * 60 * 1000;

/** Live per-message burn ceiling (raw token units) for `token` on `tokenMessenger`, or null if unreadable. */
export async function fetchBurnLimitPerMessage(rpc: string, tokenMessenger: string, token: string): Promise<bigint | null> {
  const cacheKey = `${rpc}:${tokenMessenger}:${token}`;
  const cached = burnLimitCache.get(cacheKey);
  if (cached && Date.now() - cached.at < BURN_LIMIT_TTL_MS) return cached.value;
  try {
    const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
    try {
      const messenger = new Contract(tokenMessenger, ["function localMinter() view returns (address)"], provider);
      const minter = await messenger.localMinter();
      const minterContract = new Contract(minter, ["function burnLimitsPerMessage(address) view returns (uint256)"], provider);
      const value = BigInt(await minterContract.burnLimitsPerMessage(token));
      burnLimitCache.set(cacheKey, { value, at: Date.now() });
      return value;
    } finally {
      provider.destroy();
    }
  } catch {
    return null;
  }
}

/** Independently confirm a burn actually landed, whatever the SDK reported. */
export async function burnConfirmed(rpc: string, burnHash: string, account?: string): Promise<boolean> {
  try {
    const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
    try {
      const receipt = await provider.getTransactionReceipt(burnHash);
      if (receipt?.status !== 1) return false;
      if (!account) return true;
      const tx = await provider.getTransaction(burnHash);
      return tx?.from?.toLowerCase() === account.toLowerCase();
    } finally {
      provider.destroy();
    }
  } catch {
    return false;
  }
}

/** Pull a burn tx hash out of a Circle SDK bridge result's step list. */
export function burnHashFromResult(result: unknown): string | null {
  const steps = (result as { steps?: Array<{ name?: string; txHash?: string }> })?.steps || [];
  const isHash = (value?: string) => typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
  const burn = steps.find((step) => step.name?.toLowerCase().includes("burn") && isHash(step.txHash));
  const any = steps.find((step) => isHash(step.txHash));
  return burn?.txHash || any?.txHash || null;
}

// Pending claims are a QUEUE: a wallet can have several burns awaiting their mint
// at once (e.g. bridging a few times in a row), so a new burn must never overwrite
// an earlier one. Stored as an array, de-duplicated by burn hash, newest first.
const key = (account: string) => `arcodian-pending-claim:${account.toLowerCase()}`;
const historyKey = (account: string) => `arcodian-bridge-history-v1:${account.toLowerCase()}`;

export function loadBridgeHistory(account: string): BridgeHistoryItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(historyKey(account)) || "[]");
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export function bridgeAttention(item: BridgeHistoryItem, now = Date.now()) {
  if (item.status !== "pending") return { level: item.status === "failed" ? "attention" as const : "complete" as const, label: item.status === "failed" ? "Needs attention" : "Completed" };
  const age = now - (item.createdAt || item.updatedAt);
  if (age >= 60 * 60 * 1000) return { level: "attention" as const, label: "Stuck · action needed" };
  if (age >= 20 * 60 * 1000) return { level: "delayed" as const, label: "Delayed · check attestation" };
  return { level: "active" as const, label: "Waiting for Circle" };
}

export function recordBridgeHistory(account: string, update: Omit<BridgeHistoryItem, "updatedAt"> & { updatedAt?: number }) {
  try {
    const current = loadBridgeHistory(account);
    const hash = update.burnHash.toLowerCase();
    const previous = current.find((item) => item.burnHash.toLowerCase() === hash);
    const next: BridgeHistoryItem = { ...previous, ...update, updatedAt: update.updatedAt || Date.now() };
    localStorage.setItem(historyKey(account), JSON.stringify([next, ...current.filter((item) => item.burnHash.toLowerCase() !== hash)].slice(0, 50)));
  } catch { /* storage disabled */ }
}

export function loadPendingClaims(account: string): PendingClaim[] {
  try {
    const raw = localStorage.getItem(key(account));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as PendingClaim[];
    return parsed && typeof parsed === "object" ? [parsed as PendingClaim] : []; // migrate legacy single object
  } catch { return []; }
}

export function savePendingClaim(account: string, claim: PendingClaim) {
  try {
    const normalized = { ...claim, createdAt: claim.createdAt || Date.now() };
    const queue = loadPendingClaims(account).filter((c) => c.burnHash.toLowerCase() !== claim.burnHash.toLowerCase());
    localStorage.setItem(key(account), JSON.stringify([normalized, ...queue].slice(0, 12)));
    recordBridgeHistory(account, { ...normalized, status: "pending" });
  } catch { /* storage disabled */ }
}

/** Back-compat: the most recent pending claim, or null. */
export function loadPendingClaim(account: string): PendingClaim | null {
  return loadPendingClaims(account)[0] ?? null;
}

/** Remove one claim by burn hash, or the whole queue when no hash is given. */
export function clearPendingClaim(account: string, burnHash?: string) {
  try {
    if (!burnHash) { localStorage.removeItem(key(account)); return; }
    const queue = loadPendingClaims(account).filter((c) => c.burnHash.toLowerCase() !== burnHash.toLowerCase());
    if (queue.length) localStorage.setItem(key(account), JSON.stringify(queue));
    else localStorage.removeItem(key(account));
  } catch { /* storage disabled */ }
}
