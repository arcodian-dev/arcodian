import { Interface, JsonRpcProvider } from "ethers";

const DEFAULT_RPCS = [
  "https://arcodian.fun/api/rpc-mainnet.php",
  "https://warp-arc-production.up.railway.app/rpc",
  "https://radar-api-rpc.up.railway.app",
];
const MESSAGE_TRANSMITTER = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";
const MESSAGE_RECEIVED_TOPIC = new Interface([
  "event MessageReceived(bytes32 indexed messageReceived,uint32 indexed sourceDomain,bytes32 indexed nonce,address indexed caller)",
]).getEvent("MessageReceived")!.topicHash;

function rpcUrls() {
  return (process.env.ARC_MAINNET_RPC_URLS || process.env.ARC_MAINNET_RPC_URL || DEFAULT_RPCS.join(","))
    .split(",").map((url) => url.trim()).filter(Boolean);
}

async function withMainnetProvider<T>(fn: (provider: JsonRpcProvider, url: string) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const url of rpcUrls()) {
    const provider = new JsonRpcProvider(url, { chainId: 5042, name: "arc-mainnet" }, { batchMaxCount: 1 });
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== 5042n) throw new Error(`wrong chain ${network.chainId}`);
      return await fn(provider, url);
    } catch (error) {
      errors.push(`${new URL(url).hostname}: ${String(error instanceof Error ? error.message : error).slice(0, 140)}`);
      try { provider.destroy(); } catch {}
    }
  }
  throw new Error(`No healthy Arc Mainnet RPC: ${errors.join("; ")}`);
}

export async function getMainnetTip() {
  return withMainnetProvider(async (provider, rpc) => ({
    chainId: 5042,
    localDomain: 26,
    rpc,
    block: await provider.getBlockNumber(),
    checkedAt: new Date().toISOString(),
  }));
}

export async function getMainnetBlock(input: { block?: number | string }) {
  return withMainnetProvider(async (provider, rpc) => {
    const blockTag = input.block == null ? "latest" : input.block;
    const block = await provider.getBlock(blockTag, false);
    if (!block) throw new Error(`block not found: ${String(blockTag)}`);
    return {
      chainId: 5042,
      rpc,
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
      date: new Date(block.timestamp * 1000).toISOString(),
      transactionCount: block.transactions.length,
      transactions: block.transactions,
    };
  });
}

export async function scanMessageReceived(input: { fromBlock?: number; toBlock?: number; messageHash?: string; limit?: number }) {
  const limit = Math.min(input.limit ?? 100, 500);
  return withMainnetProvider(async (provider, rpc) => {
    const latest = await provider.getBlockNumber();
    const toBlock = input.toBlock ?? latest;
    const fromBlock = input.fromBlock ?? Math.max(0, toBlock - 5_000);
    if (fromBlock < 0 || toBlock < fromBlock || toBlock - fromBlock > 10_000) {
      throw new Error("invalid block range; maximum scan range is 10,000 blocks");
    }
    const topics: string[] = [MESSAGE_RECEIVED_TOPIC];
    if (input.messageHash) topics.push(input.messageHash);
    const logs = await provider.getLogs({ address: MESSAGE_TRANSMITTER, fromBlock, toBlock, topics });
    const events = logs.slice(-limit).map((log) => ({
      block: log.blockNumber,
      transaction: log.transactionHash,
      logIndex: log.index,
      messageHash: log.topics[1] || null,
      sourceDomain: log.topics[2] ? Number(BigInt(log.topics[2])) : null,
      nonce: log.topics[3] || null,
      caller: log.topics[4] ? `0x${log.topics[4].slice(-40)}` : null,
    }));
    return {
      chainId: 5042,
      localDomain: 26,
      messageTransmitter: MESSAGE_TRANSMITTER,
      rpc,
      fromBlock,
      toBlock,
      latestBlock: latest,
      count: events.length,
      events,
    };
  });
}
