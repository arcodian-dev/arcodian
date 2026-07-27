import { JsonRpcProvider } from "ethers";

export function rpcCandidates(fallback = "https://rpc.testnet.arc.network/") {
  return (process.env.ARC_RPC_URLS || process.env.ARC_RPC_URL || fallback)
    .split(",").map((value) => value.trim()).filter(Boolean);
}

export async function healthyProvider(options = {}) {
  const expectedChainId = BigInt(options.chainId || 5042002);
  const errors = [];
  for (const url of rpcCandidates(options.fallback)) {
    const provider = new JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== expectedChainId) throw new Error(`wrong chain ${network.chainId}`);
      await provider.getBlockNumber();
      return { provider, url, candidates: rpcCandidates(options.fallback).length };
    } catch (error) {
      errors.push(`${new URL(url).hostname}: ${String(error).slice(0, 100)}`);
      try { provider.destroy(); } catch {}
    }
  }
  throw new Error(`No healthy Arc RPC: ${errors.join("; ")}`);
}
