// One-off: point the provider's live service at the public endpoint. Deactivates any of this
// provider's stale services whose endpoint is a localhost URL (the demo/E2E leftovers), then
// registers one canonical service reachable at PUBLIC_ENDPOINT. Needs PROVIDER_PK. Metadata is
// stored inline as JSON (the directory/detail views JSON.parse it directly), model = Arcodian-3.
import { Wallet, JsonRpcProvider, Contract, parseEther, Interface } from "ethers";
import { readFileSync } from "node:fs";

const rpc = process.env.ARC_RPC_URL || "https://rpc.drpc.testnet.arc.io";
const registryAddr = process.env.SERVICE_REGISTRY_ADDRESS;
const pk = process.env.PROVIDER_PK;
const publicEndpoint = process.env.PUBLIC_ENDPOINT || "https://arcodian.fun";
const price = process.env.SERVICE_PRICE_USDC || "0.01";
const feedPath = process.env.SERVICE_FEED || "/www/wwwroot/arcodian.fun/shared/developers/services.json";
if (!registryAddr || !pk) { console.error("SERVICE_REGISTRY_ADDRESS and PROVIDER_PK are required"); process.exit(1); }

const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
const wallet = new Wallet(pk, provider);
const me = wallet.address.toLowerCase();
const ABI = [
  "function registerService(uint256,string,string) returns(bytes32)",
  "function deactivateService(bytes32)",
  "event ServiceRegistered(bytes32 indexed serviceId,address indexed provider,uint256 indexed agentId,uint256 price,string endpointURI,string metadataURI)",
];
const reg = new Contract(registryAddr, ABI, wallet);

// Deactivate this provider's stale localhost services so the directory shows one clean, callable one.
let feed = [];
try { const d = JSON.parse(readFileSync(feedPath, "utf8")); feed = Array.isArray(d) ? d : (d.services || []); } catch { /* no feed yet */ }
for (const s of feed) {
  if (String(s.provider).toLowerCase() === me && s.active && /localhost|127\.0\.0\.1/i.test(s.endpointURI || "")) {
    try { const tx = await reg.deactivateService(s.serviceId); console.log(`deactivating stale ${s.serviceId} (${s.endpointURI}) tx=${tx.hash}`); await tx.wait(); }
    catch (e) { console.error(`deactivate failed ${s.serviceId}:`, e?.shortMessage || e?.message || e); }
  }
}

const metadata = JSON.stringify({ name: "Arcodian-3 inference", model: "Arcodian-3", description: "One-shot LLM inference, metered per call via signed vouchers." });
const rc = await (await reg.registerService(parseEther(price), publicEndpoint, metadata)).wait();
const iface = new Interface(ABI);
const serviceId = rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "ServiceRegistered")?.args?.serviceId;
console.log(`registered public service ${serviceId} endpoint=${publicEndpoint} price=${price} provider=${wallet.address}`);
