import { useEffect, useMemo, useState } from "react";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { ARC_MAINNET, ARC_MAINNET_CONTRACTS } from "../config";
import "./AUSD.css";

type Props = {
  account: string;
  chainId: number | null;
  activeProvider: EthereumProvider | null;
  connect: () => void;
};

const ERC20_ABI = ["function balanceOf(address) view returns(uint256)"];
const ADAPTER_ABI = [
  "function intentCount() view returns(uint256)",
  "function tokenRegistry() view returns(address)",
  "function proofVerifier() view returns(address)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns(address)"];
const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x3600000000000000000000000000000000000000";
const PEERS = [
  ["Arbitrum One", "3"],
  ["Base", "6"],
  ["Ethereum", "0"],
  ["Optimism", "2"],
] as const;

function short(value: string) { return `${value.slice(0, 6)}…${value.slice(-4)}`; }

export default function AUSD({ account, chainId, activeProvider, connect }: Props) {
  const read = useMemo(() => new JsonRpcProvider(ARC_MAINNET.rpc, { chainId: ARC_MAINNET.id, name: ARC_MAINNET.name }, { batchMaxCount: 1 }), []);
  const [source, setSource] = useState("Arbitrum One");
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<string | null>(null);
  const [intentCount, setIntentCount] = useState<string | null>(null);
  const [protocolReady, setProtocolReady] = useState(false);
  const [swapPool, setSwapPool] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState("");
  const [simulating, setSimulating] = useState(false);

  useEffect(() => () => read.destroy(), [read]);

  useEffect(() => {
    let alive = true;
    const adapter = new Contract(ARC_MAINNET_CONTRACTS.ausdIntentSettlement, ADAPTER_ABI, read);
    const token = new Contract(ARC_MAINNET_CONTRACTS.ausd, ERC20_ABI, read);
    const factory = new Contract(ARC_MAINNET_CONTRACTS.externalV3Factory, FACTORY_ABI, read);
    Promise.all([
      adapter.intentCount(),
      adapter.tokenRegistry(),
      adapter.proofVerifier(),
      factory.getPool(ARC_MAINNET_CONTRACTS.ausd, USDC, 3000),
    ]).then(([count, registry, verifier, pool]) => {
      if (!alive) return;
      setIntentCount(Number(count).toLocaleString());
      setProtocolReady(Boolean(registry && verifier));
      setSwapPool(pool === ZERO ? null : pool);
    }).catch(() => { if (alive) setProtocolReady(false); });
    if (account) token.balanceOf(account).then((value: bigint) => { if (alive) setBalance(formatUnits(value, 18)); }).catch(() => { if (alive) setBalance(null); });
    return () => { alive = false; };
  }, [account, read]);

  async function copy(value: string, label: string) {
    await navigator.clipboard?.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1200);
  }

  async function prepareRoute() {
    if (!account) { connect(); return; }
    if (chainId !== ARC_MAINNET.id && activeProvider) {
      try {
        await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC_MAINNET.hexId }] });
      } catch { setStatus("Switch to Arc Mainnet to inspect the destination route."); }
      return;
    }
    setStatus("Route found. Solver proof payload is required before the wallet can sign this intent.");
  }

  async function simulateMainnet() {
    setSimulating(true);
    setStatus("");
    try {
      const adapter = new Contract(ARC_MAINNET_CONTRACTS.ausdIntentSettlement, ADAPTER_ABI, read);
      const factory = new Contract(ARC_MAINNET_CONTRACTS.externalV3Factory, FACTORY_ABI, read);
      const [count, registry, verifier, pool] = await Promise.all([
        adapter.intentCount(),
        adapter.tokenRegistry(),
        adapter.proofVerifier(),
        factory.getPool(ARC_MAINNET_CONTRACTS.ausd, USDC, 3000),
      ]);
      setIntentCount(Number(count).toLocaleString());
      setProtocolReady(Boolean(registry && verifier));
      setSwapPool(pool === ZERO ? null : pool);
      setStatus(pool === ZERO
        ? `Mainnet dry-run passed: Intent Settlement is reachable, but no AUSD/USDC pool exists at the checked venue. No transaction was broadcast.`
        : `Mainnet dry-run passed: executable pool detected at ${short(pool)}. Review quote and allowance before signing.`);
    } catch (error) {
      setStatus(`Mainnet dry-run reverted or RPC failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSimulating(false);
    }
  }

  const readyToReview = Boolean(account && amount && Number(amount) > 0 && protocolReady);

  return (
    <section className="ausd-page">
      <header className="ausd-hero">
        <div>
          <span className="ausd-eyebrow">AUSD / CROSS-CHAIN SETTLEMENT</span>
          <h1>Bring liquidity<br /><em>into Arc.</em></h1>
          <p>One focused rail for Animus USD: source-chain intent, proof verification, and Arc-native settlement in a single execution surface.</p>
          <div className="ausd-proofline"><span><i>01</i>Intent rail</span><span><i>02</i>Proof verified</span><span><i>03</i>AUSD on Arc</span></div>
          <button className="ausd-hero-action" disabled={simulating} onClick={simulateMainnet}>{simulating ? "Reading Arc Mainnet…" : "Simulate on Arc Mainnet"}</button>
        </div>
        <aside className="ausd-hero-orbit" aria-label="AUSD protocol status">
          <div className="ausd-orbit-ring"><img src="/arcodian-mark.svg" alt="Arcodian" /><span>ARC<br />MAINNET</span></div>
          <small>ARC MAINNET STATUS</small>
          <strong>{protocolReady ? "LIVE / CONNECTED" : "RPC CHECKING"}</strong>
          <span>Intent Settlement · chain 5042</span>
        </aside>
      </header>

      <div className="ausd-metrics">
        <span><small>Intent records</small><b>{intentCount || "—"}</b><em>indexed on Arc</em></span>
        <span><small>Destination</small><b>Arc</b><em>chain 5042 · domain 26</em></span>
        <span><small>Wallet balance</small><b>{balance == null ? "—" : `${Number(balance).toLocaleString(undefined, { maximumFractionDigits: 4 })} AUSD`}</b><em>{account ? short(account) : "Connect wallet"}</em></span>
      </div>

      <div className="ausd-workspace">
        <section className="ausd-card ausd-bridge-card">
          <div className="ausd-card-head"><div><span className="ausd-card-kicker">01 / INBOUND ROUTE</span><h2>AUSD bridge</h2></div><span className="ausd-live-dot">LIVE RAIL</span></div>
          <p className="ausd-card-copy">Create an intent for the solver network. The destination mint happens only after a valid proof reaches the verifier.</p>
          <div className="ausd-route-box">
            <label>Source network<select value={source} onChange={(event) => setSource(event.target.value)}>{PEERS.map(([name, domain]) => <option key={domain} value={name}>{name} · domain {domain}</option>)}</select></label>
            <div className="ausd-route-line"><span className="ausd-chain-mark source">S</span><i></i><span className="ausd-chain-mark destination">A</span></div>
            <div className="ausd-route-labels"><span>{source}</span><b>Intent settlement</b><span>Arc Mainnet</span></div>
          </div>
          <label className="ausd-amount">Amount<input inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} /><b>AUSD</b></label>
          <div className="ausd-steps"><span className="done"><i>1</i><b>Source deposit</b><small>Reporter observes</small></span><span><i>2</i><b>Validate intent</b><small>Proof / quorum</small></span><span><i>3</i><b>Mint on Arc</b><small>AUSD destination</small></span></div>
          {status && <p className="ausd-status">{status}</p>}
          <button className="ausd-action" disabled={Boolean(account && !readyToReview)} onClick={prepareRoute}>{!account ? "Connect wallet" : chainId !== ARC_MAINNET.id ? "Switch to Arc Mainnet" : "Review intent route"}</button>
          <small className="ausd-disclosure">The source leg is reporter-settled. The wallet does not sign an unverified source deposit or proof payload.</small>
        </section>

        <section className="ausd-card ausd-swap-card">
          <div className="ausd-card-head"><div><span className="ausd-card-kicker">02 / ARC DESTINATION</span><h2>Convert AUSD</h2></div><span className={swapPool ? "ausd-live-dot" : "ausd-muted-dot"}>{swapPool ? "POOL LIVE" : "NO POOL"}</span></div>
          <p className="ausd-card-copy">Swap AUSD into native USDC on Arc Mainnet after settlement. The route is shown only when an executable pool exists.</p>
          <div className="ausd-swap-pair"><div><span className="ausd-token-icon ausd"><img src="/arcodian-mark.svg" alt="Arcodian" /></span><b>AUSD</b><small>{short(ARC_MAINNET_CONTRACTS.ausd)}</small></div><strong>→</strong><div><span className="ausd-token-icon usdc"><img src="/arcodian-mark.svg" alt="Arcodian" /></span><b>USDC</b><small>Native Arc USDC</small></div></div>
          <div className="ausd-quote-row"><span>Internal V3</span><b>Not found</b></div><div className="ausd-quote-row"><span>External V3</span><b>{swapPool ? short(swapPool) : "Not found"}</b></div><div className="ausd-quote-row"><span>V4 PoolManager</span><b>Not configured</b></div>
          <button className="ausd-action secondary" onClick={simulateMainnet} disabled={simulating}>{simulating ? "Checking mainnet…" : swapPool ? "Review swap" : "Simulate route"}</button>
          <small className="ausd-disclosure">AUSD is not routed through Circle CCTP. Verify the pool and output before signing.</small>
        </section>
      </div>

      <footer className="ausd-footer"><span><b>Arc destination</b> {short(ARC_MAINNET_CONTRACTS.ausdIntentSettlement)} · <b>Base source</b> {short(ARC_MAINNET_CONTRACTS.ausdBaseIntentSettlement)}</span><button onClick={() => copy(ARC_MAINNET_CONTRACTS.ausdIntentSettlement, "adapter")}>{copied === "adapter" ? "Copied" : "Copy Arc adapter"}</button><a href={`${ARC_MAINNET.explorer}/address/${ARC_MAINNET_CONTRACTS.ausdIntentSettlement}`} target="_blank" rel="noreferrer">Inspect on explorer ↗</a></footer>
    </section>
  );
}
