import { describe, expect, it } from "vitest";
import { mainnetReadiness } from "./readiness";

const complete = {
  enabled: true, chainId: 5042, rpcUrl: "https://rpc.arc.example",
  explorerUrl: "https://explorer.arc.example",
  usdcAddress: "0x1111111111111111111111111111111111111111",
  deployer: "0x2222222222222222222222222222222222222222",
  treasury: "0x3333333333333333333333333333333333333333",
  treasuryMultisig: true, auditSignedOff: true, canarySignedOff: true,
};

describe("mainnet readiness", () => {
  it("is fail-closed until every release condition is verified", () => {
    expect(mainnetReadiness({ ...complete, auditSignedOff: false }).ready).toBe(false);
    expect(mainnetReadiness({ ...complete, rpcUrl: "" }).ready).toBe(false);
  });
  it("accepts only the complete Arc mainnet release manifest", () => {
    expect(mainnetReadiness(complete).ready).toBe(true);
    expect(mainnetReadiness({ ...complete, chainId: 5042002 }).ready).toBe(false);
  });
});
