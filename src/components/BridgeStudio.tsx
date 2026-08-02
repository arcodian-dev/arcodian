import { Suspense, lazy } from "react";
import { ARC_MAINNET, CHAINS, MAINNET_CHAINS } from "../config";
import ChainSelect from "./ChainSelect";
import "./BridgeStudio.css";

const BridgeClaim = lazy(() => import("./BridgeClaim"));

type Chain = (typeof CHAINS)[number] | (typeof MAINNET_CHAINS)[number];
type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;

type Props = {
  account: string;
  activeProvider: Provider;
  connect: () => void;
  fromChain: number;
  toChain: number;
  setFromChain: (id: number) => void;
  setToChain: (id: number) => void;
  amount: string;
  setAmount: (value: string) => void;
  busy: boolean;
  status: string;
  onBridge: () => void;
  bridgeFromArc: boolean;
  bridgePeers: Chain[];
  reloadSignal?: string;
};

const allBridgeChains = [...CHAINS, ...MAINNET_CHAINS];
const nameOf = (id: number) => allBridgeChains.find((c) => c.id === id)?.name.replace(/\s*Testnet$/i, "") || "chain";

// Which pipeline stage the transfer is in, read from the live status copy.
function stageFrom(status: string, busy: boolean): 0 | 1 | 2 | 3 {
  if (/arrived|minted|done/i.test(status)) return 3;
  if (/attest|confirming|circle is|in transit|claim/i.test(status)) return 2;
  if (busy || /burn|approv|switch/i.test(status)) return 1;
  return 0;
}

// Mainnet only — Arc Mainnet is live, so the public Bridge page no longer
// offers testnet at all (it still runs fine in the code for Wallet/Lend/
// Market, which stay on testnet until they have a mainnet counterpart).
export default function BridgeStudio({
  account, activeProvider, connect, fromChain, toChain, setFromChain, setToChain,
  amount, setAmount, busy, status, onBridge, bridgeFromArc, bridgePeers, reloadSignal,
}: Props) {
  const stage = stageFrom(status, busy);
  const sameChain = fromChain === toChain;
  const canBridge = Boolean(account) && Number(amount) > 0 && !sameChain && !busy;

  const reverse = () => {
    if (bridgeFromArc) { setFromChain(toChain === ARC_MAINNET.id ? bridgePeers[0].id : toChain); setToChain(ARC_MAINNET.id); }
    else { setToChain(fromChain); setFromChain(ARC_MAINNET.id); }
  };

  const peerSelect = (value: number, onChange: (id: number) => void) => (
    <ChainSelect value={value} options={bridgePeers.map((c) => ({ id: c.id, name: c.name }))} onChange={onChange} ariaLabel="Choose network" disabled={busy} />
  );

  const arcFace = (
    <div className="bstudio-arc"><b>{ARC_MAINNET.name}</b><small>USDC-native · gas in USDC</small></div>
  );

  const stages = [
    { key: "burn", label: "Burn", where: `on ${nameOf(fromChain)}` },
    { key: "attest", label: "Attest", where: "with Circle" },
    { key: "mint", label: "Mint", where: `on ${nameOf(toChain)}` },
  ];

  return (
    <section className="bstudio">
      <header className="bstudio-head">
        <p className="bstudio-eyebrow">Circle CCTP · burn &amp; mint</p>
        <h2 className="bstudio-title">Bridge USDC<br />across chains</h2>
        <p className="bstudio-sub">
          Real USDC, real Circle CCTP rails — not a third-party bridge.
          Arcodian moves your wallet to each network for you.
        </p>
      </header>

      <div className="bstudio-route">
        <div className="bstudio-slot">
          <span>From</span>
          {bridgeFromArc ? arcFace : peerSelect(fromChain, setFromChain)}
        </div>
        <button type="button" className="bstudio-flip" onClick={reverse} aria-label="Reverse direction" disabled={busy}>⇄</button>
        <div className="bstudio-slot">
          <span>To</span>
          {bridgeFromArc ? peerSelect(toChain, setToChain) : arcFace}
        </div>
      </div>

      <label className="bstudio-amount">
        <span>Amount</span>
        <div>
          <input inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
          <b>USDC</b>
        </div>
      </label>

      <ol className="bstudio-pipe" aria-label="Transfer progress">
        {stages.map((s, i) => (
          <li key={s.key} className={stage > i ? "done" : stage === i && busy ? "active" : ""}>
            <i />
            <div><b>{s.label}</b><small>{s.where}</small></div>
          </li>
        ))}
      </ol>

      {!account ? (
        <button className="bstudio-cta" onClick={connect}>Connect wallet</button>
      ) : (
        <button className="bstudio-cta" disabled={!canBridge} onClick={onBridge}>
          {busy ? "Working…" : sameChain ? "Pick two different chains" : `Bridge ${amount || "0"} USDC to ${nameOf(toChain)}`}
        </button>
      )}

      {status && <p className="bstudio-status">{status}</p>}

      <div className="bstudio-claim">
        <Suspense fallback={<p className="bstudio-status">Loading claim…</p>}>
          <BridgeClaim account={account} activeProvider={activeProvider} onConnect={connect} reloadSignal={reloadSignal} />
        </Suspense>
      </div>

      <p className="bstudio-fine">
        Non-custodial — you sign every step. The mint needs a little gas on the destination
        chain ({nameOf(toChain)}). A transfer is never burned twice.
      </p>
    </section>
  );
}
