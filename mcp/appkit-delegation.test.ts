import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { AppKitDelegationStore, buildRevokeTypedData, buildSendGrantTypedData } from "./appkit-delegation";

const owner = Wallet.createRandom();
const agent = Wallet.createRandom();
const recipient = Wallet.createRandom().address;
const other = Wallet.createRandom().address;
const input = () => ({
  owner: owner.address, agentId: "851812", vault: Wallet.createRandom().address, recipients: [recipient],
  perAction: "0.01", periodLimit: "0.02", periodSeconds: 3600,
  expiresAt: Math.floor(Date.now() / 1000) + 86400, nonce: `0x${"11".repeat(32)}`,
});

describe("E2 scoped App Kit Send delegation", () => {
  it("activates an owner-signed grant and returns idempotent unsigned Send params", async () => {
    const store = new AppKitDelegationStore(join(await mkdtemp(join(tmpdir(), "arcodian-grant-")), "store.json"));
    const grantInput = input();
    const typed = await buildSendGrantTypedData(grantInput, agent.address);
    const signature = await owner.signTypedData(typed.domain, typed.types, typed.message);
    const readers = { owner: async () => owner.address, wallet: async () => agent.address };
    const grant = await store.activate(grantInput, agent.address, signature, readers);
    const send = await store.buildSend({ grantId: grant.grantId, recipient, amount: "0.005", requestId: "req-1" }, readers);
    const replay = await store.buildSend({ grantId: grant.grantId, recipient, amount: "0.005", requestId: "req-1" }, readers);
    expect(send.appKitParams).toMatchObject({ to: recipient, amount: "0.005", token: "USDC" });
    expect(send.unsignedTransaction.to).toBe("0x3600000000000000000000000000000000000000");
    expect(send.amountWei).toBe("5000");
    expect(send.unsignedTransaction.value).toBe("0");
    expect(replay.invocationId).toBe(send.invocationId);
    expect(replay.idempotentReplay).toBe(true);
    const txHash = `0x${"99".repeat(32)}`;
    const settled = await store.verifySend(send.invocationId, txHash, {
      getTransactionReceipt: async () => ({ status: 1, blockNumber: 123 }),
      getTransaction: async () => ({ from: agent.address, to: "0x3600000000000000000000000000000000000000", value: 0n, data: send.unsignedTransaction.data }),
    });
    expect(settled).toMatchObject({ status: "settled", txHash, blockNumber: 123 });
    expect((await store.verifySend(send.invocationId, txHash, {
      getTransactionReceipt: async () => ({ status: 1, blockNumber: 123 }),
      getTransaction: async () => ({ from: agent.address, to: "0x3600000000000000000000000000000000000000", value: 0n, data: send.unsignedTransaction.data }),
    })).idempotentReplay).toBe(true);
  });

  it("rejects recipient, cap, budget, wallet rotation, and signed revocation", async () => {
    const store = new AppKitDelegationStore(join(await mkdtemp(join(tmpdir(), "arcodian-grant-")), "store.json"));
    const grantInput = input(); const typed = await buildSendGrantTypedData(grantInput, agent.address);
    const readers = { owner: async () => owner.address, wallet: async () => agent.address };
    const grant = await store.activate(grantInput, agent.address, await owner.signTypedData(typed.domain, typed.types, typed.message), readers);
    await expect(store.buildSend({ grantId: grant.grantId, recipient: other, amount: "0.001", requestId: "bad-recipient" }, readers)).rejects.toThrow(/allowlisted/);
    await expect(store.buildSend({ grantId: grant.grantId, recipient, amount: "0.011", requestId: "over-cap" }, readers)).rejects.toThrow(/per-action/);
    await store.buildSend({ grantId: grant.grantId, recipient, amount: "0.01", requestId: "a" }, readers);
    await store.buildSend({ grantId: grant.grantId, recipient, amount: "0.01", requestId: "b" }, readers);
    await expect(store.buildSend({ grantId: grant.grantId, recipient, amount: "0.001", requestId: "over-period" }, readers)).rejects.toThrow(/period budget/);
    await expect(store.buildSend({ grantId: grant.grantId, recipient, amount: "0.001", requestId: "rotated" }, { ...readers, wallet: async () => other })).rejects.toThrow(/binding changed/);
    const revoke = buildRevokeTypedData(grant.grantId, `0x${"22".repeat(32)}`);
    await store.revoke(grant.grantId, revoke.message.nonce, await owner.signTypedData(revoke.domain, revoke.types, revoke.message));
    await expect(store.buildSend({ grantId: grant.grantId, recipient, amount: "0.001", requestId: "revoked" }, readers)).rejects.toThrow(/inactive/);
  });

  it("rejects a grant signature not made by the vault owner", async () => {
    const store = new AppKitDelegationStore(join(await mkdtemp(join(tmpdir(), "arcodian-grant-")), "store.json"));
    const grantInput = input(); const typed = await buildSendGrantTypedData(grantInput, agent.address);
    await expect(store.activate(grantInput, agent.address, await agent.signTypedData(typed.domain, typed.types, typed.message),
      { owner: async () => owner.address, wallet: async () => agent.address })).rejects.toThrow(/owner signature/);
  });
});
