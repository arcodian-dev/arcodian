import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { AppKitSwapStore, buildSwapGrantTypedData } from "./appkit-swap.ts";

const owner = Wallet.createRandom();
const boundWallet = Wallet.createRandom().address;
const input = () => ({ owner: owner.address, agentId: "851812", vault: Wallet.createRandom().address,
  perAction: "0.01", periodLimit: "0.02", minRate: "0.65", maxSlippageBps: 300,
  periodSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 3600, nonce: `0x${"33".repeat(32)}` });

describe("scoped App Kit Swap", () => {
  it("builds an idempotent USDC/EURC invocation with owner-set floor", async () => {
    const grant = input(); const typed = buildSwapGrantTypedData(grant, boundWallet);
    const signature = await owner.signTypedData(typed.domain, typed.types, typed.message);
    const readers = { owner: async () => owner.address, wallet: async () => boundWallet };
    const store = new AppKitSwapStore(join(await mkdtemp(join(tmpdir(), "arc-swap-")), "store.json"));
    await store.activate(grant, boundWallet, signature, readers);
    const first = await store.build({ grantId: typed.grantId, amountIn: "0.001", requestId: "one" }, readers);
    const retry = await store.build({ grantId: typed.grantId, amountIn: "0.001", requestId: "one" }, readers);
    expect(first.stopLimit).toBe("0.00065");
    expect(first.config.slippageBps).toBe(300);
    expect(retry.idempotentReplay).toBe(true);
  });

  it("rejects excessive slippage, action cap, and Passport rotation", async () => {
    expect(() => buildSwapGrantTypedData({ ...input(), maxSlippageBps: 501 }, boundWallet)).toThrow("maxSlippageBps");
    const grant = input(); const typed = buildSwapGrantTypedData(grant, boundWallet);
    const signature = await owner.signTypedData(typed.domain, typed.types, typed.message);
    const readers = { owner: async () => owner.address, wallet: async () => boundWallet };
    const store = new AppKitSwapStore(join(await mkdtemp(join(tmpdir(), "arc-swap-")), "store.json"));
    await store.activate(grant, boundWallet, signature, readers);
    await expect(store.build({ grantId: typed.grantId, amountIn: "0.011", requestId: "two" }, readers)).rejects.toThrow("per-action");
    await expect(store.build({ grantId: typed.grantId, amountIn: "0.001", requestId: "three" }, { ...readers, wallet: async () => Wallet.createRandom().address })).rejects.toThrow("Passport binding changed");
  });
});
