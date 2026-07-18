import { describe, expect, it } from "vitest";
import { ARC, CHAINS, TOKENS } from "./config";

describe("official Arc Testnet configuration", () => {
  it("uses the official chain and RPC", () => {
    expect(ARC.id).toBe(5042002);
    expect(ARC.hexId).toBe("0x4cef52");
    expect(ARC.rpc).toBe("https://rpc.testnet.arc.network/");
    expect(ARC.rpcs).toContain("https://rpc.blockdaemon.testnet.arc.io");
    expect(ARC.rpcs).toContain("https://rpc.drpc.testnet.arc.io");
    expect(ARC.rpcs).toContain("https://rpc.quicknode.testnet.arc.io");
    expect(ARC.nativeDecimals).toBe(18);
    expect(ARC.erc20Decimals).toBe(6);
  });

  it("uses official stablecoin contracts", () => {
    expect(TOKENS[0].address).toBe("0x3600000000000000000000000000000000000000");
    expect(TOKENS[1].address).toBe("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");
  });

  it("keeps Arc Testnet available to bridge and swap flows", () => {
    expect(CHAINS.some((chain) => chain.id === ARC.id && chain.appKit === "Arc_Testnet")).toBe(true);
    expect(TOKENS.every((token) => token.decimals === 6)).toBe(true);
  });
});
