import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, formatUnits } from "ethers";
import { ARC, ARC_MAINNET, CHAINS, MAINNET_CHAINS } from "../config";
import ChainSelect from "./ChainSelect";
import {
  CCTP_DOMAIN, MESSAGE_TRANSMITTER_ABI,
  attestationCountdown, bridgeAttention, clearPendingClaim, fetchCctpAttestation, isMainnetBridgeChainId, loadBridgeHistory, loadPendingClaims, messageTransmitterFor, recordBridgeHistory, savePendingClaim,
  type Attestation, type BridgeHistoryItem, type PendingClaim,
} from "../bridgeRecovery";
import { rpcUrlsFor } from "../shared";
import { describeTxError } from "../txError";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

// Move the wallet to a chain, adding it first if the wallet doesn't have it yet
// (code 4902). Arc especially is rarely pre-added, which is why the claim seemed
// to "not switch" — the switch silently failed. Adding it makes it seamless.
async function switchOrAddChain(provider: Eip1193, chainId: number) {
  const hex = `0x${chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if ((err as { code?: number })?.code !== 4902) throw err;
    const chain = [...CHAINS, ...MAINNET_CHAINS].find((c) => c.id === chainId);
    const isArc = chainId === ARC.id || chainId === ARC_MAINNET.id;
    const arcNetwork = chainId === ARC_MAINNET.id ? ARC_MAINNET : ARC;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hex,
        chainName: chain?.name || (isArc ? arcNetwork.name : `Chain ${chainId}`),
        nativeCurrency: isArc
          ? { name: "USDC", symbol: "USDC", decimals: 18 }
          : { name: chain?.gasSymbol || "ETH", symbol: chain?.gasSymbol || "ETH", decimals: 18 },
        rpcUrls: isArc ? rpcUrlsFor(arcNetwork) : [chain?.rpc].filter(Boolean) as string[],
        blockExplorerUrls: isArc ? [arcNetwork.explorer] : [],
      }],
    });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }).catch(() => {});
  }
  // wallet_switchEthereumChain can resolve before the wallet's provider has
  // actually rotated networks — building a signer immediately after and
  // sending it a transaction then targets a node still on the old chain,
  // which several public RPCs reject as a malformed/"Bad Request" call
  // rather than a normal error. Confirm the switch actually landed first.
  let confirmed = "";
  for (let i = 0; i < 10; i++) {
    confirmed = String(await provider.request({ method: "eth_chainId" }));
    if (confirmed.toLowerCase() === hex.toLowerCase()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Your wallet is still on a different network. Switch to it manually, then try again.`);
}

type Props = {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
  // Changes whenever a fresh burn is saved, so the panel re-reads the pending queue.
  reloadSignal?: string;
};

const allBridgeChains = [...CHAINS, ...MAINNET_CHAINS];
const chainName = (id: number) => allBridgeChains.find((chain) => chain.id === id)?.name || `Chain ${id}`;
const chainExplorer = (id: number) => ({
  11155111: "https://sepolia.etherscan.io", 421614: "https://sepolia.arbiscan.io", 84532: "https://sepolia.basescan.org", 43113: "https://testnet.snowtrace.io", 11155420: "https://sepolia-optimism.etherscan.io", 80002: "https://amoy.polygonscan.com", [ARC.id]: ARC.explorer,
  1: "https://etherscan.io", 42161: "https://arbiscan.io", 10: "https://optimistic.etherscan.io", 8453: "https://basescan.org", [ARC_MAINNET.id]: ARC_MAINNET.explorer,
} as Record<number, string>)[id] || ARC.explorer;
// Manual "add a claim" only offers mainnet — matches the live Bridge page,
// which no longer surfaces testnet as an option. chainName/chainExplorer
// above still resolve testnet ids so an older pending/history entry from
// before this change still displays correctly.
const mainnetBridgeableChains = MAINNET_CHAINS.filter((chain) => CCTP_DOMAIN[chain.id] !== undefined);

