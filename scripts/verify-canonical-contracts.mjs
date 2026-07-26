// Phase F5 — canonical contract verification status.
//
// Reads the canonical registry (public/developers/contracts.json), and for every
// listed address records (a) whether bytecode is deployed on-chain and (b) the
// Blockscout source-verification status. Writes a verification-status.json
// registry so verification progress is auditable and completes the moment the
// Arcscan (Blockscout) API recovers from its 503 outage. This tool records
// status; it does not itself submit source (that is `forge verify-contract`,
// which needs each contract's exact compiler settings and constructor args).
import { readFile, writeFile } from "node:fs/promises";

const RPC = process.env.ARC_RPC_URL || "https://rpc.blockdaemon.testnet.arc.io";
const BLOCKSCOUT = process.env.ARC_BLOCKSCOUT || "https://testnet.arcscan.app";
const REGISTRY = process.env.CONTRACTS_JSON || "public/developers/contracts.json";
const OUT = process.env.VERIFICATION_STATUS || "public/developers/verification-status.json";

const withTimeout = (ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) }; };

async function hasCode(address) {
  const g = withTimeout(8000);
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, signal: g.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }) });
    const d = await r.json();
    return typeof d.result === "string" && d.result !== "0x" && d.result.length > 2;
  } catch { return null; } finally { g.done(); }
}

// Blockscout v2 smart-contract endpoint. Returns verification state, or
// "unavailable" when the API is down (current 503 outage).
async function verifiedStatus(address) {
  const g = withTimeout(8000);
  try {
    const r = await fetch(`${BLOCKSCOUT}/api/v2/smart-contracts/${address}`, { signal: g.signal, headers: { accept: "application/json" } });
    if (r.status === 404) return "unverified";
    if (!r.ok) return "unavailable";
    const d = await r.json();
    return d.is_verified ? "verified" : "unverified";
  } catch { return "unavailable"; } finally { g.done(); }
}

const registry = JSON.parse(await readFile(REGISTRY, "utf8"));
const entries = Object.entries(registry.contracts || {}).filter(([, v]) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v));

const results = [];
for (const [name, address] of entries) {
  const [deployed, verification] = await Promise.all([hasCode(address), verifiedStatus(address)]);
  results.push({ name, address, deployed, verification });
}

const counts = results.reduce((a, r) => { a[r.verification] = (a[r.verification] || 0) + 1; return a; }, {});
const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  network: { rpc: RPC, blockscout: BLOCKSCOUT, chainId: 5042002 },
  counts,
  apiReachable: results.some((r) => r.verification !== "unavailable"),
  contracts: results,
};
await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({ total: results.length, counts, apiReachable: payload.apiReachable }));
