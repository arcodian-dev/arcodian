// AgentRail demo provider: registers an "Arcodian-3" inference service and serves paid calls.
// Inference is served internally by the local gateway on :8081; the public model name is Arcodian-3.
import { Wallet, JsonRpcProvider, Contract, parseEther, Interface } from "ethers";
import { createServer } from "../agentrail-serve.mjs";

const rpc = process.env.ARC_RPC_URL || "https://rpc.drpc.testnet.arc.io";
const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
const wallet = new Wallet(process.env.PROVIDER_PK, provider);
const chainId = Number((await provider.getNetwork()).chainId);

const MODEL_LABEL = "Arcodian-3";                                   // public brand — the ONLY name shown anywhere
const LLM_BASE = process.env.ARCODIAN3_BASE_URL || "http://localhost:8081/v1";
const LLM_KEY = process.env.ARCODIAN3_KEY;                          // = ARCODIAN3_UPSTREAM_KEY
const UPSTREAM_MODEL = process.env.ARCODIAN3_UPSTREAM || "arcodian-3-internal"; // internal only — never registered/printed
async function infer(prompt) {
  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: UPSTREAM_MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`inference upstream ${r.status}`);
  return (await r.json()).choices?.[0]?.message?.content ?? "";
}

const REG_ABI = ["function registerService(uint256,string,string) returns(bytes32)", "event ServiceRegistered(bytes32 indexed serviceId,address indexed provider,uint256 indexed agentId,uint256 price,string endpointURI,string metadataURI)"];
const reg = new Contract(process.env.SERVICE_REGISTRY_ADDRESS, REG_ABI, wallet);
const endpointURI = process.env.PROVIDER_URL || "http://localhost:8795";
const price = "0.01";

const rc = await (await reg.registerService(parseEther(price), endpointURI, JSON.stringify({ name: "Arcodian-3 inference", model: MODEL_LABEL }))).wait();
const iface = new Interface(REG_ABI);
const serviceId = rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "ServiceRegistered").args.serviceId;
console.log("registered serviceId", serviceId, "provider", wallet.address);

const app = createServer({ rpc, vault: process.env.PAY_VAULT_ADDRESS, provider: wallet.address, chainId, priceWei: parseEther(price), handler: infer });
app.listen(8795, () => console.log("provider serving on", endpointURI));
