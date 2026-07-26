import { Contract, TypedDataEncoder, getAddress, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { CHAIN_CONFIGS } from "@circle-fin/x402-batching/client";
import type { Ctx } from "../sources.ts";
import type { NanopaymentIntent, NanopaymentLedger } from "../nanopayment-ledger.ts";
import { AGENT_PASSPORT_ABI, AGENT_PASSPORT_ADDRESS, AGENT_PAY_V3_VAULT_ABI } from "./_config.ts";

const gateway = CHAIN_CONFIGS.arcTestnet;
export const ARC_X402 = {
  network: "eip155:5042002",
  domain: 26,
  usdc: getAddress(gateway.usdc),
  gatewayWallet: getAddress(gateway.gatewayWallet),
  gatewayMinter: getAddress(gateway.gatewayMinter),
  name: "GatewayWalletBatched",
  version: "1",
} as const;

type Requirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
};

export type ParsedChallenge = {
  x402Version: number;
  resource: { url?: string; description?: string; mimeType?: string };
  requirements: Requirements;
};

const addr = (value: unknown, field: string) => {
  try { return getAddress(String(value)); } catch { throw new Error(`invalid ${field}`); }
};

function decodeHeader(header: string) {
  if (!header || header.length > 32_768) throw new Error("PAYMENT-REQUIRED header missing or too large");
  let text: string;
  try { text = Buffer.from(header, "base64").toString("utf8"); } catch { throw new Error("invalid PAYMENT-REQUIRED encoding"); }
  if (Buffer.byteLength(text) > 24_576) throw new Error("decoded challenge too large");
  try { return JSON.parse(text); } catch { throw new Error("invalid PAYMENT-REQUIRED JSON"); }
}

export function parseX402Challenge(header: string): ParsedChallenge {
  const body = decodeHeader(header);
  if (body?.x402Version !== 2 || !Array.isArray(body.accepts)) throw new Error("unsupported x402 challenge");
  const option = body.accepts.find((x: any) =>
    x?.scheme === "exact" &&
    x?.network === ARC_X402.network &&
    String(x?.extra?.name) === ARC_X402.name,
  );
  if (!option) throw new Error("no Arc Gateway batching payment option");
  const amount = String(option.amount ?? "");
  if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("invalid payment amount");
  const timeout = Number(option.maxTimeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 604_900 || timeout > 1_209_600) {
    throw new Error("Gateway authorization validity outside allowed range");
  }
  const asset = addr(option.asset, "asset");
  const payTo = addr(option.payTo, "payTo");
  const verifyingContract = addr(option.extra?.verifyingContract, "verifyingContract");
  if (asset !== ARC_X402.usdc) throw new Error("unsupported asset");
  if (verifyingContract !== ARC_X402.gatewayWallet) throw new Error("untrusted Gateway verifying contract");
  if (option.extra?.version !== ARC_X402.version) throw new Error("unsupported Gateway version");
  return {
    x402Version: 2,
    resource: typeof body.resource === "object" && body.resource ? body.resource : {},
    requirements: { ...option, asset, payTo, maxTimeoutSeconds: timeout },
  };
}

export async function inspectX402Challenge(input: { paymentRequired: string }, ctx: Ctx) {
  const parsed = parseX402Challenge(input.paymentRequired);
  return { supported: true, chainId: 5042002, gatewayDomain: ARC_X402.domain, ...parsed, evidence: { source: "circle-sdk", block: await ctx.tipBlock() } };
}

