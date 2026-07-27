import { describe, expect, it } from "vitest";
import { describeTxError } from "./txError";

describe("describeTxError", () => {
  it("explains a wallet-rejected request without leaking ethers internals", () => {
    expect(describeTxError({ code: "ACTION_REJECTED", message: "user rejected transaction" })).toBe(
      "You canceled the request in your wallet.",
    );
  });

  it("decodes a known custom-error selector from error.data", () => {
    expect(describeTxError({ code: "CALL_EXCEPTION", data: "0xe9fef498" })).toContain("supply/borrow cap");
  });

  it("decodes a selector nested in ethers' info.error.data shape", () => {
    expect(describeTxError({ code: "CALL_EXCEPTION", info: { error: { data: "0xbc6900bb" } } })).toContain("health factor");
  });

  it("decodes a legacy string revert reason", () => {
    expect(describeTxError({ code: "CALL_EXCEPTION", reason: "SLIPPAGE" })).toContain("slippage tolerance");
  });

  it("falls back to a generic explanation for an unrecognized selector", () => {
    const message = describeTxError({ code: "CALL_EXCEPTION", data: "0xdeadbeef" });
    expect(message).toContain("0xdeadbeef");
    expect(message).not.toContain("action=");
  });

  it("never returns the raw multi-line ethers exception text", () => {
    const rawEthersError = new Error(
      'execution reverted (unknown custom error) (action="estimateGas", data="0xe9fef498", reason=null, transaction={...}, invocation=null, revert=null, code=CALL_EXCEPTION, version=6.17.0)',
    );
    (rawEthersError as unknown as { code: string; data: string }).code = "CALL_EXCEPTION";
    (rawEthersError as unknown as { code: string; data: string }).data = "0xe9fef498";
    const message = describeTxError(rawEthersError);
    expect(message).not.toContain("action=");
    expect(message).not.toContain("invocation=");
  });

  it("gives a plain-language insufficient-funds message", () => {
    expect(describeTxError({ code: "INSUFFICIENT_FUNDS" })).toContain("doesn't have enough balance");
  });

  it("recognizes RPC rate-limit signatures without dumping the raw JSON-RPC error", () => {
    const message = describeTxError({ code: "CALL_EXCEPTION", message: "missing revert data (could not coalesce error)" });
    expect(message).toContain("busy");
  });

  it("decodes the ArcAgentJobsV2 self-dealing guard", () => {
    expect(describeTxError({ code: "CALL_EXCEPTION", data: "0x74ca9bd8" })).toContain("neutral third party");
  });

  it("decodes the ArcAgentPayV4 stale-ownership guard", () => {
    expect(describeTxError({ code: "CALL_EXCEPTION", data: "0x4867df74" })).toContain("current holder");
  });

  it("decodes the ArcAdminTimelock two-step admin-accept guard", () => {
    expect(describeTxError({ code: "CALL_EXCEPTION", data: "0x058d9a1b" })).toContain("proposed as the new admin");
  });
});
