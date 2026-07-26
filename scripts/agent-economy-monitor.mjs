// Independent Agent Economy monitor.
//
// Runs on its own timer, separate from unified-monitor.mjs and from the MCP
// service itself, so a fault in one surface cannot silence detection of another.
// It checks the surfaces unified-monitor does NOT cover: the MCP endpoint,
// the hash-chained audit trail, the durable-state backup freshness, and the
// Agent Economy indexers (agents / jobs / reputation) block-lag and age.
//
// Output: a self-contained notifications feed. Exit code encodes worst severity
// (2 critical, 1 warning, 0 healthy) so a systemd OnFailure hook can alert
// out-of-band while the feed stays authoritative.
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AuditLog } from "../mcp/audit-log.ts";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network/";
const FEED_BASE = process.env.ARC_FEED_BASE || "https://arcodian.fun/developers";
const MCP_HEALTH = process.env.MCP_HEALTH_URL || "http://127.0.0.1:8793/health";
const BACKUP_DIR = process.env.MCP_BACKUP_DIR || "/var/backups/arcodian-mcp";
const OUT = process.env.AGENT_ECONOMY_NOTIFICATIONS || "/var/lib/arcodian-mcp/agent-economy-notifications.json";
// The state backup runs daily; allow a full day plus the timer's randomized
// delay and a margin before a missed backup is treated as stale.
const BACKUP_MAX_MIN = Number(process.env.MCP_BACKUP_MAX_MIN || 1560);
// Indexer freshness is judged by estimated staleness in minutes, not raw block
// count: Arc produces ~2 blocks/sec, so the indexers' ~10-minute cadence leaves
// ~1000+ blocks of lag during healthy operation. Convert lag→minutes and alert
// on time so normal cadence is not a false positive.
const SEC_PER_BLOCK = Number(process.env.ARC_SEC_PER_BLOCK || 0.5);
const INDEXER_AGE_WARN_MIN = Number(process.env.INDEXER_AGE_WARN_MIN || 30);
const INDEXER_AGE_CRIT_MIN = Number(process.env.INDEXER_AGE_CRIT_MIN || 120);

const alerts = [];
const add = (severity, id, title, detail) => alerts.push({ severity, id, title, detail });
const withTimeout = (ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) }; };

async function fetchJson(url) {
  const g = withTimeout(8000);
  try { const r = await fetch(url, { cache: "no-store", signal: g.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }
  finally { g.done(); }
}

async function tipBlock() {
  const g = withTimeout(8000);
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, signal: g.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
    const d = await r.json();
    return parseInt(d.result, 16);
  } finally { g.done(); }
}

// 1. MCP endpoint reachability.
try {
  const g = withTimeout(5000);
  const r = await fetch(MCP_HEALTH, { signal: g.signal }); g.done();
  const body = (await r.text()).trim();
  if (!r.ok || body !== "ok") add("critical", "mcp-unhealthy", "MCP endpoint unhealthy", `Health check returned ${r.status} ${body}.`);
} catch (e) { add("critical", "mcp-unreachable", "MCP endpoint unreachable", String(e?.message || e)); }

// 2. Audit-trail integrity.
try {
  const report = new AuditLog().verify();
  if (!report.ok) add("critical", "audit-tampered", "MCP audit chain broken", `Chain fails verification at sequence ${report.brokenAt} of ${report.count}.`);
} catch (e) { add("warning", "audit-unreadable", "MCP audit chain unreadable", String(e?.message || e)); }

// 3. Durable-state backup freshness.
try {
  const files = (await readdir(BACKUP_DIR)).filter((f) => f.endsWith(".manifest.json")).sort();
  if (files.length === 0) add("critical", "backup-missing", "No MCP state backup found", `No backup manifest in ${BACKUP_DIR}.`);
  else {
    const manifest = JSON.parse(await readFile(`${BACKUP_DIR}/${files.at(-1)}`, "utf8"));
    const ageMin = Math.floor((Date.now() - new Date(manifest.createdAt).getTime()) / 60000);
    if (ageMin > BACKUP_MAX_MIN) add("critical", "backup-stale", "MCP state backup is stale", `Newest verified backup is ${ageMin} minutes old (limit ${BACKUP_MAX_MIN}).`);
  }
} catch (e) { add("warning", "backup-unreadable", "MCP backup status unavailable", String(e?.message || e)); }

// 4. Agent Economy indexer block-lag + age.
let tip = null;
try { tip = await tipBlock(); } catch (e) { add("warning", "tip-unreadable", "Chain tip unreadable", `Could not read eth_blockNumber: ${e?.message || e}. Indexer lag unchecked.`); }
for (const name of ["agents", "jobs", "reputation"]) {
  try {
    const feed = await fetchJson(`${FEED_BASE}/${name}.json`);
    const indexed = Number(feed.indexedBlock);
    if (!Number.isFinite(indexed)) { add("warning", `indexer-${name}-noblock`, `${name} indexer feed missing indexedBlock`, "Feed is present but has no indexedBlock field."); continue; }
    if (tip != null) {
      const lag = Math.max(0, tip - indexed);
      const ageMin = Math.floor((lag * SEC_PER_BLOCK) / 60);
      if (ageMin >= INDEXER_AGE_CRIT_MIN) add("critical", `indexer-${name}-stalled`, `${name} indexer stalled`, `Indexed block ${indexed} is ~${ageMin} minutes behind chain tip ${tip} (${lag} blocks).`);
      else if (ageMin >= INDEXER_AGE_WARN_MIN) add("warning", `indexer-${name}-lagging`, `${name} indexer lagging`, `Indexed block ${indexed} is ~${ageMin} minutes behind chain tip ${tip} (${lag} blocks).`);
    }
  } catch (e) { add("critical", `indexer-${name}-missing`, `${name} indexer feed unavailable`, String(e?.message || e)); }
}

const rank = { critical: 0, warning: 1, notice: 2 };
alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id));
const counts = { critical: alerts.filter((a) => a.severity === "critical").length, warning: alerts.filter((a) => a.severity === "warning").length };
const status = counts.critical ? "critical" : counts.warning ? "warning" : "healthy";
const payload = { version: 1, generatedAt: new Date().toISOString(), status, counts, alerts };
await mkdir(dirname(OUT), { recursive: true, mode: 0o700 });
await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status, ...counts }));
process.exit(counts.critical ? 2 : counts.warning ? 1 : 0);
