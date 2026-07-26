import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";
import { inspectUnifiedBalance } from "./appkit-unified-balance.ts";

const wallet = "0x7D9bfcbd4C9eE35719441fAB0BC436475bc040C2";
const provider = {
  call: async () => `0x${"0".repeat(24)}${wallet.slice(2).toLowerCase()}`,
  resolveName: async (name: string) => name,
};
const ctx = { provider: () => provider };
const appKit = {
  unifiedBalance: {
    getSupportedChains: () => [
      { chain: "Arc_Testnet", isTestnet: true },
      { chain: "Base_Sepolia", isTestnet: true },
      { chain: "Ethereum", isTestnet: false },
    ],
    getBalances: async ({ sources }: any) => ({
      token: "USDC",
      totalConfirmedBalance: "0.980000",
      breakdown: [{
        depositor: sources.address,
        totalConfirmed: "0.980000",
        breakdown: [{ chain: "Arc_Testnet", confirmedBalance: "0.980000" }],
      }],
    }),
  },
};

describe("App Kit Unified Balance", () => {
  it("queries the current Passport wallet on explicit testnet chains", async () => {
    const result = await inspectUnifiedBalance(
      { agentId: "851812", chains: ["Arc_Testnet"], includePending: false },
      ctx,
      appKit,
    );
    expect(result.passportWallet).toBe(getAddress(wallet.toLowerCase()));
    expect(result.totalConfirmedBalance).toBe("0.980000");
    expect(result.readOnly).toBe(true);
  });

  it("rejects mainnet and unknown chain names", async () => {
    await expect(inspectUnifiedBalance({ agentId: "851812", chains: ["Ethereum"] }, ctx, appKit))
      .rejects.toThrow("unsupported USDC testnet chain");
  });

  it("rejects a response for another depositor", async () => {
    const bad = {
      unifiedBalance: {
        ...appKit.unifiedBalance,
        getBalances: async () => ({
          token: "USDC",
          totalConfirmedBalance: "1",
          breakdown: [{ depositor: "0x59F5089075312FD6dF7CC51D1DCBef965Acf1e1f", breakdown: [] }],
        }),
      },
    };
    await expect(inspectUnifiedBalance({ agentId: "851812" }, ctx, bad))
      .rejects.toThrow("another depositor");
  });
});
