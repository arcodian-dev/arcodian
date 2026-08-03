import { z } from "zod";
import type { Ctx } from "../sources.ts";
import { findAgents, inspectAgent } from "./agents.ts";
import { listJobs, inspectJob } from "./jobs.ts";
import { inspectVault, inspectSpendingPolicy, getReceipt } from "./payments.ts";
import { buildCreateJob, buildSubmitJob, buildEvaluateJob, buildLeaveFeedback, quotePayment } from "./builders.ts";
import { inspectX402Challenge, quoteNanopayment, buildNanopaymentAuthorization, verifyNanopaymentReceipt } from "./nanopayments.ts";
import { FileNanopaymentLedger } from "../nanopayment-ledger.ts";
import { AppKitDelegationStore, buildRevokeTypedData, buildSendGrantTypedData, defaultDelegationReaders } from "../appkit-delegation.ts";
import { inspectUnifiedBalance } from "../appkit-unified-balance.ts";
import { AppKitBridgeStore, buildBridgeGrantTypedData, buildBridgeRevokeTypedData } from "../appkit-bridge.ts";
import { AppKitSwapStore, buildSwapGrantTypedData, buildSwapRevokeTypedData } from "../appkit-swap.ts";
import { getMainnetTip, getMainnetBlock, scanMessageReceived } from "./mainnet.ts";

export type Tool = { name: string; description: string; schema: z.ZodRawShape; handler: (args: any, ctx: Ctx) => Promise<any> };
const nanopaymentLedger = new FileNanopaymentLedger();
const appKitDelegations = new AppKitDelegationStore();
const appKitBridges = new AppKitBridgeStore();
const appKitSwaps = new AppKitSwapStore();
const inspectGrant = async (capability: "send" | "bridge" | "swap", grantId: string, ctx: Ctx) => {
  const store = capability === "send" ? appKitDelegations : capability === "bridge" ? appKitBridges : appKitSwaps;
  const grant = await store.get(grantId);
  if (!grant) throw new Error("grant not found");
  const currentWallet = await defaultDelegationReaders(ctx).wallet(grant.agentId);
  const { signature: _signature, ...safeGrant } = grant;
  const now = Math.floor(Date.now() / 1000);
  return {
    capability,
    ...safeGrant,
    currentPassportWallet: currentWallet,
    bindingCurrent: currentWallet.toLowerCase() === grant.boundWallet.toLowerCase(),
    expired: grant.expiresAt <= now,
    effectiveStatus: grant.revoked ? "revoked" : grant.expiresAt <= now ? "expired" :
      currentWallet.toLowerCase() !== grant.boundWallet.toLowerCase() ? "binding_changed" : "active",
    signingBoundary: "Owner-signed policy intent; execution still requires a user-controlled App Kit adapter.",
  };
};

