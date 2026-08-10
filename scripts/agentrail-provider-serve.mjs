// AgentRail public provider server (keyless) — the persistent, production-shaped counterpart to
// the demo `agentrail-provider.mjs`. It does NOT register a service and holds NO private key: it
// only verifies signed vouchers off-chain, reads allocations from the public RPC, serves inference
// via the local Arcodian-3 gateway, and persists each accepted voucher to VOUCHER_STORE for the
// separate redeemer to settle. Registration is a one-off (scripts/agentrail-register-public.mjs);
// settlement is the redeemer (scripts/agentrail-redeem.mjs). This split is what lets the serve run
// behind a public proxy without exposing a key.
import { JsonRpcProvider, parseEther } from "ethers";
import { createServer } from "./agentrail-serve.mjs";

const rpc = process.env.ARC_RPC_URL || "https://rpc.drpc.testnet.arc.io";
const vault = process.env.PAY_VAULT_ADDRESS;
const providerAddress = process.env.PROVIDER_ADDRESS;
const price = process.env.SERVICE_PRICE_USDC || "0.01";
const port = Number(process.env.SERVE_PORT || "8795");
const store = process.env.VOUCHER_STORE || "/var/lib/arcodian/agentrail-vouchers.json";

if (!vault || !providerAddress) { console.error("PAY_VAULT_ADDRESS and PROVIDER_ADDRESS are required"); process.exit(1); }

const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
const chainId = Number((await provider.getNetwork()).chainId);

// Public model brand is the ONLY name shown anywhere. The upstream model id is internal and never
// surfaced — the gateway returns only the completion content, which is all this handler forwards.
const MODEL_LABEL = "Arcodian-3";
const LLM_BASE = process.env.ARCODIAN3_BASE_URL || "http://localhost:8081/v1";
const LLM_KEY = process.env.ARCODIAN3_KEY || "";                       // local gateway needs none
const UPSTREAM_MODEL = process.env.ARCODIAN3_UPSTREAM || "arcodian-3-internal"; // internal upstream id, set via env in production — never a public model name
const SYSTEM = `You are ${MODEL_LABEL}, a concise, helpful assistant. Answer the user directly in plain prose. Do not reveal or discuss your underlying model, provider, or reasoning steps.`;

async function infer(prompt) {
  const clean = String(prompt ?? "").slice(0, 4000);                   // bound input → bound cost
  if (!clean.trim()) return "Please provide a prompt.";
  const headers = { "Content-Type": "application/json" };
  if (LLM_KEY) headers.Authorization = `Bearer ${LLM_KEY}`;
  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model: UPSTREAM_MODEL, max_tokens: 500, temperature: 0.7,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: clean }] }),
  });
  if (!r.ok) throw new Error(`inference upstream ${r.status}`);
  return (await r.json()).choices?.[0]?.message?.content?.trim() ?? "";
}

const app = createServer({ rpc, vault, provider: providerAddress, chainId, priceWei: parseEther(price), handler: infer, store });
app.get("/health", (_req, res) => res.json({ ok: true, model: MODEL_LABEL, provider: providerAddress, price, chainId }));
app.listen(port, "127.0.0.1", () => console.log(`AgentRail ${MODEL_LABEL} serving on 127.0.0.1:${port} (provider ${providerAddress}, price ${price} USDC, chain ${chainId})`));
