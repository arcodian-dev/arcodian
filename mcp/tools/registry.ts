import { z } from "zod";
import type { Ctx } from "../sources.ts";
import { findAgents, inspectAgent } from "./agents.ts";
import { listJobs, inspectJob } from "./jobs.ts";
import { inspectVault, inspectSpendingPolicy, getReceipt } from "./payments.ts";
import { buildCreateJob, buildSubmitJob, buildEvaluateJob, buildLeaveFeedback, quotePayment } from "./builders.ts";
import { inspectX402Challenge, quoteNanopayment, buildNanopaymentAuthorization, verifyNanopaymentReceipt } from "./nanopayments.ts";
import { FileNanopaymentLedger } from "../nanopayment-ledger.ts";

export type Tool = { name: string; description: string; schema: z.ZodRawShape; handler: (args: any, ctx: Ctx) => Promise<any> };
const nanopaymentLedger = new FileNanopaymentLedger();

export const TOOLS: Tool[] = [
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
];
