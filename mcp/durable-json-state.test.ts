import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DurableJsonState } from "./durable-json-state.ts";

describe("transactional MCP state", () => {
  it("migrates legacy JSON, journals updates, and preserves an atomic compatibility mirror", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcodian-state-"));
    const legacy = join(root, "legacy.json");
    const database = join(root, "state.db");
    const empty = { version: 1, records: {} as Record<string, string> };
    const state = new DurableJsonState("test", legacy, empty, database);

    state.write({ version: 1, records: { request: "reserved" } }, "reserve");
    expect(state.read().records.request).toBe("reserved");
    expect(JSON.parse(await readFile(legacy, "utf8")).records.request).toBe("reserved");

    const sqlite = new DatabaseSync(database, { readOnly: true });
    expect(sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(sqlite.prepare("SELECT count(*) AS count FROM state_journal WHERE namespace = ?").get("test")?.count).toBe(2);
    sqlite.close();
  });
});
