import { describe, expect, it } from "vitest";
import { arcPayFee, arcPayUri, normalizeRecipient, parseArcNativeAmount, parseArcPayUri, recipientFingerprint, recipientSafety, walletTransferFee } from "./walletCore";

const ADDRESS = "0x000000000000000000000000000000000000dEaD";

describe("wallet economics", () => {
  it("keeps basic transfers protocol-fee free", () => expect(walletTransferFee()).toBe(0n));
  it("takes 30 bps from merchant payment volume", () => expect(arcPayFee(100_000_000n)).toBe(300_000n));
  it("rounds tiny merchant fees up to one minor unit", () => expect(arcPayFee(1n)).toBe(1n));
});

describe("wallet input", () => {
  it("parses Arc native USDC using 18 native decimals", () => expect(parseArcNativeAmount("1.25")).toBe(1_250_000_000_000_000_000n));
  it("rejects invalid recipients", () => expect(() => normalizeRecipient("not-an-address")).toThrow());
  it("builds a deterministic Arc Pay request", () => expect(arcPayUri(ADDRESS, "12.50", "Order 7")).toBe("arcodian:pay/0x000000000000000000000000000000000000dEaD?amount=12.50&memo=Order+7"));
  it("round-trips a contract-bound Arc Pay invoice", () => {
    const uri = arcPayUri(ADDRESS, "12.50", "Order 7", { invoiceId: `0x${"ab".repeat(32)}`, expiresAt: 2_000_000_000, chainId: 5_042_002, contract: ADDRESS });
    expect(parseArcPayUri(uri)).toEqual({ recipient: ADDRESS, amount: "12.50", memo: "Order 7", invoiceId: `0x${"ab".repeat(32)}`, expiresAt: 2_000_000_000, chainId: 5_042_002, contract: ADDRESS });
  });
  it("rejects payment requests without settlement binding", () => expect(() => parseArcPayUri(arcPayUri(ADDRESS, "1"))).toThrow());
  it("shows a stable recipient fingerprint", () => expect(recipientFingerprint(ADDRESS)).toBe("0x000000…00dEaD"));
  it("trusts an exact saved contact", () => expect(recipientSafety(ADDRESS, [{ name: "Merchant", address: ADDRESS }]).code).toBe("known"));
  it("warns on a new recipient", () => expect(recipientSafety("0x1111111111111111111111111111111111111111").code).toBe("new"));
  it("detects a suffix lookalike", () => expect(recipientSafety(`0x${"11".repeat(17)}00dead`, [{ name: "Merchant", address: ADDRESS }]).code).toBe("lookalike"));
});
