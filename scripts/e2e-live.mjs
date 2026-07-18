import { Interface, JsonRpcProvider } from "ethers";

const origin = process.env.E2E_ORIGIN || "https://arcodian.fun";
const rpcUrls = (process.env.E2E_ARC_RPCS || [
  "https://rpc.testnet.arc.network/",
  "https://rpc.blockdaemon.testnet.arc.io",
  "https://rpc.drpc.testnet.arc.io",
  "https://rpc.quicknode.testnet.arc.io",
].join(",")).split(",").map((value) => value.trim()).filter(Boolean);
const expectedChainId = 5042002;
const contracts = {
  suite: "0x8F4FAF89f3d6f2f4Ad535df7faF3B5787BA35020",
  pumpFactory: "0x454529204A0B0846Cc0dF37CFdFf3De8541B36e4",
  dexFactory: "0xC933eCeb3Ca62f31E7DD1D2538e6cfE879c5bDdA",
  legacySuiteV5: "0x6601aD6C8a32cB5e1217d1304457e2C9F8778094",
  usdc: "0x3600000000000000000000000000000000000000",
  eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
};
const checks = [];
const record = (name, ok, detail = "") => checks.push({ name, ok, detail });

async function get(path, kind = "text") {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return kind === "json" ? response.json() : response.text();
}

for (const route of ["/", "/market", "/swap", "/bridge", "/profile", "/contracts", "/faq", "/how", "/canary"]) {
  try {
    const html = await get(route);
    record(`route ${route}`, html.includes('<div id="root"></div>') && html.includes("/assets/"), "SPA shell + asset");
  } catch (error) { record(`route ${route}`, false, String(error)); }
}

let marketIndex;
try {
  marketIndex = await get("/data/market-index.json", "json");
  record("market index schema", marketIndex.version >= 5 && marketIndex.chainId === expectedChainId && Array.isArray(marketIndex.launches), `v${marketIndex.version}, ${marketIndex.launches?.length || 0} markets`);
  record("engine version labels", marketIndex.launches.every((market) => [5, 6, 7].includes(market.engineVersion)), "all markets declare v5/v6/v7");
} catch (error) { record("market index schema", false, String(error)); }

try {
  const health = await get("/api/health.php", "json");
  record("API health", health.status === "ok" && health.chain === expectedChainId && health.uploadsWritable === true, `block ${health.block || "unknown"}`);
} catch (error) { record("API health", false, String(error)); }

let provider;
for (const rpcUrl of rpcUrls) {
  try {
    const candidate = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, batchMaxCount: 1 });
    const network = await candidate.getNetwork();
    record(`RPC ${new URL(rpcUrl).hostname}`, Number(network.chainId) === expectedChainId, `chain ${network.chainId}`);
    if (!provider && Number(network.chainId) === expectedChainId) provider = candidate;
  } catch (error) { record(`RPC ${new URL(rpcUrl).hostname}`, false, String(error).slice(0, 160)); }
}

if (provider) {
  for (const [name, address] of Object.entries(contracts)) {
    try { record(`bytecode ${name}`, (await provider.getCode(address)) !== "0x", address); }
    catch (error) { record(`bytecode ${name}`, false, String(error)); }
  }
  try {
    const sample = marketIndex?.launches?.find((market) => market.creator)?.creator || contracts.pumpFactory;
    const native = await provider.getBalance(sample);
    const usdc = new Interface(["function balanceOf(address) view returns(uint256)"]);
    const raw = await provider.call({ to: contracts.usdc, data: usdc.encodeFunctionData("balanceOf", [sample]) });
    const erc20 = usdc.decodeFunctionResult("balanceOf", raw)[0];
    record("dual USDC balance coherence", native / 1_000_000_000_000n === erc20, `native18=${native}, erc20_6=${erc20}`);
  } catch (error) { record("dual USDC balance coherence", false, String(error)); }
  try {
    const txHash = marketIndex?.activity?.[0]?.tx;
    const receipt = txHash ? await provider.getTransactionReceipt(txHash) : null;
    record("indexed transaction final", Boolean(receipt?.status === 1), txHash || "no indexed transaction");
  } catch (error) { record("indexed transaction final", false, String(error)); }
}

const result = { ok: checks.every((check) => check.ok), checkedAt: new Date().toISOString(), origin, checks };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
