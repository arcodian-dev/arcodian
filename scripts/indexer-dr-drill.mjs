// Disaster-recovery readiness drill for the Agent Economy indexers.
//
// Companion to mcp-state-restore-drill.mjs (which drills the durable MCP state
// DB). This drill proves the preconditions for restoring or rebuilding each
// public indexer feed (agents / jobs / reputation): the feed is well-formed,
// internally consistent, no further ahead than the chain tip, and — when a local
// shared copy exists — identical to what is being served. Fails closed: any
// structural failure exits non-zero so the drill cannot be recorded as passing.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network/";
const FEED_BASE = process.env.ARC_FEED_BASE || "https://arcodian.fun/developers";
const SHARED = process.env.ARC_SHARED_DATA || "/www/wwwroot/arcodian.fun/shared/developers";

// How records are counted per feed, so `count` can be cross-checked.
const FEEDS = {
  agents: (d) => Object.keys(d.agents || {}).length,
  jobs: (d) => (d.jobs || []).length,
  reputation: (d) => (d.agents || []).length,
};

async function tipBlock() {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
  return parseInt((await r.json()).result, 16);
}
const sha = (s) => createHash("sha256").update(s).digest("hex");

let tip = null;
try { tip = await tipBlock(); } catch { tip = null; }

const results = [];
let failed = false;
for (const [name, countRecords] of Object.entries(FEEDS)) {
  const problems = [];
  let served, servedText;
  try {
    const r = await fetch(`${FEED_BASE}/${name}.json`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    servedText = await r.text();
    served = JSON.parse(servedText);
  } catch (e) { results.push({ feed: name, ok: false, problems: [`served feed unavailable: ${e?.message || e}`] }); failed = true; continue; }

  const indexed = Number(served.indexedBlock);
  if (!Number.isFinite(indexed)) problems.push("missing or non-numeric indexedBlock");
  if (tip != null && Number.isFinite(indexed) && indexed > tip) problems.push(`indexedBlock ${indexed} is ahead of chain tip ${tip}`);
  const declared = served.count;
  const actual = countRecords(served);
  if (declared != null && Number(declared) !== actual) problems.push(`declared count ${declared} != ${actual} records`);

  // Served must match the local shared copy if one is present (deploy integrity).
  let servedMatchesLocal = null;
  try {
    const localText = await readFile(`${SHARED}/${name}.json`, "utf8");
    servedMatchesLocal = sha(localText.trim()) === sha(servedText.trim());
    if (!servedMatchesLocal) problems.push("served feed differs from local shared copy");
  } catch { servedMatchesLocal = null; /* no local copy in this environment */ }

  const ok = problems.length === 0;
  if (!ok) failed = true;
  results.push({ feed: name, ok, indexedBlock: indexed, records: actual, sha256: sha(servedText), servedMatchesLocal, problems });
}

const manifest = { version: 1, generatedAt: new Date().toISOString(), tip, ok: !failed, results };
console.log(JSON.stringify(manifest, null, 2));
process.exit(failed ? 1 : 0);
