import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const sourcePath = process.env.MCP_STATE_DB || "/var/lib/arcodian-mcp/state.db";
const backupRoot = process.env.MCP_BACKUP_DIR || "/var/backups/arcodian-mcp";
const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\..+/, "Z");
const finalPath = join(backupRoot, `state-${stamp}.db`);
const temporaryPath = `${finalPath}.${process.pid}.tmp`;

await mkdir(backupRoot, { recursive: true, mode: 0o700 });
const source = new DatabaseSync(sourcePath, { readOnly: true });
const integrity = source.prepare("PRAGMA integrity_check").get();
if (integrity?.integrity_check !== "ok") throw new Error(`source integrity check failed: ${integrity?.integrity_check}`);
const namespaces = source.prepare(`
  SELECT namespace, schema_version AS schemaVersion, payload_sha256 AS sha256, updated_at AS updatedAt
  FROM state_namespaces ORDER BY namespace
`).all();
const journalEntries = Number(source.prepare("SELECT count(*) AS count FROM state_journal").get()?.count || 0);
await backup(source, temporaryPath);
source.close();
await chmod(temporaryPath, 0o600);
await rename(temporaryPath, finalPath);

const restored = new DatabaseSync(finalPath, { readOnly: true });
if (restored.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("backup integrity check failed");
const restoredNamespaces = restored.prepare("SELECT count(*) AS count FROM state_namespaces").get()?.count;
restored.close();
if (Number(restoredNamespaces) !== namespaces.length) throw new Error("backup namespace count mismatch");

const bytes = await readFile(finalPath);
const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  source: basename(sourcePath),
  backup: basename(finalPath),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  journalEntries,
  namespaces,
};
await writeFile(`${finalPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status: "ok", path: finalPath, ...manifest }));
