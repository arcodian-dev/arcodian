import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes, parseEther, verifyTypedData, type Signer, type TypedDataDomain } from "ethers";
import { SERVICE_REGISTRY_ADDRESS, SERVICE_REGISTRY_ABI, PAY_VAULT_ADDRESS, PAY_VAULT_ABI, SERVICE_METADATA_ENDPOINT, ARC } from "../config";

export type ServiceMetadata = { name: string; description?: string; model?: string; inputSpec?: string; outputSpec?: string; priceUSDC?: string };
export type ServiceMeta = { name: string; model: string; description: string };
export type FeedService = { serviceId: string; provider: string; agentId: string; price: string; endpointURI: string; metadataURI: string; active: boolean; volume: string; reputation: number; metadata?: ServiceMeta | null };

// Prefer the indexer-resolved metadata (handles ipfs:// pins the UI register form produces);
// fall back to parsing an inline-JSON metadataURI, then to safe defaults.
export function serviceMeta(s: FeedService): ServiceMeta {
  if (s.metadata && s.metadata.name) return { name: s.metadata.name, model: s.metadata.model || "—", description: s.metadata.description || "" };
  try { const o = JSON.parse(s.metadataURI); return { name: o.name || "Service", model: o.model || "—", description: o.description || "" }; }
  catch { return { name: "Service", model: "—", description: "" }; }
}
export type Voucher = { payer: string; provider: string; cumulative: bigint };

export const voucherTypes = { Voucher: [
  { name: "payer", type: "address" },
  { name: "provider", type: "address" },
  { name: "cumulative", type: "uint256" },
] } as const;

export function voucherDomain(vault: string, chainId: number): TypedDataDomain {
  return { name: "AgentRail", version: "1", chainId, verifyingContract: vault };
}

export async function signVoucher(signer: Signer, domain: TypedDataDomain, v: Voucher): Promise<string> {
  return signer.signTypedData(domain, voucherTypes as any, v);
}
export function recoverVoucher(domain: TypedDataDomain, v: Voucher, signature: string): string {
  return verifyTypedData(domain, voucherTypes as any, v, signature);
}
export function nextCumulative(prev: bigint, priceWei: bigint): bigint { return prev + priceWei; }

export function canonicalJson(obj: unknown): string { return JSON.stringify(obj); }
export function hashJson(obj: unknown): string { return keccak256(toUtf8Bytes(canonicalJson(obj))); }
function reader() { return new JsonRpcProvider(ARC.rpc, undefined, { batchMaxCount: 1 }); }

export async function pinServiceMetadata(meta: ServiceMetadata): Promise<{ url: string; hash: string }> {
  const res = await fetch(SERVICE_METADATA_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) });
  if (!res.ok) throw new Error("Service metadata pin failed");
  const { url } = await res.json();
  if (!url) throw new Error("No metadata URI returned");
  return { url, hash: hashJson(meta) };
}

export async function fetchServicesFeed(): Promise<FeedService[]> {
  try {
    const res = await fetch("/developers/services.json", { cache: "no-store" });
    if (!res.ok) return [];
    const d = await res.json();
    const list: FeedService[] = Array.isArray(d) ? d : (d.services || []);
    return list.sort((a, b) => b.reputation - a.reputation);
  } catch { return []; }
}

export async function registerService(signer: Signer, price: string, endpointURI: string, metadataURI: string) {
  return new Contract(SERVICE_REGISTRY_ADDRESS, SERVICE_REGISTRY_ABI, signer).registerService(parseEther(price), endpointURI, metadataURI);
}
export async function deposit(signer: Signer, amountUSDC: string) {
  return new Contract(PAY_VAULT_ADDRESS, PAY_VAULT_ABI, signer).deposit({ value: parseEther(amountUSDC) });
}
export async function allocate(signer: Signer, provider: string, amountUSDC: string) {
  return new Contract(PAY_VAULT_ADDRESS, PAY_VAULT_ABI, signer).allocate(provider, parseEther(amountUSDC));
}
export async function redeem(signer: Signer, payer: string, cumulative: bigint, signature: string) {
  return new Contract(PAY_VAULT_ADDRESS, PAY_VAULT_ABI, signer).redeem(payer, cumulative, signature);
}
export async function readSub(payer: string, provider: string): Promise<{ allocated: bigint; redeemed: bigint }> {
  const p = reader();
  try { const s = await new Contract(PAY_VAULT_ADDRESS, PAY_VAULT_ABI, p).subs(payer, provider); return { allocated: s.allocated, redeemed: s.redeemed }; }
  finally { p.destroy(); }
}

// One metered call: increments cumulative by price, signs a voucher, POSTs it to the provider.
// Caller tracks `prevCumulative` per provider (0 for the first ever call to that provider).
export async function callService(signer: Signer, args: {
  provider: string; vault: string; chainId: number; priceUSDC: string; endpointURI: string; prompt: string; prevCumulative: bigint;
}): Promise<{ completion: string; cumulative: bigint; signature: string }> {
  const payer = await signer.getAddress();
  const cumulative = nextCumulative(args.prevCumulative, parseEther(args.priceUSDC));
  const voucher: Voucher = { payer, provider: args.provider, cumulative };
  const signature = await signVoucher(signer, voucherDomain(args.vault, args.chainId), voucher);
  const resp = await fetch(new URL("/serve", args.endpointURI).toString(), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payer, provider: args.provider, cumulative: cumulative.toString(), signature, prompt: args.prompt }),
  });
  if (!resp.ok) throw new Error(`serve failed: ${resp.status} ${await resp.text()}`);
  const { completion } = await resp.json();
  return { completion, cumulative, signature };
}
