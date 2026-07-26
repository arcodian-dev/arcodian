import { Contract, Interface, TypedDataEncoder, formatUnits, getAddress, keccak256, parseUnits, toUtf8Bytes, verifyTypedData } from "ethers";
import { AGENT_PASSPORT_ADDRESS, ARC } from "./tools/_config.ts";
import { DurableJsonState } from "./durable-json-state.ts";

type Readers = { owner: (vault: string) => Promise<string>; wallet: (agentId: string) => Promise<string> };
type Input = { owner: string; agentId: string; vault: string; perAction: string; periodLimit: string; minRate: string; maxSlippageBps: number; periodSeconds: number; expiresAt: number; nonce: string };
type Store = { version: 1; grants: Record<string, any>; invocations: Record<string, any> };
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const ADAPTER = "0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b";
const domain = { name: "Arcodian AppKit Swap Delegation", version: "1", chainId: 5042002, verifyingContract: AGENT_PASSPORT_ADDRESS };
const types = { SwapDelegation: [
  { name: "owner", type: "address" }, { name: "agentId", type: "uint256" }, { name: "vault", type: "address" },
  { name: "boundWallet", type: "address" }, { name: "pairHash", type: "bytes32" },
  { name: "perAction", type: "uint256" }, { name: "periodLimit", type: "uint256" },
  { name: "minRate", type: "uint256" }, { name: "maxSlippageBps", type: "uint256" },
  { name: "periodSeconds", type: "uint256" }, { name: "expiresAt", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
const revokeTypes = { RevokeSwapDelegation: [{ name: "grantId", type: "bytes32" }, { name: "nonce", type: "bytes32" }] };
const pairHash = keccak256(toUtf8Bytes("Arc_Testnet|USDC|EURC"));
const transfer = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);

export function buildSwapGrantTypedData(input: Input, boundWallet: string) {
  if (input.maxSlippageBps < 1 || input.maxSlippageBps > 500) throw Error("maxSlippageBps out of range");
  if (input.periodSeconds < 60 || input.periodSeconds > 31_536_000) throw Error("invalid periodSeconds");
  if (input.expiresAt <= Math.floor(Date.now() / 1000)) throw Error("grant already expired");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.nonce)) throw Error("nonce must be bytes32");
  const message = { owner: getAddress(input.owner), agentId: input.agentId, vault: getAddress(input.vault), boundWallet: getAddress(boundWallet), pairHash,
    perAction: parseUnits(input.perAction, 6).toString(), periodLimit: parseUnits(input.periodLimit, 6).toString(),
    minRate: parseUnits(input.minRate, 6).toString(), maxSlippageBps: String(input.maxSlippageBps),
    periodSeconds: String(input.periodSeconds), expiresAt: String(input.expiresAt), nonce: input.nonce };
  if (BigInt(message.perAction) <= 0n || BigInt(message.perAction) > BigInt(message.periodLimit) || BigInt(message.minRate) <= 0n) throw Error("invalid grant limits");
  return { domain, types, primaryType: "SwapDelegation", message, grantId: TypedDataEncoder.hash(domain, types, message), chain: "Arc_Testnet", tokenIn: "USDC", tokenOut: "EURC" };
}
export function buildSwapRevokeTypedData(grantId: string, nonce: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(grantId) || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw Error("grantId and nonce must be bytes32");
  return { domain, types: revokeTypes, primaryType: "RevokeSwapDelegation", message: { grantId, nonce } };
}
export class AppKitSwapStore {
  readonly path: string; private queue: Promise<unknown> = Promise.resolve();
  private readonly state: DurableJsonState<Store>;
  constructor(path = process.env.MCP_APPKIT_SWAP_GRANTS || "/var/lib/arcodian-mcp/appkit-swap-grants.json") {
    this.path = path;
    this.state = new DurableJsonState("appkit-swap", path, { version: 1, grants: {}, invocations: {} },
      process.env.MCP_STATE_DB || (path === "/var/lib/arcodian-mcp/appkit-swap-grants.json" ? undefined : `${path}.db`));
  }
  private async load(): Promise<Store> { const d = this.state.read(); if (d?.version !== 1) throw Error("invalid swap store"); return d; }
  private async save(d: Store) { this.state.write(d); }
  async get(grantId: string) { return (await this.load()).grants[grantId] ?? null; }
  async activate(input: Input, boundWallet: string, signature: string, readers: Readers) {
    const typed = buildSwapGrantTypedData(input, boundWallet); const [owner, wallet] = await Promise.all([readers.owner(input.vault), readers.wallet(input.agentId)]);
    if (getAddress(owner) !== getAddress(input.owner)) throw Error("signer is not vault owner");
    if (getAddress(wallet) !== getAddress(boundWallet)) throw Error("Passport binding mismatch");
    if (getAddress(verifyTypedData(domain, types, typed.message, signature)) !== getAddress(input.owner)) throw Error("invalid owner signature");
    const grant = { ...input, owner: getAddress(input.owner), vault: getAddress(input.vault), boundWallet: getAddress(boundWallet), grantId: typed.grantId,
      perAction: typed.message.perAction, periodLimit: typed.message.periodLimit, minRate: typed.message.minRate, spent: "0", periodStart: Math.floor(Date.now() / 1000), revoked: false, signature };
    const op = this.queue.then(async () => { const d = await this.load(); d.grants[grant.grantId] ??= grant; await this.save(d); }); this.queue = op.catch(() => undefined); await op; return grant;
  }
  async revoke(grantId: string, nonce: string, signature: string) {
    const op = this.queue.then(async () => { const d = await this.load(); const g = d.grants[grantId]; if (!g) throw Error("grant not found"); const typed = buildSwapRevokeTypedData(grantId, nonce);
      if (getAddress(verifyTypedData(domain, revokeTypes, typed.message, signature)) !== g.owner) throw Error("invalid revocation signature"); g.revoked = true; await this.save(d); });
    this.queue = op.catch(() => undefined); await op; return { grantId, revoked: true };
  }
  async build(input: { grantId: string; amountIn: string; requestId: string }, readers: Readers) {
    let result: any; const op = this.queue.then(async () => { const d = await this.load(); const g = d.grants[input.grantId]; if (!g || g.revoked) throw Error("grant inactive");
      const now = Math.floor(Date.now() / 1000); if (g.expiresAt <= now) throw Error("grant expired"); if (getAddress(await readers.wallet(g.agentId)) !== g.boundWallet) throw Error("Passport binding changed");
      const amount = parseUnits(input.amountIn, 6); if (amount > BigInt(g.perAction)) throw Error("amount exceeds per-action limit");
      if (now >= g.periodStart + g.periodSeconds) { g.periodStart = now; g.spent = "0"; } if (BigInt(g.spent) + amount > BigInt(g.periodLimit)) throw Error("amount exceeds period budget");
      const stopUnits = amount * BigInt(g.minRate) / 1_000_000n; const invocationId = keccak256(toUtf8Bytes([g.grantId, input.requestId, amount].join("|")));
      if (d.invocations[invocationId]) { result = { ...d.invocations[invocationId], idempotentReplay: true }; return; } g.spent = (BigInt(g.spent) + amount).toString();
      result = { invocationId, grantId: g.grantId, agentId: g.agentId, from: g.boundWallet, chain: "Arc_Testnet", tokenIn: "USDC", tokenOut: "EURC",
        amountIn: input.amountIn, amountUnits: amount.toString(), stopLimit: formatUnits(stopUnits, 6), stopUnits: stopUnits.toString(),
        config: { allowanceStrategy: "approve", slippageBps: g.maxSlippageBps, stopLimit: formatUnits(stopUnits, 6) },
        status: "reserved", idempotentReplay: false, next: "Attach a user-controlled adapter and call AppKit.swap()." };
      d.invocations[invocationId] = result; await this.save(d);
    }); this.queue = op.catch(() => undefined); await op; return result;
  }
  async verify(invocationId: string, txHash: string, provider: any) {
    const [tx, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
    if (!tx?.to || receipt?.status !== 1 || getAddress(tx.to) !== getAddress(ADAPTER) || BigInt(tx.value) !== 0n) throw Error("swap transaction failed or wrong adapter");
    let result: any; const op = this.queue.then(async () => { const d = await this.load(); const i = d.invocations[invocationId]; if (!i) throw Error("invocation not found");
      if (getAddress(tx.from) !== getAddress(i.from)) throw Error("swap sender mismatch");
      if (Object.entries(d.invocations).some(([id, other]: any) => id !== invocationId && other.txHash === txHash)) throw Error("swap settlement replay");
      let input = 0n, output = 0n;
      for (const log of receipt.logs) { try { const parsed = transfer.parseLog(log); if (!parsed) continue;
        if (getAddress(log.address) === getAddress(ARC.nativeToken) && getAddress(parsed.args.from) === getAddress(i.from)) input += BigInt(parsed.args.value);
        if (getAddress(log.address) === getAddress(EURC) && getAddress(parsed.args.to) === getAddress(i.from)) output += BigInt(parsed.args.value);
      } catch {} }
      if (input !== BigInt(i.amountUnits) || output < BigInt(i.stopUnits)) throw Error("swap token deltas violate invocation");
      i.status = "settled"; i.txHash = txHash; i.amountOutUnits = output.toString(); i.amountOut = formatUnits(output, 6); result = i; await this.save(d);
    }); this.queue = op.catch(() => undefined); await op; return result;
  }
}
