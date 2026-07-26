import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

// Append-only, hash-chained audit trail for MCP tool invocations. Each entry
// commits to the previous entry's hash, so any edit, deletion, or reorder of a
// recorded row breaks the chain and is caught by verify(). The log records only
// non-sensitive metadata (tool name, forwarded IP, a truncated argument hash) —
// never raw arguments — matching what the server already emits to stdout.

export const GENESIS_HASH = "0".repeat(64);
const defaultDatabase = "/var/lib/arcodian-mcp/state.db";
const databases = new Map<string, DatabaseSync>();

function openDatabase(path: string) {
  const cached = databases.get(path);
  if (cached) return cached;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS audit_log (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      tool TEXT NOT NULL,
      ip TEXT NOT NULL,
      arg_hash TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL
    ) STRICT;
  `);
  chmodSync(path, 0o600);
  databases.set(path, database);
  return database;
}

export type AuditInput = { tool: string; ip: string; argHash: string };
export type AuditEntry = AuditInput & { sequence: number; ts: string; prevHash: string; entryHash: string };
export type VerifyReport = { ok: boolean; count: number; head: string; brokenAt: number | null };

// The committed hash is over a canonical, order-fixed projection of the row so
// that recomputation during verify() is deterministic and column order in SQLite
// cannot change the result.
function hashEntry(prevHash: string, e: { sequence: number; ts: string; tool: string; ip: string; argHash: string }) {
  const canonical = JSON.stringify([e.sequence, e.ts, e.tool, e.ip, e.argHash, prevHash]);
  return createHash("sha256").update(canonical).digest("hex");
}

export class AuditLog {
  readonly databasePath: string;

  constructor(databasePath = process.env.MCP_STATE_DB || defaultDatabase) {
    this.databasePath = databasePath;
    openDatabase(databasePath);
  }

  private database() {
    return openDatabase(this.databasePath);
  }

  append(input: AuditInput): AuditEntry {
    const database = this.database();
    const ts = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const prev = database.prepare("SELECT entry_hash FROM audit_log ORDER BY sequence DESC LIMIT 1").get() as
        | { entry_hash: string }
        | undefined;
      const prevHash = prev?.entry_hash ?? GENESIS_HASH;
      const seqRow = database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM audit_log").get() as { next: number };
      const sequence = seqRow.next;
      const entryHash = hashEntry(prevHash, { sequence, ts, tool: input.tool, ip: input.ip, argHash: input.argHash });
      database.prepare(`
        INSERT INTO audit_log(sequence, ts, tool, ip, arg_hash, prev_hash, entry_hash)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(sequence, ts, input.tool, input.ip, input.argHash, prevHash, entryHash);
      database.exec("COMMIT");
      return { sequence, ts, tool: input.tool, ip: input.ip, argHash: input.argHash, prevHash, entryHash };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  verify(): VerifyReport {
    const rows = this.database()
      .prepare("SELECT sequence, ts, tool, ip, arg_hash AS argHash, prev_hash AS prevHash, entry_hash AS entryHash FROM audit_log ORDER BY sequence ASC")
      .all() as Array<{ sequence: number; ts: string; tool: string; ip: string; argHash: string; prevHash: string; entryHash: string }>;
    let expectedPrev = GENESIS_HASH;
    for (const row of rows) {
      const recomputed = hashEntry(row.prevHash, row);
      if (row.prevHash !== expectedPrev || recomputed !== row.entryHash) {
        return { ok: false, count: rows.length, head: rows.at(-1)?.entryHash ?? GENESIS_HASH, brokenAt: row.sequence };
      }
      expectedPrev = row.entryHash;
    }
    return { ok: true, count: rows.length, head: rows.at(-1)?.entryHash ?? GENESIS_HASH, brokenAt: null };
  }

  since(sequence: number): AuditEntry[] {
    return this.database()
      .prepare("SELECT sequence, ts, tool, ip, arg_hash AS argHash, prev_hash AS prevHash, entry_hash AS entryHash FROM audit_log WHERE sequence > ? ORDER BY sequence ASC")
      .all(sequence) as AuditEntry[];
  }
}