export const TOOLS: Tool[] = [
  { name: "get_mainnet_tip", description: "Read the current Arc Mainnet chain tip (chain 5042) through failover RPCs. Read-only.", schema: {}, handler: async () => getMainnetTip() },
  { name: "get_mainnet_block", description: "Read one Arc Mainnet block and its transaction hashes. Defaults to latest. Read-only.", schema: { block: z.union([z.number().int().nonnegative(), z.string()]).optional() }, handler: async (args) => getMainnetBlock(args) },
  { name: "scan_message_received", description: "Scan Arc Mainnet MessageTransmitter for inbound CCTP MessageReceived events. Read-only.", schema: { fromBlock: z.number().int().nonnegative().optional(), toBlock: z.number().int().nonnegative().optional(), messageHash: z.string().optional(), limit: z.number().int().positive().max(500).optional() }, handler: async (args) => scanMessageReceived(args) },
  { name: "find_agents", description: "Discover ERC-8004 agents by minimum reputation, required independent validation, and optional capability tag. Returns objective score + evidence. Arcodian state on Arc testnet, not official Arc docs.",
    schema: { capability: z.string().optional(), minReputation: z.number().optional(), requireValidation: z.boolean().optional(), limit: z.number().int().positive().max(100).optional() },
    handler: findAgents },
  { name: "inspect_agent", description: "Full identity + reputation summary (score, dimensions, feedback/validation tiers, flags) for one agentId.",
    schema: { agentId: z.string() }, handler: inspectAgent },
  { name: "list_jobs", description: "List ArcAgentJobs escrow jobs, filterable by status/client/provider/providerAgentId.",
    schema: { status: z.enum(["Funded","Submitted","Completed","Rejected","Expired"]).optional(), client: z.string().optional(), provider: z.string().optional(), providerAgentId: z.string().optional(), limit: z.number().int().positive().max(200).optional() },
    handler: listJobs },
  { name: "inspect_job", description: "Authoritative on-chain job struct (RPC) merged with settlement evidence.",
    schema: { jobId: z.string() }, handler: inspectJob },
  { name: "inspect_vault", description: "AgentPay vault balance + owner.",
    schema: { vault: z.string() }, handler: inspectVault },
  { name: "inspect_spending_policy", description: "AgentPay spending policy for an agentId (per-payment, daily, spentToday, validity) and optional merchant allowance.",
    schema: { vault: z.string(), agentId: z.string(), merchant: z.string().optional() }, handler: inspectSpendingPolicy },
  { name: "get_receipt", description: "Resolve a settlement/payment receipt by tx hash (invoiceId lookup returns guidance in v1).",
    schema: { txHashOrInvoiceId: z.string() }, handler: getReceipt },
  { name: "quote_payment", description: "Advisory spending-policy check + UNSIGNED payInvoice transaction (simulated). Never signs.",
    schema: { vault: z.string(), agentId: z.string(), merchant: z.string(), amount: z.string(), invoiceId: z.string().optional() }, handler: quotePayment },
  { name: "build_create_job", description: "UNSIGNED ArcAgentJobs.createJob transaction (value = budget), simulated. Never signs.",
    schema: { client: z.string().optional(), provider: z.string(), evaluator: z.string(), budget: z.string(), expiry: z.number().int(), descHash: z.string().optional(), providerAgentId: z.string().optional() }, handler: buildCreateJob },
  { name: "build_submit_job", description: "UNSIGNED ArcAgentJobs.submit transaction, simulated.",
    schema: { jobId: z.string(), deliverableHash: z.string() }, handler: buildSubmitJob },
  { name: "build_evaluate_job", description: "UNSIGNED ArcAgentJobs.evaluate (approve/reject) transaction, simulated.",
    schema: { jobId: z.string(), approve: z.boolean(), evidenceHash: z.string().optional() }, handler: buildEvaluateJob },
  { name: "build_leave_feedback", description: "UNSIGNED Reputation giveFeedback transaction (score 0-100, decimals 0), simulated. Feedback counts as evidence-backed only if signed by the job's client/evaluator.",
    schema: { agentId: z.string(), score: z.number(), jobId: z.string().optional(), filehash: z.string().optional() }, handler: buildLeaveFeedback },
  { name: "inspect_x402_challenge", description: "Validate a PAYMENT-REQUIRED header against the official Arc Testnet Gateway batching configuration.",
    schema: { paymentRequired: z.string().max(32768) }, handler: inspectX402Challenge },
  { name: "quote_nanopayment", description: "Resolve Passport binding and enforce ArcPay seller/per-request/daily policy before an x402 payment.",
    schema: { paymentRequired: z.string().max(32768), agentId: z.string(), vault: z.string(), serviceId: z.string().max(128), requestHash: z.string() }, handler: quoteNanopayment },
  { name: "build_nanopayment_authorization", description: "Build deterministic UNSIGNED EIP-3009 typed data for Gateway Nanopayments. MCP never signs.",
    schema: { paymentRequired: z.string().max(32768), agentId: z.string(), vault: z.string(), serviceId: z.string().max(128), requestHash: z.string() },
    handler: (args, ctx) => buildNanopaymentAuthorization(args, ctx, undefined, nanopaymentLedger) },
  { name: "verify_nanopayment_receipt", description: "Fail-closed verification of PAYMENT-RESPONSE fields against the quoted payment and idempotency key.",
    schema: { paymentResponse: z.string().max(32768), payer: z.string(), idempotencyKey: z.string(), amount: z.string(), payTo: z.string(), network: z.string().optional(), transaction: z.string().optional() },
    handler: async (args) => verifyNanopaymentReceipt(args, nanopaymentLedger) },
  { name: "build_send_delegation", description: "Build owner-signed typed data for a scoped App Kit Send grant. Arc Testnet USDC only; no signing.",
    schema: { owner: z.string(), agentId: z.string(), vault: z.string(), recipients: z.array(z.string()).min(1).max(32), perAction: z.string(), periodLimit: z.string(), periodSeconds: z.number().int(), expiresAt: z.number().int(), nonce: z.string() },
    handler: async (args, ctx) => {
      const wallet = await defaultDelegationReaders(ctx).wallet(args.agentId);
      return buildSendGrantTypedData(args, wallet);
    } },
  { name: "activate_send_delegation", description: "Verify the vault owner's signature and persist an immutable scoped Send grant.",
    schema: { owner: z.string(), agentId: z.string(), vault: z.string(), recipients: z.array(z.string()).min(1).max(32), perAction: z.string(), periodLimit: z.string(), periodSeconds: z.number().int(), expiresAt: z.number().int(), nonce: z.string(), boundWallet: z.string(), signature: z.string() },
    handler: async (args, ctx) => {
      const { boundWallet, signature, ...grant } = args;
      return appKitDelegations.activate(grant, boundWallet, signature, defaultDelegationReaders(ctx));
    } },
  { name: "build_revoke_send_delegation", description: "Build owner-signed typed data to revoke one Send grant.",
    schema: { grantId: z.string(), nonce: z.string() }, handler: async (args) => buildRevokeTypedData(args.grantId, args.nonce) },
  { name: "revoke_send_delegation", description: "Verify the owner's revocation signature and disable the grant.",
    schema: { grantId: z.string(), nonce: z.string(), signature: z.string() }, handler: async (args) => appKitDelegations.revoke(args.grantId, args.nonce, args.signature) },
  { name: "build_appkit_send", description: "Reserve scoped budget and return App Kit Send params plus an unsigned Arc transaction. Never signs.",
    schema: { grantId: z.string(), recipient: z.string(), amount: z.string(), requestId: z.string() },
    handler: async (args, ctx) => appKitDelegations.buildSend(args, defaultDelegationReaders(ctx)) },
  { name: "verify_appkit_send_receipt", description: "Verify an App Kit Send transaction exactly matches its reserved invocation and persist settlement.",
    schema: { invocationId: z.string(), txHash: z.string() },
    handler: async (args, ctx) => appKitDelegations.verifySend(args.invocationId, args.txHash, ctx.provider()) },
  { name: "inspect_unified_balance", description: "Read Circle App Kit Unified Balance for the Agent's current Passport wallet on explicit USDC testnet chains.",
    schema: { agentId: z.string(), chains: z.array(z.string()).min(1).max(16).optional(), includePending: z.boolean().optional() },
    handler: async (args, ctx) => inspectUnifiedBalance(args, ctx) },
  { name: "build_bridge_delegation", description: "Build owner-signed typed data for a bounded Arc Testnet USDC App Kit Bridge grant; no signing.",
    schema: { owner: z.string(), agentId: z.string(), vault: z.string(), destinations: z.array(z.string()).min(1).max(8), recipients: z.array(z.string()).min(1).max(32), perAction: z.string(), periodLimit: z.string(), periodSeconds: z.number().int(), expiresAt: z.number().int(), nonce: z.string() },
    handler: async (args, ctx) => buildBridgeGrantTypedData(args, await defaultDelegationReaders(ctx).wallet(args.agentId)) },
  { name: "activate_bridge_delegation", description: "Verify the vault owner's signature and activate an immutable scoped Bridge grant.",
    schema: { owner: z.string(), agentId: z.string(), vault: z.string(), destinations: z.array(z.string()).min(1).max(8), recipients: z.array(z.string()).min(1).max(32), perAction: z.string(), periodLimit: z.string(), periodSeconds: z.number().int(), expiresAt: z.number().int(), nonce: z.string(), boundWallet: z.string(), signature: z.string() },
    handler: async (args, ctx) => { const { boundWallet, signature, ...grant } = args; return appKitBridges.activate(grant, boundWallet, signature, defaultDelegationReaders(ctx)); } },
  { name: "build_revoke_bridge_delegation", description: "Build owner-signed typed data to revoke one scoped Bridge grant.",
    schema: { grantId: z.string(), nonce: z.string() }, handler: async (args) => buildBridgeRevokeTypedData(args.grantId, args.nonce) },
  { name: "revoke_bridge_delegation", description: "Verify the owner's revocation signature and disable one Bridge grant.",
    schema: { grantId: z.string(), nonce: z.string(), signature: z.string() }, handler: async (args) => appKitBridges.revoke(args.grantId, args.nonce, args.signature) },
  { name: "build_appkit_bridge", description: "Reserve scoped Bridge budget and return fail-closed App Kit parameters; user adapters sign outside MCP.",
    schema: { grantId: z.string(), destination: z.string(), recipient: z.string(), amount: z.string(), requestId: z.string() },
    handler: async (args, ctx) => appKitBridges.build(args, defaultDelegationReaders(ctx)) },
  { name: "verify_appkit_bridge_receipt", description: "Verify Circle's decoded CCTP message plus exact successful burn and mint transactions.",
    schema: { invocationId: z.string(), burnTx: z.string(), mintTx: z.string() },
    handler: async (args, ctx) => appKitBridges.verify(args.invocationId, args.burnTx, args.mintTx, ctx.provider()) },
  { name: "build_swap_delegation", description: "Build owner-signed typed data for a bounded Arc Testnet USDC-to-EURC App Kit Swap grant.",
    schema: { owner: z.string(), agentId: z.string(), vault: z.string(), perAction: z.string(), periodLimit: z.string(), minRate: z.string(), maxSlippageBps: z.number().int(), periodSeconds: z.number().int(), expiresAt: z.number().int(), nonce: z.string() },
    handler: async (args, ctx) => buildSwapGrantTypedData(args, await defaultDelegationReaders(ctx).wallet(args.agentId)) },
  { name: "activate_swap_delegation", description: "Verify the vault owner's signature and activate an immutable scoped Swap grant.",
    schema: { owner: z.string(), agentId: z.string(), vault: z.string(), perAction: z.string(), periodLimit: z.string(), minRate: z.string(), maxSlippageBps: z.number().int(), periodSeconds: z.number().int(), expiresAt: z.number().int(), nonce: z.string(), boundWallet: z.string(), signature: z.string() },
    handler: async (args, ctx) => { const { boundWallet, signature, ...grant } = args; return appKitSwaps.activate(grant, boundWallet, signature, defaultDelegationReaders(ctx)); } },
  { name: "build_revoke_swap_delegation", description: "Build owner-signed typed data to revoke one scoped Swap grant.",
    schema: { grantId: z.string(), nonce: z.string() }, handler: async (args) => buildSwapRevokeTypedData(args.grantId, args.nonce) },
  { name: "revoke_swap_delegation", description: "Verify the owner's revocation signature and disable one Swap grant.",
    schema: { grantId: z.string(), nonce: z.string(), signature: z.string() }, handler: async (args) => appKitSwaps.revoke(args.grantId, args.nonce, args.signature) },
  { name: "build_appkit_swap", description: "Reserve scoped Swap budget and return Arc Testnet USDC-to-EURC App Kit parameters with an owner-set price floor.",
    schema: { grantId: z.string(), amountIn: z.string(), requestId: z.string() },
    handler: async (args, ctx) => appKitSwaps.build(args, defaultDelegationReaders(ctx)) },
  { name: "verify_appkit_swap_receipt", description: "Verify the official Arc App Kit adapter transaction and exact USDC debit/EURC minimum credit.",
    schema: { invocationId: z.string(), txHash: z.string() },
    handler: async (args, ctx) => appKitSwaps.verify(args.invocationId, args.txHash, ctx.provider()) },
  { name: "inspect_appkit_delegation", description: "Inspect a Send, Bridge, or Swap grant's effective status, current Passport binding, limits, and signing boundary without exposing its signature.",
    schema: { capability: z.enum(["send", "bridge", "swap"]), grantId: z.string() },
    handler: async (args, ctx) => inspectGrant(args.capability, args.grantId, ctx) },
];
