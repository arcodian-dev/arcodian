// Read-only Wirex One / Animus Router adapter.
//
// The public Wirex One topology exposes chain registries and the Animus
// router health endpoint, but business endpoints require partner credentials.
// This adapter deliberately stops at authenticated-route discovery. It never
// fabricates a deposit reference and never broadcasts a transaction.

import { Contract, JsonRpcProvider, isAddress } from "ethers";

const ARC = {
  chainId: 5042,
  rpc: process.env.WIREX_ARC_RPC || "https://wirex-arc-mainnet-01.zeeve.net/qKO3H65PQ/rpc",
  registry: "0xC067b4cd7d902f0AD64731a7Fa7821C42efBF0A6",
  fundsManagement: "0xc1DB5B459BBaF9aEDB52E71937566856FeE67C4A",
  fundsBuffer: "0xC92531aAc48692F1E2fC8c1Ada8997433B952215",
  tokensRegistry: "0x7d5229Fe6c218A894eBcC6d55F261d1087D66664",
};

const BASE = {
  chainId: 8453,
  rpc: process.env.WIREX_BASE_RPC || "https://mainnet.base.org",
  registry: "0xAFa697ebC7919998AF5CdE325Fbe990dC926aae4",
};

const ANIMUS_ROUTER = process.env.ANIMUS_ROUTER_URL || "https://router.animus.finance";
const WIREX_BAAS_API = process.env.WIREX_BAAS_API || "https://api-baas.wirexapp.com";
const BUSINESS_PATHS = (process.env.ANIMUS_BUSINESS_PATHS ||
  "/quote,/route,/routes,/order,/orders,/deposit,/deposits,/v1/quote,/v1/route,/v1/order,/v1/deposit")
  .split(",").map((path) => path.trim()).filter(Boolean);

const REGISTRY_ABI = [
  "function owner() view returns(address)",
  "function getContract(string) view returns(address)",
  "function getAddress(bytes32) view returns(address)",
];
const ERC20_ABI = [
  "function symbol() view returns(string)",
  "function decimals() view returns(uint8)",
];

function output(value) {
  console.log(JSON.stringify(value, null, 2));
}

function deadline(promise, label, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: "manual" });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { url, status: response.status, contentType: response.headers.get("content-type"), body };
}

async function health() {
  output({ wirexBaasApi: WIREX_BAAS_API, router: ANIMUS_ROUTER, health: await fetchJson(`${ANIMUS_ROUTER}/health`), wirexConfig: await fetchJson(`${WIREX_BAAS_API}/api/v1/config`) });
}

async function wirexToken() {
  const clientId = process.env.WIREX_CLIENT_ID;
  const clientSecret = process.env.WIREX_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("WIREX_CLIENT_ID and WIREX_CLIENT_SECRET are required; credentials are never read from source files");
  const response = await fetchJson(`${WIREX_BAAS_API}/api/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
  });
  output({ wirexBaasApi: WIREX_BAAS_API, status: response.status, authenticated: response.status >= 200 && response.status < 300, body: response.status >= 200 && response.status < 300 ? { tokenReceived: true } : response.body });
}

async function inspectNetwork(network) {
  const provider = new JsonRpcProvider(network.rpc, network.chainId, { staticNetwork: true, batchMaxCount: 1 });
  try {
    const [tip, code, registryCode] = await deadline(Promise.all([
      provider.getBlockNumber(),
      provider.getCode(network.registry),
      provider.getCode(network.tokensRegistry || network.registry),
    ]), `${network.chainId} RPC probe`);
    const result = { network: network === ARC ? "arc" : "base", chainId: network.chainId, rpc: network.rpc, tip, registry: network.registry, registryCodeBytes: Math.max(0, (registryCode.length - 2) / 2), codeBytes: Math.max(0, (code.length - 2) / 2) };
    if (network === ARC) {
      const registry = new Contract(network.registry, REGISTRY_ABI, provider);
      const names = ["FundsManagement", "FundsBuffer", "TokensRegistry", "USDC", "EURC", "AUSD"];
      const entries = {};
      for (const name of names) {
        try {
          const address = await registry.getContract(name);
          if (isAddress(address) && address !== "0x0000000000000000000000000000000000000000") entries[name] = address;
        } catch {}
      }
      result.registryEntries = entries;
      for (const [name, address] of Object.entries({ USDC: "0x3600000000000000000000000000000000000000", ...entries })) {
        if (!isAddress(address)) continue;
        try {
          const token = new Contract(address, ERC20_ABI, provider);
          result[`${name.toLowerCase()}Metadata`] = { address, symbol: await token.symbol(), decimals: Number(await token.decimals()) };
        } catch {}
      }
    }
    return result;
  } catch (error) {
    return { network: network === ARC ? "arc" : "base", chainId: network.chainId, rpc: network.rpc, error: error instanceof Error ? error.message : String(error) };
  } finally { provider.destroy(); }
}

async function registry() {
  output({ adapter: "wirex-one-animus", networks: [await inspectNetwork(ARC), await inspectNetwork(BASE)], animusRouter: ANIMUS_ROUTER });
}

async function probe() {
  const results = [];
  for (const path of BUSINESS_PATHS) {
    for (const method of ["GET", "OPTIONS"]) {
      try { results.push({ method, path, ...(await fetchJson(`${ANIMUS_ROUTER}${path}`, { method })) }); }
      catch (error) { results.push({ method, path, error: error.message }); }
    }
  }
  output({ adapter: "wirex-one-animus", authenticated: false, health: await fetchJson(`${ANIMUS_ROUTER}/health`), routes: results, next: "Use partner credentials to call the confirmed business route; no deposit/order was created." });
}

const command = process.argv[2] || "health";
if (command === "health") await health();
else if (command === "wirex-token") await wirexToken();
else if (command === "registry") await registry();
else if (command === "probe") await probe();
else throw new Error("usage: node scripts/wirex-animus-adapter.mjs <health|wirex-token|registry|probe>");
