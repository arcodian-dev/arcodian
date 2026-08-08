import { describe, it, expect } from "vitest";
import { verifyVoucherCall } from "./agentrail-serve.mjs";

const price = 10n ** 16n; // 0.01
const base = {
  payer: "0xA11CE", provider: "0xB0B",
  recoveredSigner: "0xa11ce", myProvider: "0xb0b",
  cumulative: price, allocated: price * 5n, lastSeen: 0n, price,
};

describe("verifyVoucherCall", () => {
  it("accepts a valid first voucher", () => { expect(verifyVoucherCall(base).ok).toBe(true); });
  it("rejects signer != payer", () => { expect(verifyVoucherCall({ ...base, recoveredSigner: "0xdead" }).ok).toBe(false); });
  it("rejects wrong provider", () => { expect(verifyVoucherCall({ ...base, provider: "0xother" }).ok).toBe(false); });
  it("rejects cumulative > allocated", () => { expect(verifyVoucherCall({ ...base, cumulative: base.allocated + price }).ok).toBe(false); });
  it("rejects wrong delta (not exactly one price)", () => { expect(verifyVoucherCall({ ...base, cumulative: price * 3n }).ok).toBe(false); });
  it("accepts a second sequential voucher", () => { expect(verifyVoucherCall({ ...base, cumulative: price * 2n, lastSeen: price }).ok).toBe(true); });
});
