import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import { voucherTypes, voucherDomain, signVoucher, recoverVoucher, nextCumulative } from "./agentServices";

const vault = "0x0000000000000000000000000000000000000001";

describe("voucher signing (EIP-712)", () => {
  it("recovers the payer for a matching voucher", async () => {
    const w = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const provider = "0x000000000000000000000000000000000000dEaD";
    const domain = voucherDomain(vault, 5042002);
    const value = { payer: w.address, provider, cumulative: 10n ** 16n };
    const sig = await signVoucher(w, domain, value);
    const rec = recoverVoucher(domain, value, sig);
    expect(rec.toLowerCase()).toBe(w.address.toLowerCase());
    expect(voucherTypes.Voucher.length).toBe(3);
  });
});

describe("nextCumulative", () => {
  it("adds price to prior cumulative", () => {
    expect(nextCumulative(10n ** 16n, 10n ** 16n)).toBe(2n * 10n ** 16n);
  });
});
