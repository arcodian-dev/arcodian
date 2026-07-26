// Append-only export of the MCP audit trail.
//
// Verifies the on-chain-of-hashes integrity of the durable audit log, then
// appends any entries newer than the last export to a persistent NDJSON file and
// refreshes a manifest (head hash + count). Fails closed: if the chain does not
// verify, nothing is exported and the process exits non-zero so the independent
// monitor and operators are alerted.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AuditLog } from "../mcp/audit-log.ts";

const exportPath = process.env.MCP_AUDIT_EXPORT || "/var/lib/arcodian-mcp/audit-export.ndjson";
const manifestPath = `${exportPath}.manifest.json`;

const log = new AuditLog();
const report = log.verify();
if (!report.ok) {
  console.error(JSON.stringify({ status: "tamper", brokenAt: report.brokenAt, count: report.count }));
  process.exit(1);
}

let lastSequence = 0;
try {
  lastSequence = Number(JSON.parse(await readFile(manifestPath, "utf8")).lastSequence || 0);
} catch {
  lastSequence = 0;
}

const fresh = log.since(lastSequence);
await mkdir(dirname(exportPath), { recursive: true, mode: 0o700 });
if (fresh.length > 0) {
  const lines = fresh.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(exportPath, lines, { mode: 0o600 });
}

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  chainVerified: true,
  count: report.count,
  head: report.head,
  lastSequence: report.count,
  appended: fresh.length,
  exportPath,
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status: "ok", appended: fresh.length, count: report.count, head: report.head.slice(0, 16) }));
