import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

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
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS state_namespaces (
      namespace TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS state_journal (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS state_journal_namespace_sequence
      ON state_journal(namespace, sequence);
  `);
  chmodSync(path, 0o600);
  databases.set(path, database);
  return database;
}

const digest = (payload: string) => createHash("sha256").update(payload).digest("hex");

export class DurableJsonState<T extends JsonObject> {
  readonly databasePath: string;
  readonly namespace: string;
  readonly legacyPath: string;
  readonly empty: T;

  constructor(
    namespace: string,
    legacyPath: string,
    empty: T,
    databasePath = process.env.MCP_STATE_DB || defaultDatabase,
  ) {
    this.namespace = namespace;
    this.legacyPath = legacyPath;
    this.empty = empty;
    this.databasePath = databasePath;
    this.migrateLegacy();
  }

  private database() {
    return openDatabase(this.databasePath);
  }

  private migrateLegacy() {
    const database = this.database();
    const existing = database.prepare("SELECT 1 FROM state_namespaces WHERE namespace = ?").get(this.namespace);
    if (existing) return;
    let initial = this.empty;
    let operation = "initialize";
    if (existsSync(this.legacyPath)) {
      initial = JSON.parse(readFileSync(this.legacyPath, "utf8")) as T;
      operation = "migrate-json";
    }
    this.write(initial, operation);
  }

  read(): T {
    const row = this.database()
      .prepare("SELECT schema_version, payload, payload_sha256 FROM state_namespaces WHERE namespace = ?")
      .get(this.namespace) as { schema_version: number; payload: string; payload_sha256: string } | undefined;
    if (!row) throw new Error(`state namespace missing: ${this.namespace}`);
    if (digest(row.payload) !== row.payload_sha256) throw new Error(`state integrity failure: ${this.namespace}`);
    const value = JSON.parse(row.payload) as T;
    if (Number((value as any)?.version) !== row.schema_version) throw new Error(`state schema mismatch: ${this.namespace}`);
    return value;
  }

  write(value: T, operation = "update") {
    const payload = JSON.stringify(value);
    const payloadHash = digest(payload);
    const schemaVersion = Number((value as any)?.version);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error(`invalid state version: ${this.namespace}`);
    const now = new Date().toISOString();
    const database = this.database();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        INSERT INTO state_namespaces(namespace, schema_version, payload, payload_sha256, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(namespace) DO UPDATE SET
          schema_version=excluded.schema_version,
          payload=excluded.payload,
          payload_sha256=excluded.payload_sha256,
          updated_at=excluded.updated_at
      `).run(this.namespace, schemaVersion, payload, payloadHash, now);
      database.prepare(`
        INSERT INTO state_journal(namespace, operation, payload_sha256, payload, created_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(this.namespace, operation, payloadHash, payload, now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    mkdirSync(dirname(this.legacyPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.legacyPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${payload}\n`, { mode: 0o600 });
    renameSync(temporary, this.legacyPath);
  }
}
