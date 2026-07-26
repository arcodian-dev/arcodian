import { describe, expect, it } from "vitest";
import type { NanopaymentIntent, NanopaymentLedger } from "./nanopayment-ledger";
import { assertCurrentPassportBinding } from "./x402-policy-hook";

const wallet = "0x7D9b5ab14b24Dede3b78b7e1715C1E01032F40C2";
const rotated = "0x59F5089075312FD6dF7CC51D1DCBef965Acf1e1f";
const key = `0x${"11".repeat(32)}`;
const record: NanopaymentIntent = {
  idempotencyKey: key, createdAt: new Date().toISOString(), authorizationDigest: `0x${"22".repeat(32)}`,
  boundWallet: wallet, agentId: "851812", vault: "0xvault", serviceId: "svc",
  requestHash: `0x${"33".repeat(32)}`, amount: "10000", payTo: rotated, asset: "0xusdc",
  network: "eip155:5042002", typedData: { message: { validBefore: String(Math.floor(Date.now() / 1000) + 3600) } },
  status: "pending",
};
const ledger: NanopaymentLedger = {
  get: async (k) => k === key ? record : null,
  put: async (i) => ({ intent: i, reused: false }),
  settle: async () => record,
};
const payload = { payload: { authorization: { from: wallet, nonce: key } } };

describe("seller pre-settlement Passport guard", () => {
  it("accepts the currently bound wallet", async () => {
    await expect(assertCurrentPassportBinding(payload, ledger, async () => wallet)).resolves.toMatchObject({ agentId: "851812" });
  });
  it("rejects wallet rotation, unknown nonce, and settled replay", async () => {
    await expect(assertCurrentPassportBinding(payload, ledger, async () => rotated)).rejects.toThrow(/binding changed/);
    await expect(assertCurrentPassportBinding({ payload: { authorization: { from: wallet, nonce: `0x${"44".repeat(32)}` } } }, ledger, async () => wallet)).rejects.toThrow(/unknown/);
    const settled = { ...ledger, get: async () => ({ ...record, status: "settled" as const }) };
    await expect(assertCurrentPassportBinding(payload, settled, async () => wallet)).rejects.toThrow(/already settled/);
  });
});
