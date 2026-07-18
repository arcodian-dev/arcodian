const BRIDGE = "0xC5567a5E3370d4DBfB0540025078e283e36A363d";
const ARC = { id: 5042002, name: "Arc Testnet", rpc: "https://rpc.testnet.arc.network/", token: "0x3600000000000000000000000000000000000000" };
const CHAINS = [
  { id: 11155111, name: "Ethereum Sepolia", token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  { id: 421614, name: "Arbitrum Sepolia", token: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  { id: 84532, name: "Base Sepolia", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  { id: 43113, name: "Avalanche Fuji", token: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  { id: 11155420, name: "OP Sepolia", token: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  { id: 80002, name: "Polygon Amoy", token: "0x41E94Eb019C0762f9BfcF9Fb1E58725BfB0e7582" },
  ARC,
];
const RPC = new Map([
  [ARC.id, ARC.rpc],
  [11155111, "https://ethereum-sepolia-rpc.publicnode.com"],
  [421614, "https://sepolia-rollup.arbitrum.io/rpc"],
  [84532, "https://sepolia.base.org"],
  [43113, "https://api.avax-test.network/ext/bc/C/rpc"],
  [11155420, "https://sepolia.optimism.io"],
  [80002, "https://rpc-amoy.polygon.technology"],
]);
const DOMAIN = new Map([
  [11155111, 0], [43113, 1], [11155420, 2], [421614, 3],
  [84532, 6], [80002, 7], [ARC.id, 26],
]);

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

const networks = CHAINS.filter((chain) => chain.id !== ARC.id);
const checks = [];
for (const chain of CHAINS) {
  const url = RPC.get(chain.id);
  const chainHex = await rpc(url, "eth_chainId");
  const tokenCode = await rpc(url, "eth_getCode", [chain.token, "latest"]);
  const bridgeCode = await rpc(url, "eth_getCode", [BRIDGE, "latest"]);
  checks.push({
    kind: "chain",
    network: chain.name,
    chainId: Number(BigInt(chainHex)),
    expectedChainId: chain.id,
    usdcCode: tokenCode !== "0x",
    bridgeCode: bridgeCode !== "0x",
    ok: Number(BigInt(chainHex)) === chain.id && tokenCode !== "0x" && bridgeCode !== "0x",
  });
}

for (const peer of networks) {
  for (const [source, destination] of [[ARC, peer], [peer, ARC]]) {
    const sourceDomain = DOMAIN.get(source.id);
    const destinationDomain = DOMAIN.get(destination.id);
    const url = `https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    const tiers = response.ok ? await response.json() : [];
    const standard = Array.isArray(tiers) && tiers.find((tier) => tier.finalityThreshold === 2000);
    checks.push({
      kind: "route",
      route: `${source.name} -> ${destination.name}`,
      sourceDomain,
      destinationDomain,
      standardFee: standard?.minimumFee,
      ok: response.ok && standard !== undefined,
    });
  }
}

const result = { ok: checks.every((check) => check.ok), checkedAt: new Date().toISOString(), checks };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