type PolicyResult = { policy: any; allowed: boolean };
type BindingResult = { wallet: string };
export async function quoteNanopayment(
  input: { paymentRequired: string; agentId: string; vault: string; serviceId: string; requestHash: string },
  ctx: Ctx,
  readers?: { binding?: (agentId: string) => Promise<BindingResult>; policy?: (vault: string, agentId: string, merchant: string) => Promise<PolicyResult> },
) {
  const parsed = parseX402Challenge(input.paymentRequired);
  if (!input.serviceId || input.serviceId.length > 128) throw new Error("invalid serviceId");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.requestHash)) throw new Error("requestHash must be bytes32");
  const binding = readers?.binding ?? (async (agentId: string) => {
    const passport = new Contract(AGENT_PASSPORT_ADDRESS, AGENT_PASSPORT_ABI, ctx.provider());
    return { wallet: await passport.walletOf(BigInt(agentId)) };
  });
  const policy = readers?.policy ?? (async (vault: string, agentId: string, merchant: string) => {
    const c = new Contract(vault, AGENT_PAY_V3_VAULT_ABI, ctx.provider());
    const [p, allowed] = await Promise.all([c.policies(BigInt(agentId)), c.merchantAllowed(BigInt(agentId), merchant)]);
    return { policy: p, allowed };
  });
  const [{ wallet }, { policy: p, allowed }] = await Promise.all([
    binding(input.agentId),
    policy(input.vault, input.agentId, parsed.requirements.payTo),
  ]);
  const boundWallet = addr(wallet, "Passport wallet");
  const amount = BigInt(parsed.requirements.amount);
  // Gateway x402 amounts are USDC base units (6 decimals). ArcPay policies are
  // denominated in Arc's native USDC gas token (18 decimals).
  const policyAmount = amount * 1_000_000_000_000n;
  const reasons: string[] = [];
  if (boundWallet === "0x0000000000000000000000000000000000000000") reasons.push("agent has no bound Passport wallet");
  if (!p.enabled) reasons.push("policy disabled");
  if (!allowed) reasons.push("seller not allowlisted");
  if (policyAmount > BigInt(p.perPayment)) reasons.push("amount exceeds perPayment");
  if (BigInt(p.spentToday) + policyAmount > BigInt(p.dailyLimit)) reasons.push("amount exceeds remaining daily budget");
  if (Number(p.validUntil) <= Math.floor(Date.now() / 1000)) reasons.push("policy expired");
  const canonical = [
    "arcodian-x402-v1", input.agentId, boundWallet.toLowerCase(), input.vault.toLowerCase(),
    input.serviceId, input.requestHash.toLowerCase(), parsed.requirements.payTo.toLowerCase(),
    parsed.requirements.asset.toLowerCase(), parsed.requirements.amount, parsed.requirements.network,
  ].join("|");
  return {
    ok: reasons.length === 0, reasons, agentId: input.agentId, boundWallet, vault: input.vault,
    serviceId: input.serviceId, requestHash: input.requestHash, amount: parsed.requirements.amount,
    policyAmount: policyAmount.toString(),
    payTo: parsed.requirements.payTo, asset: parsed.requirements.asset,
    idempotencyKey: keccak256(toUtf8Bytes(canonical)), parsed,
    evidence: { source: "rpc+circle-sdk", block: await ctx.tipBlock(), passport: AGENT_PASSPORT_ADDRESS },
  };
}

export async function buildNanopaymentAuthorization(input: {
  paymentRequired: string; agentId: string; vault: string; serviceId: string; requestHash: string; now?: number;
}, ctx: Ctx, readers?: Parameters<typeof quoteNanopayment>[2], ledger?: NanopaymentLedger) {
  const quote = await quoteNanopayment(input, ctx, readers);
  if (!quote.ok) throw new Error(`policy rejected: ${quote.reasons.join(", ")}`);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (ledger) {
    const existing = await ledger.get(quote.idempotencyKey);
    if (existing) {
      if (existing.boundWallet !== quote.boundWallet || existing.amount !== quote.amount || existing.payTo !== quote.payTo ||
          existing.requestHash !== quote.requestHash || existing.serviceId !== quote.serviceId) {
        throw new Error("idempotency conflict");
      }
      const validBefore = Number((existing.typedData as any)?.message?.validBefore ?? 0);
      if (existing.status !== "settled" && validBefore <= now) throw new Error("stored authorization expired; use a new requestHash");
      return {
        ...quote, typedData: existing.typedData, authorizationDigest: existing.authorizationDigest,
        ledgerStatus: existing.status, idempotentReplay: true, receipt: existing.receipt ?? null,
        next: existing.status === "settled" ? "Return the stored receipt; do not submit another payment." : "Reuse this exact authorization; do not create a new nonce.",
      };
    }
  }
  const validBefore = now + quote.parsed.requirements.maxTimeoutSeconds;
  const message = {
    from: quote.boundWallet,
    to: quote.payTo,
    value: quote.amount,
    validAfter: "0",
    validBefore: String(validBefore),
    nonce: quote.idempotencyKey,
  };
  const domain = { name: ARC_X402.name, version: ARC_X402.version, chainId: 5042002, verifyingContract: ARC_X402.gatewayWallet };
  const types = { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ] };
  const authorization = {
    ...quote, typedData: { domain, types, primaryType: "TransferWithAuthorization", message },
    authorizationDigest: TypedDataEncoder.hash(domain, types, message),
    next: "Sign typedData with boundWallet; retry the same resource with the resulting Gateway PAYMENT-SIGNATURE. Never send the private key to Arcodian MCP.",
  };
  if (!ledger) return authorization;
  const record: NanopaymentIntent = {
    idempotencyKey: quote.idempotencyKey, createdAt: new Date(now * 1000).toISOString(),
    authorizationDigest: authorization.authorizationDigest, boundWallet: quote.boundWallet,
    agentId: quote.agentId, vault: quote.vault, serviceId: quote.serviceId,
    requestHash: quote.requestHash, amount: quote.amount, payTo: quote.payTo,
    asset: quote.asset, network: ARC_X402.network, typedData: authorization.typedData,
    status: "pending",
  };
  const stored = await ledger.put(record);
  return {
    ...authorization,
    typedData: stored.intent.typedData,
    authorizationDigest: stored.intent.authorizationDigest,
    ledgerStatus: stored.intent.status,
    idempotentReplay: stored.reused,
    receipt: stored.intent.receipt ?? null,
  };
}

