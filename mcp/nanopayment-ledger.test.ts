import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileNanopaymentLedger, type NanopaymentIntent } from "./nanopayment-ledger";

const intent = (): NanopaymentIntent => ({
  idempotencyKey: `0x${"11".repeat(32)}`, createdAt: new Date(0).toISOString(),
  authorizationDigest: `0x${"22".repeat(32)}`, boundWallet: "0xwallet",
  agentId: "1", vault: "0xvault", serviceId: "svc", requestHash: `0x${"33".repeat(32)}`,
  amount: "10000", payTo: "0xseller", asset: "0xusdc", network: "eip155:5042002",
  typedData: { message: {} }, status: "pending",
});

describe("durable nanopayment ledger", () => {
  it("reuses an identical intent and rejects mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcodian-ledger-"));
    const ledger = new FileNanopaymentLedger(join(dir, "ledger.json"));
    expect((await ledger.put(intent())).reused).toBe(false);
    expect((await ledger.put(intent())).reused).toBe(true);
    await expect(ledger.put({ ...intent(), amount: "10001" })).rejects.toThrow(/idempotency conflict/);
    expect(JSON.parse(await readFile(join(dir, "ledger.json"), "utf8")).version).toBe(1);
  });

  it("settles once and returns the same receipt on duplicate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcodian-ledger-"));
    const ledger = new FileNanopaymentLedger(join(dir, "ledger.json"));
    await ledger.put(intent());
    const receipt = { transaction: "batch-1" };
    expect((await ledger.settle(intent().idempotencyKey, receipt)).status).toBe("settled");
    expect((await ledger.settle(intent().idempotencyKey, receipt)).receipt).toEqual(receipt);
    await expect(ledger.settle(intent().idempotencyKey, { transaction: "batch-2" })).rejects.toThrow(/receipt conflict/);
  });
});
