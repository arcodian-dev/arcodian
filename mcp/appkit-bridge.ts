import { Contract, Interface, JsonRpcProvider, TypedDataEncoder, getAddress, keccak256, parseUnits, toUtf8Bytes, verifyTypedData } from "ethers";
import { AGENT_PASSPORT_ADDRESS, ARC } from "./tools/_config.ts";
import { DurableJsonState } from "./durable-json-state.ts";

type Readers = { owner: (vault: string) => Promise<string>; wallet: (agentId: string) => Promise<string> };
type BridgeGrantInput = {
  owner: string; agentId: string; vault: string; destinations: string[]; recipients: string[];
  perAction: string; periodLimit: string; periodSeconds: number; expiresAt: number; nonce: string;
};
type Store = { version: 1; grants: Record<string, any>; invocations: Record<string, any> };
const domain = { name: "Arcodian AppKit Bridge Delegation", version: "1", chainId: 5042002, verifyingContract: AGENT_PASSPORT_ADDRESS };
const types = { BridgeDelegation: [
  { name: "owner", type: "address" }, { name: "agentId", type: "uint256" }, { name: "vault", type: "address" },
  { name: "boundWallet", type: "address" }, { name: "destinationsHash", type: "bytes32" },
  { name: "recipientsHash", type: "bytes32" }, { name: "perAction", type: "uint256" },
  { name: "periodLimit", type: "uint256" }, { name: "periodSeconds", type: "uint256" },
  { name: "expiresAt", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
const revokeTypes = { RevokeBridgeDelegation: [{ name: "grantId", type: "bytes32" }, { name: "nonce", type: "bytes32" }] };
const hashList = (items: string[]) => keccak256(toUtf8Bytes([...items].map((x) => x.toLowerCase()).sort().join("|")));
const routes: Record<string, { domain: string; rpc: string; transmitter: string }> = {
  Base_Sepolia: { domain: "6", rpc: "https://sepolia.base.org", transmitter: "0xe737e5cebeeba77efe34d4aa090756590b1ce275" },
};
const receive = new Interface(["function receiveMessage(bytes message,bytes attestation) returns(bool)"]);

export function buildBridgeGrantTypedData(input: BridgeGrantInput, boundWallet: string) {
  if (!input.destinations.length || input.destinations.some((x) => !routes[x])) throw Error("unsupported destination route");
  if (!input.recipients.length || input.recipients.length > 32) throw Error("recipient allowlist required");
  if (input.periodSeconds < 60 || input.periodSeconds > 31_536_000) throw Error("invalid periodSeconds");
  if (input.expiresAt <= Math.floor(Date.now() / 1000)) throw Error("grant already expired");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.nonce)) throw Error("nonce must be bytes32");
  const message = {
    owner: getAddress(input.owner), agentId: input.agentId, vault: getAddress(input.vault), boundWallet: getAddress(boundWallet),
    destinationsHash: hashList(input.destinations), recipientsHash: hashList(input.recipients.map(getAddress)),
    perAction: parseUnits(input.perAction, 6).toString(), periodLimit: parseUnits(input.periodLimit, 6).toString(),
    periodSeconds: String(input.periodSeconds), expiresAt: String(input.expiresAt), nonce: input.nonce,
  };
  if (BigInt(message.perAction) <= 0n || BigInt(message.perAction) > BigInt(message.periodLimit)) throw Error("invalid grant limits");
  return { domain, types, primaryType: "BridgeDelegation", message, grantId: TypedDataEncoder.hash(domain, types, message), source: "Arc_Testnet", token: "USDC", transferSpeed: "SLOW", maxFee: "0" };
}
export function buildBridgeRevokeTypedData(grantId: string, nonce: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(grantId) || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw Error("grantId and nonce must be bytes32");
  return { domain, types: revokeTypes, primaryType: "RevokeBridgeDelegation", message: { grantId, nonce } };
}

export class AppKitBridgeStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;
  private readonly state: DurableJsonState<Store>;
  constructor(path = process.env.MCP_APPKIT_BRIDGE_GRANTS || "/var/lib/arcodian-mcp/appkit-bridge-grants.json") {
    this.path = path;
    this.state = new DurableJsonState("appkit-bridge", path, { version: 1, grants: {}, invocations: {} },
      process.env.MCP_STATE_DB || (path === "/var/lib/arcodian-mcp/appkit-bridge-grants.json" ? undefined : `${path}.db`));
  }
  private async load(): Promise<Store> { const d = this.state.read(); if (d?.version !== 1) throw Error("invalid bridge store"); return d; }
  private async save(d: Store) { this.state.write(d); }
  async get(grantId: string) { return (await this.load()).grants[grantId] ?? null; }
  async activate(input: BridgeGrantInput, boundWallet: string, signature: string, readers: Readers) {
    const typed = buildBridgeGrantTypedData(input, boundWallet);
    const [owner, wallet] = await Promise.all([readers.owner(input.vault), readers.wallet(input.agentId)]);
    if (getAddress(owner) !== getAddress(input.owner)) throw Error("signer is not vault owner");
    if (getAddress(wallet) !== getAddress(boundWallet)) throw Error("Passport binding mismatch");
    if (getAddress(verifyTypedData(domain, types, typed.message, signature)) !== getAddress(input.owner)) throw Error("invalid owner signature");
    const grant = { ...input, owner: getAddress(input.owner), vault: getAddress(input.vault), boundWallet: getAddress(boundWallet),
      recipients: input.recipients.map(getAddress), grantId: typed.grantId, perAction: typed.message.perAction,
      periodLimit: typed.message.periodLimit, spent: "0", periodStart: Math.floor(Date.now() / 1000), revoked: false, signature };
    const op = this.queue.then(async () => { const d = await this.load(); d.grants[grant.grantId] ??= grant; await this.save(d); });
    this.queue = op.catch(() => undefined); await op; return grant;
  }
  async revoke(grantId: string, nonce: string, signature: string) {
    const op = this.queue.then(async () => { const d = await this.load(); const g = d.grants[grantId]; if (!g) throw Error("grant not found");
      const typed = buildBridgeRevokeTypedData(grantId, nonce);
      if (getAddress(verifyTypedData(domain, revokeTypes, typed.message, signature)) !== g.owner) throw Error("invalid revocation signature");
      g.revoked = true; await this.save(d); });
    this.queue = op.catch(() => undefined); await op; return { grantId, revoked: true };
  }
  async build(input: { grantId: string; destination: string; recipient: string; amount: string; requestId: string }, readers: Readers) {
    let result: any;
    const op = this.queue.then(async () => { const d = await this.load(); const g = d.grants[input.grantId];
      if (!g || g.revoked) throw Error("grant inactive"); const now = Math.floor(Date.now() / 1000);
      if (g.expiresAt <= now) throw Error("grant expired"); if (getAddress(await readers.wallet(g.agentId)) !== g.boundWallet) throw Error("Passport binding changed");
      if (!g.destinations.includes(input.destination) || !routes[input.destination]) throw Error("destination not allowlisted");
      const recipient = getAddress(input.recipient); if (!g.recipients.includes(recipient)) throw Error("recipient not allowlisted");
      const amount = parseUnits(input.amount, 6); if (amount > BigInt(g.perAction)) throw Error("amount exceeds per-action limit");
      if (now >= g.periodStart + g.periodSeconds) { g.periodStart = now; g.spent = "0"; }
      if (BigInt(g.spent) + amount > BigInt(g.periodLimit)) throw Error("amount exceeds period budget");
      const invocationId = keccak256(toUtf8Bytes([g.grantId, input.requestId, input.destination, recipient.toLowerCase(), amount].join("|")));
      if (d.invocations[invocationId]) { result = { ...d.invocations[invocationId], idempotentReplay: true }; return; }
      g.spent = (BigInt(g.spent) + amount).toString();
      result = { invocationId, grantId: g.grantId, agentId: g.agentId, from: g.boundWallet, source: "Arc_Testnet",
        destination: input.destination, destinationDomain: routes[input.destination].domain, recipient, amount: input.amount,
        amountUnits: amount.toString(), token: "USDC", config: { transferSpeed: "SLOW", maxFee: "0", batchTransactions: false },
        status: "reserved", idempotentReplay: false, next: "Attach user-controlled adapters to from/to and call AppKit.bridge()." };
      d.invocations[invocationId] = result; await this.save(d);
    });
    this.queue = op.catch(() => undefined); await op; return result;
  }
  async verify(invocationId: string, burnTx: string, mintTx: string, sourceProvider: any, fetcher: typeof fetch = fetch) {
    const [burn, burnReceipt] = await Promise.all([sourceProvider.getTransaction(burnTx), sourceProvider.getTransactionReceipt(burnTx)]);
    if (!burn || burnReceipt?.status !== 1) throw Error("burn transaction failed or missing");
    let result: any;
    const op = this.queue.then(async () => { const d = await this.load(); const i = d.invocations[invocationId]; if (!i) throw Error("invocation not found");
      if (getAddress(burn.from) !== getAddress(i.from)) throw Error("burn sender mismatch");
      const response = await fetcher(`https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=${burnTx}`);
      if (!response.ok) throw Error(`Circle message API ${response.status}`); const item = (await response.json()).messages?.[0];
      const body = item?.decodedMessage?.decodedMessageBody;
      if (item?.status !== "complete" || item.decodedMessage?.sourceDomain !== "26" ||
          item.decodedMessage?.destinationDomain !== i.destinationDomain || getAddress(body?.burnToken) !== getAddress(ARC.nativeToken) ||
          getAddress(body?.mintRecipient) !== getAddress(i.recipient) || body?.amount !== i.amountUnits || body?.maxFee !== "0" || body?.feeExecuted !== "0") throw Error("Circle bridge message mismatch");
      const replay = Object.entries(d.invocations).find(([id, other]: any) =>
        id !== invocationId && other.status === "settled" &&
        (other.burnTx === burnTx || other.eventNonce === item.eventNonce));
      if (replay) throw Error("bridge settlement replay");
      const route = routes[i.destination]; const destinationProvider = new JsonRpcProvider(route.rpc);
      const [mint, mintReceipt] = await Promise.all([destinationProvider.getTransaction(mintTx), destinationProvider.getTransactionReceipt(mintTx)]);
      if (!mint?.to || mintReceipt?.status !== 1 || getAddress(mint.to) !== getAddress(route.transmitter)) throw Error("mint transaction failed or missing");
      const decoded = receive.decodeFunctionData("receiveMessage", mint.data);
      if (keccak256(decoded.message) !== keccak256(item.message)) throw Error("mint message mismatch");
      i.status = "settled"; i.burnTx = burnTx; i.mintTx = mintTx; i.eventNonce = item.eventNonce; result = i; await this.save(d);
    });
    this.queue = op.catch(() => undefined); await op; return result;
  }
}
