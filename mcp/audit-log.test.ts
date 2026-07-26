import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AuditLog, GENESIS_HASH } from "./audit-log.ts";

async function freshLog() {
  const root = await mkdtemp(join(tmpdir(), "arcodian-audit-"));
  return new AuditLog(join(root, "state.db"));
}

describe("append-only MCP audit log", () => {
  it("chains entries from a fixed genesis and verifies intact", async () => {
    const log = await freshLog();
    const a = log.append({ tool: "inspect_agent", ip: "10.0.0.1", argHash: "aaaa" });
    const b = log.append({ tool: "list_jobs", ip: "10.0.0.2", argHash: "bbbb" });

    expect(a.sequence).toBe(1);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.sequence).toBe(2);
    expect(b.prevHash).toBe(a.entryHash);

    const report = log.verify();
    expect(report.ok).toBe(true);
    expect(report.count).toBe(2);
    expect(report.head).toBe(b.entryHash);
  });

  it("detects tampering with any recorded field", async () => {
    const log = await freshLog();
    log.append({ tool: "inspect_agent", ip: "10.0.0.1", argHash: "aaaa" });
    log.append({ tool: "list_jobs", ip: "10.0.0.2", argHash: "bbbb" });

    const raw = new DatabaseSync(log.databasePath);
    raw.exec("UPDATE audit_log SET tool = 'forged' WHERE sequence = 1");
    raw.close();

    const report = log.verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toBe(1);
  });

  it("exports entries strictly after a sequence, in order", async () => {
    const log = await freshLog();
    log.append({ tool: "a", ip: "1", argHash: "1" });
    log.append({ tool: "b", ip: "2", argHash: "2" });
    log.append({ tool: "c", ip: "3", argHash: "3" });

    const tail = log.since(1);
    expect(tail.map((e) => e.sequence)).toEqual([2, 3]);
    expect(tail.map((e) => e.tool)).toEqual(["b", "c"]);
  });
});
