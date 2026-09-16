import { describe, expect, it } from "vitest";
import { claimBlockReason } from "./bridgeRecovery";

describe("claimBlockReason", () => {
  const base = { status: "complete", ready: true, message: "0x01", attestation: "0xsig" };

  it("allows a claim whose attestation has no expiry", () => {
    // finalityThresholdExecuted 2000 (hard finality) => expirationBlock 0.
    expect(claimBlockReason({ ...base, expirationBlock: "0" }, 21_088_647)).toBeNull();
    expect(claimBlockReason(base, 21_088_647)).toBeNull();
  });

  it("allows a fast-transfer claim that has not expired yet", () => {
    expect(claimBlockReason({ ...base, expirationBlock: "21088700" }, 21_088_647)).toBeNull();
  });

  it("blocks a fast-transfer claim whose signature already lapsed", () => {
    // Real shape from a stuck Arc inbound transfer: Circle keeps returning
    // status "complete" with a signature the contract will reject.
    const reason = claimBlockReason({ ...base, expirationBlock: "18469916" }, 21_088_647);
    expect(reason).toContain("expired");
    // The user must not be left thinking the money is gone.
    expect(reason).toContain("not lost");
  });

  it("does not guess when the destination head block is unknown", () => {
    // Better to attempt the claim and surface the contract's own revert than
    // to refuse a claim that might be perfectly valid.
    expect(claimBlockReason({ ...base, expirationBlock: "18469916" }, null)).toBeNull();
  });

  it("explains an attestation Circle has not finished", () => {
    const reason = claimBlockReason({ ...base, ready: false, status: "pending_confirmations" }, 21_088_647);
    expect(reason).toContain("pending_confirmations");
  });
});