function formatCountdown(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function attestationEta(item: PendingClaim, att: Attestation | null | undefined, now: number) {
  if (att?.ready) return "Attestation ready · relayer normally mints within 30 seconds";
  if (att?.status === "pending_confirmations") {
    const countdown = attestationCountdown(item, now);
    if (countdown.delayed) {
      return "Taking longer than usual · still checking Circle every 15 seconds";
    }
    return `Estimated readiness in ${formatCountdown(countdown.remainingSeconds)} · claim unlocks immediately when ready`;
  }
  if (att?.status) return `Circle status: ${att.status.replaceAll("_", " ")} · checking every 15 seconds`;
  return "Checking Circle every 15 seconds · no need to submit another bridge";
}

export default function BridgeClaim({ account, activeProvider, onConnect, reloadSignal }: Props) {
  const [queue, setQueue] = useState<PendingClaim[]>([]);
  const [history, setHistory] = useState<BridgeHistoryItem[]>([]);
  const [filter, setFilter] = useState<"active" | "completed" | "attention">("active");
  const [atts, setAtts] = useState<Record<string, Attestation | null>>({});
  const [busyHash, setBusyHash] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [manual, setManual] = useState(false);
  const [hash, setHash] = useState("");
  const [fromChainId, setFromChainId] = useState<number>(mainnetBridgeableChains.find((c) => /arc/i.test(c.name))?.id ?? mainnetBridgeableChains[0].id);
  const [toChainId, setToChainId] = useState<number>(mainnetBridgeableChains.find((c) => !/arc/i.test(c.name))?.id ?? mainnetBridgeableChains[0].id);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!queue.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [queue.length]);

  const reloadLocal = useCallback(() => {
    const isMainnetItem = (item: PendingClaim) =>
      isMainnetBridgeChainId(item.fromChainId) && isMainnetBridgeChainId(item.toChainId);
    setQueue(account ? loadPendingClaims(account).filter(isMainnetItem) : []);
    setHistory(account ? loadBridgeHistory(account).filter(isMainnetItem) : []);
  }, [account]);
  useEffect(() => { reloadLocal(); }, [reloadLocal, reloadSignal]);
  useEffect(() => {
    if (!account) return;
    let alive = true;
    fetch(`/api/bridge-history.php?address=${encodeURIComponent(account)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data: { history?: Array<BridgeHistoryItem & { attestationReady?: boolean }> }) => {
        if (!alive) return;
        for (const item of data.history || []) {
          if (!isMainnetBridgeChainId(item.fromChainId) || !isMainnetBridgeChainId(item.toChainId)) continue;
          if (item.status === "pending") savePendingClaim(account, item);
          else recordBridgeHistory(account, item);
        }
        reloadLocal();
      }).catch(() => undefined);
    return () => { alive = false; };
  }, [account, reloadLocal]);

  const check = useCallback(async (claim: PendingClaim) => {
    const result = await fetchCctpAttestation(claim.fromChainId, claim.burnHash);
    setAtts((prev) => ({ ...prev, [claim.burnHash]: result }));
    return result;
  }, []);

  // Poll every queued burn until it is ready to mint.
  useEffect(() => {
    if (!queue.length) return;
    let alive = true;
    const run = () => { queue.forEach((claim) => { if (alive) void check(claim); }); };
    run();
    const timer = setInterval(run, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, [queue, check]);

  async function claim(target: PendingClaim) {
    if (!account || !activeProvider) { onConnect(); return; }
    setBusyHash(target.burnHash);
    setStatus(`Checking Circle attestation for ${target.burnHash.slice(0, 10)}…`);
    try {
      const ready = atts[target.burnHash]?.ready ? atts[target.burnHash] : await check(target);
      if (!ready) { setStatus("This burn is not on Circle's records yet — it may still be indexing. Try again in a moment."); return; }
      if (!ready.ready) { setStatus(`Circle is still attesting (${ready.status}). Try again shortly.`); return; }

      setStatus(`Switching to ${chainName(target.toChainId)}…`);
      await switchOrAddChain(activeProvider, target.toChainId);
      const signer = await new BrowserProvider(activeProvider as never).getSigner();
      const transmitter = new Contract(messageTransmitterFor(target.toChainId), MESSAGE_TRANSMITTER_ABI, signer);
      setStatus(`Claiming on ${chainName(target.toChainId)} — confirm in your wallet.`);
      const tx = await transmitter.receiveMessage(ready.message, ready.attestation, { gasLimit: 350000n });
      await tx.wait();

      const amount = ready.amount ? `${formatUnits(BigInt(ready.amount), 6)} USDC` : "Your USDC";
      setStatus(`Done — ${amount} minted on ${chainName(target.toChainId)}.`);
      recordBridgeHistory(account, { ...target, status: "completed", mintHash: tx.hash });
      clearPendingClaim(account, target.burnHash);
      setQueue((q) => q.filter((c) => c.burnHash !== target.burnHash));
      setHistory(loadBridgeHistory(account));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already been received|nonce already used|already used/i.test(message)) {
        setStatus("Already claimed — your USDC is on the destination chain.");
        recordBridgeHistory(account, { ...target, status: "completed", note: "Destination mint was already completed." });
        clearPendingClaim(account, target.burnHash);
        setQueue((q) => q.filter((c) => c.burnHash !== target.burnHash));
        setHistory(loadBridgeHistory(account));
      } else if (/ACTION_REJECTED|user rejected|4001/i.test(message)) {
        setStatus("You rejected the claim in your wallet.");
      } else if (/insufficient funds|gas required/i.test(message)) {
        setStatus(`Not enough ${CHAINS.find((c) => c.id === target.toChainId)?.gasSymbol || "gas"} on ${chainName(target.toChainId)} to pay the mint gas — top it up and try again.`);
      } else {
        setStatus(describeTxError(error));
      }
    } finally {
      setBusyHash(null);
    }
  }

  function addManual() {
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) { setStatus("Paste a valid burn transaction hash."); return; }
    if (fromChainId === toChainId) { setStatus("Source and destination must differ."); return; }
    const claim: PendingClaim = { burnHash: hash, fromChainId, toChainId };
    if (account) savePendingClaim(account, claim);
    setQueue((q) => [claim, ...q.filter((c) => c.burnHash.toLowerCase() !== hash.toLowerCase())]);
    setHash("");
    setManual(false);
    setStatus("Added — checking Circle for its attestation…");
  }

  if (!queue.length && !manual) {
    return <><button type="button" className="bridge-claim-toggle" onClick={() => setManual(true)}>Claim a bridge from before? Add its hash →</button>{history.length > 0 && <BridgeHistory history={history} filter={filter} setFilter={setFilter} onResume={(item) => { savePendingClaim(account, item); reloadLocal(); }} />}</>;
  }

  return (
    <div className={queue.length ? "bridge-claim bridge-claim-active" : "bridge-claim"}>
      <div className="bridge-claim-head">
        <b>{queue.length ? "USDC in transit — claim it" : "Claim a pending bridge"}</b>
        {queue.length > 1 && <span className="claim-count">{queue.length} pending</span>}
      </div>

      {queue.map((item) => {
        const att = atts[item.burnHash];
        const rowBusy = busyHash === item.burnHash;
        return (
          <div className="bridge-claim-row" key={item.burnHash}>
            <div className="bridge-claim-row-info">
              <b>{item.amount ? `${formatUnits(BigInt(item.amount), 6)} USDC` : "USDC"}</b>
              <small>{chainName(item.fromChainId)} → {chainName(item.toChainId)} · {item.burnHash.slice(0, 8)}…{item.burnHash.slice(-4)}</small>
              {att && <span className={att.ready ? "claim-ready" : "claim-wait"}>{att.ready ? "● Ready" : `● ${att.status}`}</span>}
              <small className="bridge-claim-eta">{attestationEta(item, att, now)}</small>
            </div>
            <button type="button" className="primary bridge-claim-cta" disabled={busyHash !== null || (!!account && !att?.ready)} onClick={() => claim(item)}>
              {rowBusy ? "Working…" : !account ? "Connect" : !att?.ready ? "Waiting for Circle" : `Claim on ${chainName(item.toChainId)}`}
            </button>
          </div>
        );
      })}

      {manual && (
        <div className="bridge-claim-form">
          <label>Burn tx hash
            <input inputMode="text" placeholder="0x…" value={hash} onChange={(e) => setHash(e.target.value.trim())} />
          </label>
          <div className="bridge-claim-route">
            <label>From
              <ChainSelect value={fromChainId} options={mainnetBridgeableChains.map((c) => ({ id: c.id, name: c.name }))} onChange={setFromChainId} ariaLabel="Source network" />
            </label>
            <label>To
              <ChainSelect value={toChainId} options={mainnetBridgeableChains.map((c) => ({ id: c.id, name: c.name }))} onChange={setToChainId} ariaLabel="Destination network" />
            </label>
          </div>
          <button type="button" className="primary bridge-claim-cta" onClick={addManual}>Add to claim queue</button>
        </div>
      )}

      {status && <p className="bridge-claim-status">{status}</p>}

      {!manual
        ? <button type="button" className="bridge-claim-close" onClick={() => setManual(true)}>+ Add another burn hash</button>
        : <button type="button" className="bridge-claim-close" onClick={() => setManual(false)}>Close</button>}
      {history.length > 0 && <BridgeHistory history={history} filter={filter} setFilter={setFilter} onResume={(item) => { savePendingClaim(account, item); reloadLocal(); }} />}
    </div>
  );
}

function BridgeHistory({ history, filter, setFilter, onResume }: { history: BridgeHistoryItem[]; filter: "active" | "completed" | "attention"; setFilter: (value: "active" | "completed" | "attention") => void; onResume: (item: BridgeHistoryItem) => void }) {
  const visible = history.filter((item) => { const state = bridgeAttention(item); return filter === "completed" ? item.status === "completed" : filter === "attention" ? state.level === "attention" || state.level === "delayed" : item.status === "pending"; });
  return <section className="bridge-history"><header><div><small>BRIDGE HISTORY</small><b>Transfers & recovery</b></div><nav>{(["active","completed","attention"] as const).map((value) => <button className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{value}</button>)}</nav></header>{visible.map((item) => { const state = bridgeAttention(item); return <article key={item.burnHash} className={state.level}><div><b>{item.amount ? `${formatUnits(BigInt(item.amount), 6)} USDC` : "USDC"}</b><small>{chainName(item.fromChainId)} → {chainName(item.toChainId)}</small></div><span><em>{state.label}</em><small>{new Date(item.createdAt || item.updatedAt).toLocaleString()}</small></span><div className="bridge-history-actions"><a href={`${chainExplorer(item.fromChainId)}/tx/${item.burnHash}`} target="_blank" rel="noreferrer">Burn tx ↗</a>{item.mintHash && <a href={`${chainExplorer(item.toChainId)}/tx/${item.mintHash}`} target="_blank" rel="noreferrer">Mint tx ↗</a>}{item.status === "pending" && <button onClick={() => onResume(item)}>Retry / resume</button>}</div></article>; })}{!visible.length && <p>No transfers in this filter.</p>}</section>;
}