export function enrichedReceiptStatement(proof: {
  transaction: string; network: string; payer: string; amount: string; payTo: string;
  idempotencyKey: string; requestHash: string; serviceId: string; authorizationDigest: string;
}) {
  return [
    "arcodian-x402-receipt-v1", proof.transaction, proof.network, proof.payer.toLowerCase(),
    proof.amount, proof.payTo.toLowerCase(), proof.idempotencyKey.toLowerCase(),
    proof.requestHash.toLowerCase(), proof.serviceId, proof.authorizationDigest.toLowerCase(),
  ].join("|");
}

export async function verifyNanopaymentReceipt(input: {
  paymentResponse: string; payer: string; idempotencyKey: string; amount: string; payTo: string; network?: string; transaction?: string;
}, ledger?: NanopaymentLedger) {
  const body = decodeHeader(input.paymentResponse);
  const expectedPayTo = addr(input.payTo, "payTo");
  const transaction = String(body.transaction ?? body.txHash ?? "");
  const settlementErrors: string[] = [];
  if (body.success !== true) settlementErrors.push("receipt not successful");
  if (String(body.network ?? "") !== (input.network ?? ARC_X402.network)) settlementErrors.push("network mismatch");
  if (addr(body.payer, "receipt payer") !== addr(input.payer, "payer")) settlementErrors.push("payer mismatch");
  if (!transaction) settlementErrors.push("transaction missing");
  if (input.transaction && transaction.toLowerCase() !== input.transaction.toLowerCase()) settlementErrors.push("transaction mismatch");
  const proof = { ...(body.extensions ?? {}), ...(body.extra ?? {}) };
  const bindingErrors: string[] = [];
  if (String(proof.amount ?? "") !== input.amount) bindingErrors.push("amount proof missing or mismatched");
  let receiptPayTo = "";
  try { receiptPayTo = addr(proof.payTo ?? proof.to, "receipt payTo"); } catch { bindingErrors.push("payTo proof missing or invalid"); }
  if (receiptPayTo && receiptPayTo !== expectedPayTo) bindingErrors.push("payTo mismatch");
  if (String(proof.idempotencyKey ?? "") !== input.idempotencyKey) bindingErrors.push("idempotency proof missing or mismatched");
  const intent = ledger ? await ledger.get(input.idempotencyKey) : null;
  if (ledger && !intent) bindingErrors.push("unknown idempotency key");
  if (intent) {
    if (intent.amount !== input.amount) bindingErrors.push("ledger amount mismatch");
    if (getAddress(intent.payTo) !== expectedPayTo) bindingErrors.push("ledger payTo mismatch");
    if (intent.boundWallet !== addr(input.payer, "payer")) bindingErrors.push("ledger payer mismatch");
    if (String(proof.requestHash ?? "") !== intent.requestHash) bindingErrors.push("requestHash proof missing or mismatched");
    if (String(proof.serviceId ?? "") !== intent.serviceId) bindingErrors.push("serviceId proof missing or mismatched");
    if (String(proof.authorizationDigest ?? "") !== intent.authorizationDigest) bindingErrors.push("authorization digest proof missing or mismatched");
  }
  try {
    const statement = enrichedReceiptStatement({
      transaction, network: String(body.network), payer: String(body.payer),
      amount: String(proof.amount), payTo: String(proof.payTo ?? proof.to),
      idempotencyKey: String(proof.idempotencyKey), requestHash: String(proof.requestHash),
      serviceId: String(proof.serviceId), authorizationDigest: String(proof.authorizationDigest),
    });
    if (addr(verifyMessage(statement, String(body.sellerSignature)), "receipt signer") !== expectedPayTo) {
      bindingErrors.push("seller signature mismatch");
    }
  } catch {
    bindingErrors.push("seller signature missing or invalid");
  }
  const verified = settlementErrors.length === 0 && bindingErrors.length === 0;
  if (verified && ledger) await ledger.settle(input.idempotencyKey, body);
  return {
    settlementVerified: settlementErrors.length === 0,
    paymentBindingVerified: verified,
    settlementErrors, bindingErrors, transaction: transaction || null, receipt: body,
    idempotentReplay: intent?.status === "settled",
  };
}
