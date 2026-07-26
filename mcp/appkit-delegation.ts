import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Contract, Interface, TypedDataEncoder, getAddress, keccak256, parseUnits, toUtf8Bytes, verifyTypedData } from "ethers";
import { AGENT_PASSPORT_ABI, AGENT_PASSPORT_ADDRESS, AGENT_PAY_V3_VAULT_ABI, ARC } from "./tools/_config.ts";

export type SendGrantInput = {
  owner: string; agentId: string; vault: string; recipients: string[];
  perAction: string; periodLimit: string; periodSeconds: number; expiresAt: number; nonce: string;
};
export type SendGrant = SendGrantInput & {
  grantId: string; boundWallet: string; recipientsHash: string; perActionWei: string;
  periodLimitWei: string; signature: string; spentWei: string; periodStart: number;
  revoked: boolean; status: "active" | "revoked";
};
type Store = { version: 1; grants: Record<string, SendGrant>; invocations: Record<string, any> };
type Readers = { owner: (vault: string) => Promise<string>; wallet: (agentId: string) => Promise<string> };

const domain = { name: "Arcodian AppKit Delegation", version: "1", chainId: 5042002, verifyingContract: AGENT_PASSPORT_ADDRESS };
const types = { SendDelegation: [
  { name: "owner", type: "address" }, { name: "agentId", type: "uint256" }, { name: "vault", type: "address" },
  { name: "boundWallet", type: "address" }, { name: "recipientsHash", type: "bytes32" },
  { name: "perActionWei", type: "uint256" }, { name: "periodLimitWei", type: "uint256" },
  { name: "periodSeconds", type: "uint256" }, { name: "expiresAt", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
const revokeTypes = { RevokeSendDelegation: [{ name: "grantId", type: "bytes32" }, { name: "nonce", type: "bytes32" }] };
const recipientsHash = (items: string[]) => keccak256(toUtf8Bytes(items.map((x) => getAddress(x).toLowerCase()).sort().join("|")));
const usdc = new Interface(["function transfer(address to,uint256 amount) returns(bool)"]);

export async function buildSendGrantTypedData(input: SendGrantInput, boundWallet: string) {
  if (!input.recipients.length || input.recipients.length > 32) throw new Error("recipient allowlist required (max 32)");
  if (input.periodSeconds < 60 || input.periodSeconds > 31_536_000) throw new Error("invalid periodSeconds");
  if (input.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("grant already expired");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.nonce)) throw new Error("nonce must be bytes32");
  const message = {
    owner: getAddress(input.owner), agentId: input.agentId, vault: getAddress(input.vault),
    boundWallet: getAddress(boundWallet), recipientsHash: recipientsHash(input.recipients),
    // App Kit's Arc `USDC` alias uses ERC-20 compatible 6-decimal units even
    // though Arc gas/native accounting is 18 decimals.
    perActionWei: parseUnits(input.perAction, 6).toString(), periodLimitWei: parseUnits(input.periodLimit, 6).toString(),
    periodSeconds: String(input.periodSeconds), expiresAt: String(input.expiresAt), nonce: input.nonce,
  };
  if (BigInt(message.perActionWei) <= 0n || BigInt(message.perActionWei) > BigInt(message.periodLimitWei)) throw new Error("invalid grant limits");
  return { domain, types, primaryType: "SendDelegation", message, grantId: TypedDataEncoder.hash(domain, types, message), capability: "send", chain: "Arc_Testnet", token: "USDC" };
}
export function buildRevokeTypedData(grantId: string, nonce: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(grantId) || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw Error("grantId and nonce must be bytes32");
  const message = { grantId, nonce };
  return { domain, types: revokeTypes, primaryType: "RevokeSendDelegation", message };
}

export class AppKitDelegationStore {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(path = process.env.MCP_APPKIT_GRANTS || "/var/lib/arcodian-mcp/appkit-grants.json") { this.path = path; }
  private async load(): Promise<Store> {
    try { const d = JSON.parse(await readFile(this.path, "utf8")); if (d?.version !== 1) throw Error("invalid delegation store"); return d; }
    catch (e: any) { if (e?.code === "ENOENT") return { version: 1, grants: {}, invocations: {} }; throw e; }
  }
  private async save(data: Store) { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); const t = `${this.path}.${process.pid}.tmp`; await writeFile(t, `${JSON.stringify(data)}\n`, { mode: 0o600 }); await rename(t, this.path); }
  async get(grantId: string) { return (await this.load()).grants[grantId] ?? null; }
  async activate(input: SendGrantInput, boundWallet: string, signature: string, readers: Readers) {
    const typed = await buildSendGrantTypedData(input, boundWallet);
    const [vaultOwner, currentWallet] = await Promise.all([readers.owner(input.vault), readers.wallet(input.agentId)]);
    if (getAddress(vaultOwner) !== getAddress(input.owner)) throw new Error("signer is not vault owner");
    if (getAddress(currentWallet) !== getAddress(boundWallet)) throw new Error("Passport binding mismatch");
    if (getAddress(verifyTypedData(domain, types, typed.message, signature)) !== getAddress(input.owner)) throw new Error("invalid owner signature");
    const grant: SendGrant = { ...input, owner: getAddress(input.owner), vault: getAddress(input.vault), recipients: input.recipients.map(getAddress),
      grantId: typed.grantId, boundWallet: getAddress(boundWallet), recipientsHash: typed.message.recipientsHash,
      perActionWei: typed.message.perActionWei, periodLimitWei: typed.message.periodLimitWei, signature,
      spentWei: "0", periodStart: Math.floor(Date.now() / 1000), revoked: false, status: "active" };
    const op = this.queue.then(async () => { const d = await this.load(); const old = d.grants[grant.grantId]; if (old && JSON.stringify(old) !== JSON.stringify(grant)) throw Error("grant conflict"); d.grants[grant.grantId] ??= grant; await this.save(d); });
    this.queue = op.catch(() => undefined); await op; return grant;
  }
  async revoke(grantId: string, nonce: string, signature: string) {
    const op = this.queue.then(async () => { const d = await this.load(); const g = d.grants[grantId]; if (!g) throw Error("grant not found");
      const typed = buildRevokeTypedData(grantId, nonce);
      if (getAddress(verifyTypedData(domain, revokeTypes, typed.message, signature)) !== g.owner) throw Error("invalid revocation signature");
      g.revoked = true; g.status = "revoked"; await this.save(d); });
    this.queue = op.catch(() => undefined); await op; return this.get(grantId);
  }
  async buildSend(input: { grantId: string; recipient: string; amount: string; requestId: string }, readers: Readers) {
    let result: any;
    const op = this.queue.then(async () => {
      const d = await this.load(); const g = d.grants[input.grantId]; if (!g || g.revoked) throw Error("grant inactive");
      const now = Math.floor(Date.now() / 1000); if (g.expiresAt <= now) throw Error("grant expired");
      const current = getAddress(await readers.wallet(g.agentId)); if (current !== g.boundWallet) throw Error("Passport binding changed");
      const recipient = getAddress(input.recipient); if (!g.recipients.includes(recipient)) throw Error("recipient not allowlisted");
      const amountWei = parseUnits(input.amount, 6); if (amountWei > BigInt(g.perActionWei)) throw Error("amount exceeds per-action limit");
      if (now >= g.periodStart + g.periodSeconds) { g.periodStart = now; g.spentWei = "0"; }
      if (BigInt(g.spentWei) + amountWei > BigInt(g.periodLimitWei)) throw Error("amount exceeds period budget");
      const invocationId = keccak256(toUtf8Bytes([g.grantId, input.requestId, recipient.toLowerCase(), amountWei].join("|")));
      const old = d.invocations[invocationId]; if (old) { result = { ...old, idempotentReplay: true }; return; }
      g.spentWei = (BigInt(g.spentWei) + amountWei).toString();
      result = { invocationId, grantId: g.grantId, agentId: g.agentId, from: g.boundWallet, recipient, amount: input.amount,
        amountWei: amountWei.toString(), appKitParams: { from: { chain: "Arc_Testnet", address: g.boundWallet }, to: recipient, amount: input.amount, token: "USDC" },
        unsignedTransaction: { chainId: 5042002, from: g.boundWallet, to: ARC.nativeToken, value: "0", data: usdc.encodeFunctionData("transfer", [recipient, amountWei]) },
        idempotentReplay: false, status: "reserved", next: "Attach a user-controlled App Kit adapter and call kit.send(appKitParams). No server signing." };
      d.invocations[invocationId] = result; await this.save(d);
    });
    this.queue = op.catch(() => undefined); await op; return result;
  }
  async verifySend(invocationId: string, txHash: string, provider: any) {
    const receipt = await provider.getTransactionReceipt(txHash);
    const tx = await provider.getTransaction(txHash);
    if (!receipt || !tx) throw Error("transaction not found");
    let result: any;
    const op = this.queue.then(async () => {
      const d = await this.load(); const invocation = d.invocations[invocationId]; if (!invocation) throw Error("invocation not found");
      if (invocation.status === "settled") {
        if (invocation.txHash !== txHash) throw Error("invocation receipt conflict");
        result = { ...invocation, idempotentReplay: true }; return;
      }
      const expectedData = usdc.encodeFunctionData("transfer", [invocation.recipient, BigInt(invocation.amountWei)]);
      if (getAddress(tx.from) !== getAddress(invocation.from) || getAddress(tx.to) !== getAddress(ARC.nativeToken) ||
          BigInt(tx.value) !== 0n || tx.data.toLowerCase() !== expectedData.toLowerCase()) throw Error("transaction does not match reserved Send");
      if (receipt.status !== 1) throw Error("Send transaction failed");
      invocation.status = "settled"; invocation.txHash = txHash; invocation.blockNumber = Number(receipt.blockNumber);
      invocation.explorer = `https://testnet.arcscan.app/tx/${txHash}`; result = invocation; await this.save(d);
    });
    this.queue = op.catch(() => undefined); await op; return result;
  }
}

export function defaultDelegationReaders(ctx: any): Readers {
  return {
    owner: async (vault) => new Contract(vault, AGENT_PAY_V3_VAULT_ABI, ctx.provider()).owner(),
    wallet: async (agentId) => new Contract(AGENT_PASSPORT_ADDRESS, AGENT_PASSPORT_ABI, ctx.provider()).walletOf(BigInt(agentId)),
  };
}
