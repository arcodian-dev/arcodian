import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const backupPath = process.argv[2];
if (!backupPath) throw new Error("usage: node scripts/mcp-state-restore-drill.mjs <backup.db>");
const manifest = JSON.parse(await readFile(`${backupPath}.manifest.json`, "utf8"));
const backupBytes = await readFile(backupPath);
const actualHash = createHash("sha256").update(backupBytes).digest("hex");
if (actualHash !== manifest.sha256) throw new Error("backup manifest hash mismatch");

const drillRoot = await mkdtemp(join(tmpdir(), "arcodian-mcp-restore-"));
const restoredPath = join(drillRoot, "state.db");
try {
  await copyFile(backupPath, restoredPath);
  const restored = new DatabaseSync(restoredPath, { readOnly: true });
  const integrity = restored.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (integrity !== "ok") throw new Error(`restored integrity check failed: ${integrity}`);
  const namespaces = restored.prepare(`
    SELECT namespace, schema_version AS schemaVersion, payload_sha256 AS sha256, payload
    FROM state_namespaces ORDER BY namespace
  `).all();
  for (const row of namespaces) {
    if (createHash("sha256").update(row.payload).digest("hex") !== row.sha256) {
      throw new Error(`payload integrity failure: ${row.namespace}`);
    }
    const payload = JSON.parse(row.payload);
    if (Number(payload.version) !== row.schemaVersion) throw new Error(`schema mismatch: ${row.namespace}`);
  }
  const journalEntries = Number(restored.prepare("SELECT count(*) AS count FROM state_journal").get()?.count || 0);
  restored.close();
  if (namespaces.length !== manifest.namespaces.length) throw new Error("restored namespace count mismatch");
  if (journalEntries !== manifest.journalEntries) throw new Error("restored journal count mismatch");
  console.log(JSON.stringify({
    status: "ok",
    backup: manifest.backup,
    namespaces: namespaces.map((row) => row.namespace),
    journalEntries,
    integrity,
  }));
} finally {
  await rm(drillRoot, { recursive: true, force: true });
}
