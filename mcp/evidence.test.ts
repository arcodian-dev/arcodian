import { describe, it, expect } from "vitest";
import { indexEvidence, rpcEvidence, txLink, addrLink, CHAIN_ID } from "./evidence";

describe("evidence", () => {
  it("rpcEvidence marks source rpc with block + contract", () => {
    const e = rpcEvidence(100, "0xabc", { explorer: "x" });
    expect(e).toMatchObject({ chainId: CHAIN_ID, source: "rpc", block: 100, contract: "0xabc" });
    expect(e.stale).toBeUndefined();
  });

  it("indexEvidence is fresh when lag <= threshold", () => {
    const e = indexEvidence(120, 100); // lag 20, default threshold 50
    expect(e.source).toBe("index");
    expect(e.stale).toBe(false);
    expect(e.lag).toBeUndefined();
  });

  it("indexEvidence flips stale + reports lag past threshold", () => {
    const e = indexEvidence(1000, 100); // lag 900
    expect(e.stale).toBe(true);
    expect(e.lag).toBe(900);
    expect(e.indexedBlock).toBe(100);
  });

  it("link helpers point at the explorer", () => {
    expect(txLink("0xh")).toContain("/tx/0xh");
    expect(addrLink("0xa")).toContain("/address/0xa");
  });
});
