import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, getAddress } from "ethers";
import { describe, expect, it } from "vitest";
import { AppKitBridgeStore, buildBridgeGrantTypedData } from "./appkit-bridge.ts";

const owner = Wallet.createRandom();
const boundWallet = Wallet.createRandom().address;
const recipient = Wallet.createRandom().address;
const input = () => ({
  owner: owner.address, agentId: "851812", vault: Wallet.createRandom().address,
  destinations: ["Base_Sepolia"], recipients: [recipient], perAction: "0.01",
  periodLimit: "0.02", periodSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 3600,
  nonce: `0x${"11".repeat(32)}`,
});
const readers = (grant: ReturnType<typeof input>) => ({
  owner: async (vault: string) => getAddress(vault) === getAddress(grant.vault) ? owner.address : Wallet.createRandom().address,
  wallet: async () => boundWallet,
});

describe("scoped App Kit Bridge", () => {
  it("activates and builds an idempotent SLOW zero-fee bridge", async () => {
    const grant = input();
    const typed = buildBridgeGrantTypedData(grant, boundWallet);
    const signature = await owner.signTypedData(typed.domain, typed.types, typed.message);
    const store = new AppKitBridgeStore(join(await mkdtemp(join(tmpdir(), "arc-bridge-")), "store.json"));
    await store.activate(grant, boundWallet, signature, readers(grant));
    const first = await store.build({ grantId: typed.grantId, destination: "Base_Sepolia", recipient, amount: "0.001", requestId: "request-1" }, readers(grant));
    const retry = await store.build({ grantId: typed.grantId, destination: "Base_Sepolia", recipient, amount: "0.001", requestId: "request-1" }, readers(grant));
    expect(first.config).toEqual({ transferSpeed: "SLOW", maxFee: "0", batchTransactions: false });
    expect(retry.invocationId).toBe(first.invocationId);
    expect(retry.idempotentReplay).toBe(true);
  });

  it("rejects route, recipient, cap, and Passport rotation violations", async () => {
    expect(() => buildBridgeGrantTypedData({ ...input(), destinations: ["Ethereum"] }, boundWallet)).toThrow("unsupported destination");
    const grant = input();
    const typed = buildBridgeGrantTypedData(grant, boundWallet);
    const signature = await owner.signTypedData(typed.domain, typed.types, typed.message);
    const store = new AppKitBridgeStore(join(await mkdtemp(join(tmpdir(), "arc-bridge-")), "store.json"));
    await store.activate(grant, boundWallet, signature, readers(grant));
    await expect(store.build({ grantId: typed.grantId, destination: "Base_Sepolia", recipient: Wallet.createRandom().address, amount: "0.001", requestId: "a" }, readers(grant))).rejects.toThrow("recipient");
    await expect(store.build({ grantId: typed.grantId, destination: "Base_Sepolia", recipient, amount: "0.011", requestId: "b" }, readers(grant))).rejects.toThrow("per-action");
    await expect(store.build({ grantId: typed.grantId, destination: "Base_Sepolia", recipient, amount: "0.001", requestId: "c" }, { ...readers(grant), wallet: async () => Wallet.createRandom().address })).rejects.toThrow("Passport binding changed");
  });
});
