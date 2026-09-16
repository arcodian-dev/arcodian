import { afterEach, describe, expect, it, vi } from "vitest";
import { claimBlockReason, requestReattestation } from "./bridgeRecovery";

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

describe("requestReattestation", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reports success only when Circle accepted the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    await expect(requestReattestation(8453, `0x${"a".repeat(64)}`)).resolves.toBe(true);
  });

  it("does not claim success when Circle refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: false }) })));
    await expect(requestReattestation(8453, `0x${"a".repeat(64)}`)).resolves.toBe(false);
  });

  it("refuses a malformed nonce without calling out", async () => {
    // Guards against firing a request built from a missing/garbage field.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestReattestation(8453, "not-a-nonce")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(requestReattestation(8453, `0x${"b".repeat(64)}`)).resolves.toBe(false);
  });
});
