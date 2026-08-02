// Relays completed CCTP V2 attestations to Arc Mainnet.
//
// Configuration is server-only JSON (default:
// /root/.config/arcodian/bridge-relayer.json):
// {
//   "privateKey": "0x...",
//   "arcRpc": "https://...",
//   "sourceRpcs": { "1": "...", "10": "...", "42161": "...", "8453": "..." },
//   "routers": { "1": "0x...", "10": "0x...", "42161": "0x...", "8453": "0x..." }
// }
//
// The relayer can never redirect a mint: mintRecipient is committed inside the
// Circle message by the source-chain router. It only pays destination gas.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { Contract, Interface, JsonRpcProvider, Wallet } from "ethers";

const CONFIG_PATH = process.env.BRIDGE_RELAYER_CONFIG || "/root/.config/arcodian/bridge-relayer.json";
const STATE_PATH = process.env.BRIDGE_RELAYER_STATE || "/root/.openclaw/workspace/arc/data/bridge-relayer-state.json";
const ARC_DOMAIN = 26;
const MESSAGE_TRANSMITTER = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";
const DOMAIN_BY_CHAIN = { 1: 0, 10: 2, 42161: 3, 8453: 6 };
const EVENT_ABI = [
  "event BridgeStarted(address indexed sender,bytes32 indexed mintRecipient,uint32 indexed destinationDomain,uint256 grossAmount,uint256 protocolFee,uint256 burnAmount,uint64 cctpNonce)",
];
const TRANSMITTER_ABI = [
  "function receiveMessage(bytes message,bytes attestation) returns(bool)",
  "function usedNonces(bytes32) view returns(uint256)",
];
const eventInterface = new Interface(EVENT_ABI);

async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}

async function saveState(value) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const temp = `${STATE_PATH}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, STATE_PATH);
}

async function circleMessage(sourceDomain, transactionHash) {
  const url = `https://iris-api.circle.com/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`;
  const response = await fetch(url, { headers: { "User-Agent": "ArcodianBridgeRelayer/1.0" } });
  if (!response.ok) return null;
  const message = (await response.json())?.messages?.[0];
  if (message?.status !== "complete" || typeof message.message !== "string" ||
      typeof message.attestation !== "string" || !message.attestation.startsWith("0x")) return null;
  return message;
}

async function main() {
  const config = await json(CONFIG_PATH, null);
  if (!config?.privateKey || !config?.arcRpc) throw new Error(`Invalid relayer config: ${CONFIG_PATH}`);

  const state = await json(STATE_PATH, { chains: {}, completed: {} });
  const arcProvider = new JsonRpcProvider(config.arcRpc, 5042, { staticNetwork: true, batchMaxCount: 1 });
  const signer = new Wallet(config.privateKey, arcProvider);
  const transmitter = new Contract(MESSAGE_TRANSMITTER, TRANSMITTER_ABI, signer);

  for (const [chainText, router] of Object.entries(config.routers || {})) {
    const chainId = Number(chainText);
    const rpc = config.sourceRpcs?.[chainText];
    const sourceDomain = DOMAIN_BY_CHAIN[chainId];
    if (!rpc || sourceDomain === undefined || !/^0x[a-fA-F0-9]{40}$/.test(router)) continue;

    const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true, batchMaxCount: 1 });
    try {
      const latest = await provider.getBlockNumber();
      const previous = Number(state.chains[chainText] || Math.max(0, latest - 5_000));
      const fromBlock = Math.min(previous + 1, latest);
      const logs = await provider.getLogs({
        address: router,
        topics: [eventInterface.getEvent("BridgeStarted").topicHash, null, null, `0x${ARC_DOMAIN.toString(16).padStart(64, "0")}`],
        fromBlock,
        toBlock: latest,
      });

      for (const log of logs) {
        const id = `${chainId}:${log.transactionHash}`;
        if (state.completed[id]) continue;
        const message = await circleMessage(sourceDomain, log.transactionHash);
        if (!message) continue;

        try {
          const tx = await transmitter.receiveMessage(message.message, message.attestation, { gasLimit: 350_000n });
          const receipt = await tx.wait();
          if (receipt?.status !== 1) throw new Error("Destination receipt failed");
          state.completed[id] = { mintHash: tx.hash, at: new Date().toISOString() };
          process.stdout.write(`relayed ${id} -> ${tx.hash}\n`);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (/already been received|nonce already used|already used/i.test(text)) {
            state.completed[id] = { mintHash: null, at: new Date().toISOString(), note: "already received" };
          } else {
            process.stderr.write(`relay failed ${id}: ${text}\n`);
          }
        }
        await saveState(state);
      }
      state.chains[chainText] = latest;
    } finally {
      provider.destroy();
    }
  }

  await saveState(state);
  arcProvider.destroy();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
