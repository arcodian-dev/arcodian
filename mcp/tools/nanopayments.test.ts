import { describe, expect, it } from "vitest";
import { ARC_X402, buildNanopaymentAuthorization, parseX402Challenge, verifyNanopaymentReceipt } from "./nanopayments";
import type { Ctx } from "../sources";

const ctx: Ctx = { loadIndex: async () => ({}), provider: () => { throw new Error("no rpc"); }, tipBlock: async () => 123 };
const wallet = "0x7D9b5ab14b24Dede3b78b7e1715C1E01032F40C2";
const seller = "0x59F5089075312FD6dF7CC51D1DCBef965Acf1e1f";
const challenge = (patch: any = {}) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: { url: "https://api.example/premium" }, accepts: [{
    scheme: "exact", network: ARC_X402.network, asset: ARC_X402.usdc, amount: "10000",
    payTo: seller, maxTimeoutSeconds: 604900,
    extra: { name: ARC_X402.name, version: ARC_X402.version, verifyingContract: ARC_X402.gatewayWallet },
    ...patch,
  }],
})).toString("base64");
const readers = {
  binding: async () => ({ wallet }),
  policy: async () => ({ policy: { enabled: true, perPayment: 20_000_000_000_000_000n, dailyLimit: 100_000_000_000_000_000n, spentToday: 5_000_000_000_000_000n, validUntil: 4_000_000_000 }, allowed: true }),
};

describe("Phase E1 x402 primitives", () => {
  it("accepts only the official Arc Gateway batching option", () => {
    expect(parseX402Challenge(challenge()).requirements.amount).toBe("10000");
    expect(() => parseX402Challenge(challenge({ network: "eip155:1" }))).toThrow(/no Arc/);
    expect(() => parseX402Challenge(challenge({ asset: seller }))).toThrow(/unsupported asset/);
    expect(() => parseX402Challenge(challenge({ extra: { name: ARC_X402.name, version: "1", verifyingContract: seller } }))).toThrow(/untrusted Gateway/);
  });

  it("builds deterministic unsigned EIP-3009 typed data bound to Passport and request", async () => {
    const input = { paymentRequired: challenge(), agentId: "851812", vault: seller, serviceId: "premium-api", requestHash: `0x${"11".repeat(32)}`, now: 2_000_000_000 };
    const a = await buildNanopaymentAuthorization(input, ctx, readers);
    const b = await buildNanopaymentAuthorization(input, ctx, readers);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.typedData.message.from).toBe(wallet);
    expect(a.policyAmount).toBe("10000000000000000");
    expect(a.typedData.message.validBefore).toBe("2000604900");
    expect(a).not.toHaveProperty("signature");
  });

  it("fails closed when policy rejects the seller or amount", async () => {
    const blocked = { ...readers, policy: async () => ({ policy: { enabled: true, perPayment: 9_999_000_000_000_000n, dailyLimit: 100_000_000_000_000_000n, spentToday: 0n, validUntil: 4_000_000_000 }, allowed: false }) };
    await expect(buildNanopaymentAuthorization({
      paymentRequired: challenge(), agentId: "851812", vault: seller, serviceId: "x", requestHash: `0x${"22".repeat(32)}`,
    }, ctx, blocked)).rejects.toThrow(/seller not allowlisted.*amount exceeds perPayment/);
  });

  it("verifies an exact receipt and rejects mutation", () => {
    const key = `0x${"33".repeat(32)}`;
    const response = Buffer.from(JSON.stringify({
      success: true, network: ARC_X402.network, payer: wallet, transaction: "batch-1",
      extensions: { amount: "10000", payTo: seller, idempotencyKey: key },
    })).toString("base64");
    expect(verifyNanopaymentReceipt({ paymentResponse: response, payer: wallet, idempotencyKey: key, amount: "10000", payTo: seller }).paymentBindingVerified).toBe(true);
    expect(verifyNanopaymentReceipt({ paymentResponse: response, payer: wallet, idempotencyKey: key, amount: "10001", payTo: seller }).paymentBindingVerified).toBe(false);
    const officialMinimal = Buffer.from(JSON.stringify({ success: true, network: ARC_X402.network, payer: wallet, transaction: "batch-1" })).toString("base64");
    const limited = verifyNanopaymentReceipt({ paymentResponse: officialMinimal, payer: wallet, idempotencyKey: key, amount: "10000", payTo: seller });
    expect(limited.settlementVerified).toBe(true);
    expect(limited.paymentBindingVerified).toBe(false);
  });
});
