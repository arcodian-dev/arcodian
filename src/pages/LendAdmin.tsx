import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, Interface, JsonRpcProvider, formatEther, formatUnits, parseUnits } from "ethers";
import { ARC, ARC_LEND_ADDRESS } from "../config";
import { rpcUrlsFor } from "../shared";
import { describeTxError } from "../txError";
import "./LendAdmin.css";

type Props = { account: string; chainId: number | null; activeProvider: EthereumProvider | null; connect: () => void; disconnect: () => void };

// ── Real deployed contracts, read live and confirmed against source (2026-08-07) ──
// ArcLendV2.admin() -> an ArcTimelock (ArcGovernance.sol), NOT the richer
// ArcAdminTimelock.sol spike -- no proposer/executor roles, no salt/predecessor.
// ArcTimelock.admin() -> an ArcMultisig (ArcGovernance.sol), immutable 2-of-2.
// Chain: multisig.submit/confirm -> multisig.execute (permissionless once at
// threshold) relays into timelock.queue -> after minDelay, timelock.execute
// (permissionless) relays into the market call itself.
const MARKET_ABI = [
  "function admin() view returns(address)", "function guardian() view returns(address)",
  "function paused() view returns(bool)", "function pauseFlags() view returns(uint256)",
  "function supplyCap() view returns(uint256)", "function borrowCap() view returns(uint256)",
  "function pendingSupplyCap() view returns(uint256)", "function pendingBorrowCap() view returns(uint256)",
  "function capIncreaseEta() view returns(uint64)", "function reserves() view returns(uint256)",
  "function badDebt() view returns(uint256)", "function oracle() view returns(address)",
  "function maxOracleAge() view returns(uint256)",
  "function setPaused(bool)", "function setPauseFlags(uint256)", "function setCaps(uint256,uint256)",
  "function scheduleCapIncrease(uint256,uint256)", "function cancelCapIncrease()", "function executeCapIncrease()",
  "function setGuardian(address)", "function withdrawReserves()", "function recordBadDebt(address)",
];
const ORACLE_ABI = ["function price() view returns(uint256,uint64)"];
const TIMELOCK_ABI = [
  "function admin() view returns(address)", "function minDelay() view returns(uint64)",
  "function queued(bytes32) view returns(bool)",
  "function operationId(address,uint256,bytes,uint64) pure returns(bytes32)",
  "function queue(address,uint256,bytes,uint64) returns(bytes32)",
  "function cancel(address,uint256,bytes,uint64)",
  "function execute(address,uint256,bytes,uint64) returns(bytes)",
];
const MULTISIG_ABI = [
  "function owners(uint256) view returns(address)", "function threshold() view returns(uint256)", "function nonce() view returns(uint256)",
  "function transactions(uint256) view returns(address target, uint256 value, bytes data, uint256 confirmations, bool executed)",
  "function confirmed(uint256,address) view returns(bool)",
  "function submit(address,uint256,bytes) returns(uint256)", "function confirm(uint256)", "function execute(uint256) returns(bytes)",
];
const MARKET_IFACE = new Interface(MARKET_ABI);
const TIMELOCK_IFACE = new Interface(TIMELOCK_ABI);

function ring(remainingPct: number, label: string, sub: string) {
  const clamped = Math.max(0, Math.min(100, remainingPct));
  const r = 42, c = 2 * Math.PI * r;
  return (
    <div className="tl-ring">
      <svg viewBox="0 0 100 100" width="108" height="108">
        <circle cx="50" cy="50" r={r} className="tl-ring-track" />
        <circle cx="50" cy="50" r={r} className="tl-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - clamped / 100)} />
      </svg>
      <div className="tl-ring-label"><b>{label}</b><small>{sub}</small></div>
    </div>
  );
}

const PAUSE_SUPPLY = 1n, PAUSE_COLLATERAL = 2n, PAUSE_BORROW = 4n;
const short = (value: string) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—");

/** Best-effort human label for a multisig transaction's calldata: unwrap a
 * timelock queue() call and, one layer deeper, the market call it carries. */
function describeCalldata(target: string, data: string, timelockAddr: string): string {
  try {
    if (target.toLowerCase() === timelockAddr.toLowerCase()) {
      const outer = TIMELOCK_IFACE.parseTransaction({ data });
      if (outer?.name === "queue") {
        const [innerTarget, , innerData, eta] = outer.args as unknown as [string, bigint, string, bigint];
        try {
          const inner = MARKET_IFACE.parseTransaction({ data: innerData });
          const args = inner?.args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
          return `Queue → ${inner?.name}(${args}) on ${short(innerTarget)}, ready ${new Date(Number(eta) * 1000).toLocaleString()}`;
        } catch { return `Queue → call on ${short(innerTarget)}, ready ${new Date(Number(eta) * 1000).toLocaleString()}`; }
      }
      if (outer?.name === "cancel") return "Cancel a queued operation";
    }
    const direct = MARKET_IFACE.parseTransaction({ data });
    const args = direct?.args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
    return `${direct?.name}(${args})`;
  } catch { return "Unrecognized calldata"; }
}

type MarketState = {
  timelock: string; guardian: string; paused: boolean; pauseFlags: bigint;
  supplyCap: bigint; borrowCap: bigint; pendingSupplyCap: bigint; pendingBorrowCap: bigint; capIncreaseEta: number;
  reserves: bigint; badDebt: bigint; oracle: string; maxOracleAge: number; oracleAgeSeconds: number;
};
type GovState = { multisig: string; owners: [string, string]; threshold: number; nonce: number; minDelay: number };
type MultisigTx = { id: number; target: string; value: bigint; data: string; confirmations: number; executed: boolean; ownerConfirmed: [boolean, boolean]; label: string; queuedInfo?: { target: string; value: bigint; data: string; eta: number; opId: string } };

export default function LendAdmin({ account, chainId, activeProvider, connect, disconnect }: Props) {
  const [market, setMarket] = useState<MarketState | null>(null);
  const [gov, setGov] = useState<GovState | null>(null);
  const [txs, setTxs] = useState<MultisigTx[]>([]);
  const [queueState, setQueueState] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const onArc = chainId === ARC.id;

  const [lowerSupplyCap, setLowerSupplyCap] = useState("");
  const [lowerBorrowCap, setLowerBorrowCap] = useState("");
  const [raiseSupplyCap, setRaiseSupplyCap] = useState("");
  const [raiseBorrowCap, setRaiseBorrowCap] = useState("");
  const [nextGuardian, setNextGuardian] = useState("");
  const [badDebtUser, setBadDebtUser] = useState("");

  const refresh = useCallback(async () => {
    if (!ARC_LEND_ADDRESS) return;
    try {
      const provider = activeProvider ? new BrowserProvider(activeProvider) : new JsonRpcProvider(ARC.rpcs[1] || ARC.rpc, undefined, { batchMaxCount: 1 });
      const m = new Contract(ARC_LEND_ADDRESS, MARKET_ABI, provider);
      const [timelockAddr, guardian, paused, pauseFlags, supplyCap, borrowCap, pendingSupplyCap, pendingBorrowCap, capIncreaseEta, reserves, badDebt, oracleAddress, maxOracleAge] = await Promise.all([
        m.admin(), m.guardian(), m.paused(), m.pauseFlags(), m.supplyCap(), m.borrowCap(), m.pendingSupplyCap(), m.pendingBorrowCap(), m.capIncreaseEta(), m.reserves(), m.badDebt(), m.oracle(), m.maxOracleAge(),
      ]);
      const [, updatedAt] = await new Contract(oracleAddress, ORACLE_ABI, provider).price().catch(() => [0n, 0n]);
      const oracleAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(updatedAt));
      setMarket({ timelock: timelockAddr, guardian, paused, pauseFlags, supplyCap, borrowCap, pendingSupplyCap, pendingBorrowCap, capIncreaseEta: Number(capIncreaseEta), reserves, badDebt, oracle: oracleAddress, maxOracleAge: Number(maxOracleAge), oracleAgeSeconds });

      const tl = new Contract(timelockAddr, TIMELOCK_ABI, provider);
      const multisigAddr: string = await tl.admin();
      const minDelay: bigint = await tl.minDelay();
      const ms = new Contract(multisigAddr, MULTISIG_ABI, provider);
      const [owner0, owner1, threshold, nonce] = await Promise.all([ms.owners(0), ms.owners(1), ms.threshold(), ms.nonce()]);
      setGov({ multisig: multisigAddr, owners: [owner0, owner1], threshold: Number(threshold), nonce: Number(nonce), minDelay: Number(minDelay) });

      const count = Number(nonce);
      const rows: MultisigTx[] = [];
      const queuedChecks: Record<string, boolean> = {};
      for (let i = 0; i < count; i++) {
        const [txn, conf0, conf1] = await Promise.all([ms.transactions(i), ms.confirmed(i, owner0), ms.confirmed(i, owner1)]);
        const label = describeCalldata(txn.target, txn.data, timelockAddr);
        let queuedInfo: MultisigTx["queuedInfo"];
        if (txn.executed && txn.target.toLowerCase() === timelockAddr.toLowerCase()) {
          try {
            const outer = TIMELOCK_IFACE.parseTransaction({ data: txn.data });
            if (outer?.name === "queue") {
              const [qTarget, qValue, qData, qEta] = outer.args as unknown as [string, bigint, string, bigint];
              const opId: string = await tl.operationId(qTarget, qValue, qData, qEta);
              queuedInfo = { target: qTarget, value: qValue, data: qData, eta: Number(qEta), opId };
              queuedChecks[opId] = await tl.queued(opId);
            }
          } catch { /* not a queue call */ }
        }
        rows.push({ id: i, target: txn.target, value: txn.value, data: txn.data, confirmations: Number(txn.confirmations), executed: txn.executed, ownerConfirmed: [conf0, conf1], label, queuedInfo });
      }
      setTxs(rows.reverse());
      setQueueState(queuedChecks);
    } catch { if (account) setStatus("Connected, but the Arc RPC could not refresh admin state yet."); }
  }, [account, activeProvider]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const id = window.setInterval(() => void refresh(), 20_000); return () => window.clearInterval(id); }, [refresh]);

  async function switchArc() {
    if (!activeProvider) return connect();
    try { await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] }); }
    catch (error) {
      const code = typeof error === "object" && error && "code" in error ? Number((error as { code?: unknown }).code) : 0;
      if (code !== 4902) return setStatus(describeTxError(error));
      await activeProvider.request({ method: "wallet_addEthereumChain", params: [{ chainId: ARC.hexId, chainName: ARC.name, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: rpcUrlsFor(ARC), blockExplorerUrls: [ARC.explorer] }] });
    }
  }

  const ownerIndex = useMemo(() => {
    if (!account || !gov) return -1;
    return gov.owners.findIndex((o) => o.toLowerCase() === account.toLowerCase());
  }, [account, gov]);

  const role = useMemo(() => {
    if (!account || !market) return null;
    const tags: string[] = [];
    if (account.toLowerCase() === market.guardian.toLowerCase()) tags.push("Guardian");
    if (ownerIndex >= 0) tags.push(`Multisig signer (${ownerIndex + 1} of 2)`);
    return tags;
  }, [account, market, ownerIndex]);

  const isGuardian = Boolean(account && market && account.toLowerCase() === market.guardian.toLowerCase());

  async function guardianCall(label: string, fn: (c: Contract) => Promise<{ hash: string; wait: () => Promise<unknown> }>) {
    if (!account || !activeProvider) return connect();
    if (!onArc) return switchArc();
    setBusy(true); setStatus("");
    try {
      const signer = await new BrowserProvider(activeProvider).getSigner();
      const tx = await fn(new Contract(ARC_LEND_ADDRESS, MARKET_ABI, signer));
      setStatus(`${label} submitted ${short(tx.hash)}…`); await tx.wait(); setStatus(`${label} confirmed on Arc.`); await refresh();
    } catch (error) { setStatus(describeTxError(error)); }
    finally { setBusy(false); }
  }

  async function permissionlessCall(label: string, target: string, abi: string[], fn: (c: Contract) => Promise<{ hash: string; wait: () => Promise<unknown> }>) {
    if (!account || !activeProvider) return connect();
    if (!onArc) return switchArc();
    setBusy(true); setStatus("");
    try {
      const signer = await new BrowserProvider(activeProvider).getSigner();
      const tx = await fn(new Contract(target, abi, signer));
      setStatus(`${label} submitted ${short(tx.hash)}…`); await tx.wait(); setStatus(`${label} confirmed on Arc.`); await refresh();
    } catch (error) { setStatus(describeTxError(error)); }
    finally { setBusy(false); }
  }

  /** Step 1: a multisig owner submits a new proposal — the market call, wrapped
   * in a timelock queue() targeting it, with an eta at least minDelay away. */
  async function submitProposal(label: string, marketData: string) {
    if (!account || !activeProvider || !market || !gov) return connect();
    if (ownerIndex < 0) { setStatus("Connect one of the two multisig signer wallets to submit a proposal."); return; }
    if (!onArc) return switchArc();
    setBusy(true); setStatus("");
    try {
      const signer = await new BrowserProvider(activeProvider).getSigner();
      const eta = Math.floor(Date.now() / 1000) + gov.minDelay + 300;
      const queueData = TIMELOCK_IFACE.encodeFunctionData("queue", [ARC_LEND_ADDRESS, 0n, marketData, eta]);
      const ms = new Contract(gov.multisig, MULTISIG_ABI, signer);
      const tx = await ms.submit(market.timelock, 0n, queueData);
      setStatus(`${label}: submitted to multisig ${short(tx.hash)}…`); await tx.wait();
      setStatus(`${label}: submitted — needs 1 more confirmation from the other signer.`);
      await refresh();
    } catch (error) { setStatus(describeTxError(error)); }
    finally { setBusy(false); }
  }

  async function confirmTx(id: number) {
    if (!gov) return;
    await permissionlessCall("Confirm", gov.multisig, MULTISIG_ABI, (c) => c.confirm(id));
  }
  async function executeMultisigTx(id: number) {
    if (!gov) return;
    await permissionlessCall("Relay to Timelock", gov.multisig, MULTISIG_ABI, (c) => c.execute(id));
  }
  async function executeQueuedOp(target: string, value: bigint, data: string, eta: number) {
    if (!market) return;
    await permissionlessCall("Execute on market", market.timelock, TIMELOCK_ABI, (c) => c.execute(target, value, data, eta));
  }

  const pendingIncreaseActive = Boolean(market && market.capIncreaseEta > 0);
  const pendingIncreaseReady = Boolean(market && pendingIncreaseActive && Date.now() / 1000 >= market.capIncreaseEta);
  const pendingIncreasePct = market && pendingIncreaseActive
    ? Math.min(100, 100 - ((market.capIncreaseEta - Date.now() / 1000) / (gov?.minDelay || 172800)) * 100)
    : 0;

  return <main className="lend-admin-site">
    <nav>
      <a href="https://lend.arcodian.fun/" className="lend-brand"><img src="/arcodian-mark.svg" alt="" /><span>ARCODIAN<small>ARC LEND · CONTROL ROOM</small></span></a>
      <div className="lend-nav-links"><a href="https://lend.arcodian.fun/">Market</a><a className="active" href="https://lend.arcodian.fun/admin">Admin</a><a href="https://arcodian.fun/contracts">Trust Center</a></div>
      <div className="lend-wallet"><button onClick={account ? disconnect : connect}>{short(account)}</button></div>
    </nav>

    <header className="admin-hero">
      <p className="admin-eyebrow">GOVERNED ADMINISTRATION · THREE REAL CONTRACTS</p>
      <h1>Nothing moves<br />without a witness.</h1>
      <p className="admin-sub">
        Risk-reducing actions (pause, lower a cap) are one signature from the <b>Guardian</b> key — fast, because
        incidents don't wait. Risk-increasing actions (raise a cap, replace the Guardian, withdraw reserves) need
        <b> both</b> signers of a 2-of-2 multisig to submit and confirm, then anyone can relay that into the
        Timelock, wait out the fixed delay in the open, then anyone can execute it. No single key — not even the
        deployer's — can move risk upward alone.
      </p>
      {role && role.length > 0 && <div className="admin-role-badge">{role.map((tag) => <span key={tag}>{tag}</span>)}</div>}
      {account && role && role.length === 0 && <div className="admin-role-badge muted"><span>Connected — read-only (no admin role on this wallet)</span></div>}
    </header>

    {!account ? (
      <div className="lend-gate"><h2>Connect an EVM wallet</h2><p>Read access is open to everyone. Signing an action requires the matching Guardian or multisig-signer role — enforced on-chain, not by this page.</p><button onClick={connect}>Connect wallet</button></div>
    ) : !onArc ? (
      <button className="lend-network" onClick={switchArc}>Switch to Arc Testnet</button>
    ) : null}

    <section className="admin-status-grid">
      <article><small>MARKET SWITCH</small><strong className={market?.paused ? "danger" : "ok"}>{market ? (market.paused ? "Paused" : "Live") : "—"}</strong></article>
      <article><small>SUPPLY</small><strong className={market && (market.pauseFlags & PAUSE_SUPPLY) ? "danger" : "ok"}>{market ? ((market.pauseFlags & PAUSE_SUPPLY) ? "Paused" : "Open") : "—"}</strong></article>
      <article><small>COLLATERAL</small><strong className={market && (market.pauseFlags & PAUSE_COLLATERAL) ? "danger" : "ok"}>{market ? ((market.pauseFlags & PAUSE_COLLATERAL) ? "Paused" : "Open") : "—"}</strong></article>
      <article><small>BORROW</small><strong className={market && (market.pauseFlags & PAUSE_BORROW) ? "danger" : "ok"}>{market ? ((market.pauseFlags & PAUSE_BORROW) ? "Paused" : "Open") : "—"}</strong></article>
      <article><small>SUPPLY CAP</small><strong>{market ? Number(formatEther(market.supplyCap)).toLocaleString() : "—"} USDC</strong></article>
      <article><small>BORROW CAP</small><strong>{market ? Number(formatEther(market.borrowCap)).toLocaleString() : "—"} USDC</strong></article>
      <article><small>RESERVES</small><strong>{market ? Number(formatEther(market.reserves)).toFixed(4) : "—"} USDC</strong></article>
      <article><small>BAD DEBT</small><strong className={market && market.badDebt > 0n ? "danger" : "ok"}>{market ? Number(formatEther(market.badDebt)).toFixed(4) : "—"} USDC</strong></article>
      <article><small>ORACLE AGE</small><strong className={market && market.oracleAgeSeconds > market.maxOracleAge ? "danger" : "ok"}>{market ? `${Math.floor(market.oracleAgeSeconds / 60)}m` : "—"}</strong><small>of {market ? `${(market.maxOracleAge / 3600).toFixed(0)}h` : "—"} tolerance</small></article>
      <article><small>GUARDIAN</small><strong className="mono">{market ? short(market.guardian) : "—"}</strong></article>
      <article><small>TIMELOCK</small><strong className="mono">{market ? short(market.timelock) : "—"}</strong><small>{gov ? `${(gov.minDelay / 3600).toFixed(0)}h delay` : "—"}</small></article>
      <article><small>MULTISIG</small><strong className="mono">{gov ? short(gov.multisig) : "—"}</strong><small>{gov ? `${gov.threshold}-of-${gov.owners.length}` : "—"}</small></article>
    </section>

    <section className="admin-zone guardian-zone">
      <div className="zone-head"><span className="zone-tag guardian-tag">IMMEDIATE · GUARDIAN</span><h2>Fast controls</h2><p>One signature, no delay. Scoped to defense only — the Guardian can pause and lower caps, never raise them or touch reserves.</p></div>
      <div className="zone-grid">
        <article>
          <h3>Circuit breaker</h3>
          <p>{market?.paused ? "The whole market is paused. Supply, borrow, repay, and withdraw are blocked." : "Market is live."}</p>
          <button className={market?.paused ? "" : "danger"} disabled={busy || !isGuardian} onClick={() => guardianCall("Pause toggle", (c) => c.setPaused(!market?.paused))}>{market?.paused ? "Unpause market" : "Pause market"}</button>
        </article>
        <article>
          <h3>Granular pause</h3>
          <p>Stop one action without freezing the whole market.</p>
          <div className="flag-row">
            {([["Supply", PAUSE_SUPPLY], ["Collateral", PAUSE_COLLATERAL], ["Borrow", PAUSE_BORROW]] as const).map(([label, flagBit]) => {
              const active = Boolean(market && (market.pauseFlags & flagBit));
              return <button key={label} className={active ? "danger" : ""} disabled={busy || !isGuardian} onClick={() => guardianCall(`${label} ${active ? "unpause" : "pause"}`, (c) => c.setPauseFlags(market ? market.pauseFlags ^ flagBit : flagBit))}>{label}: {active ? "Paused" : "Open"}</button>;
            })}
          </div>
        </article>
        <article>
          <h3>Lower caps</h3>
          <p>Can only move down. Raising a cap requires the multisig + Timelock.</p>
          <label>Supply cap<input inputMode="decimal" value={lowerSupplyCap} onChange={(e) => setLowerSupplyCap(e.target.value)} placeholder={market ? formatEther(market.supplyCap) : "0"} /></label>
          <label>Borrow cap<input inputMode="decimal" value={lowerBorrowCap} onChange={(e) => setLowerBorrowCap(e.target.value)} placeholder={market ? formatEther(market.borrowCap) : "0"} /></label>
          <button disabled={busy || !isGuardian || !lowerSupplyCap || !lowerBorrowCap} onClick={() => guardianCall("Lower caps", (c) => c.setCaps(parseUnits(lowerSupplyCap, 18), parseUnits(lowerBorrowCap, 18)))}>Apply lower caps</button>
        </article>
        <article>
          <h3>Cancel pending increase</h3>
          <p>{pendingIncreaseActive ? "A cap increase is currently waiting on the market's own delay." : "No cap increase is pending right now."}</p>
          <button disabled={busy || !isGuardian || !pendingIncreaseActive} onClick={() => guardianCall("Cancel pending increase", (c) => c.cancelCapIncrease())}>Cancel</button>
        </article>
      </div>
    </section>

    <section className="admin-zone timelock-zone">
      <div className="zone-head"><span className="zone-tag timelock-tag">DELAYED · MULTISIG + TIMELOCK</span><h2>Governed actions</h2><p>Four steps, each independently checkable on-chain: submit, confirm, relay, execute. Steps 3 and 4 are permissionless once their condition is met — anyone can push a ready action through, not just the signers.</p></div>

      {pendingIncreaseActive && market && (
        <div className="pending-increase">
          {ring(pendingIncreasePct, pendingIncreaseReady ? "Ready" : `${Math.max(0, Math.ceil((market.capIncreaseEta - Date.now() / 1000) / 3600))}h`, "market-level delay")}
          <div>
            <b>Cap increase in flight (market's own scheduleCapIncrease)</b>
            <span>Supply → {Number(formatEther(market.pendingSupplyCap)).toLocaleString()} USDC · Borrow → {Number(formatEther(market.pendingBorrowCap)).toLocaleString()} USDC</span>
            <small>Eta {new Date(market.capIncreaseEta * 1000).toLocaleString()}</small>
            <button disabled={busy || !pendingIncreaseReady} onClick={() => permissionlessCall("Execute cap increase", ARC_LEND_ADDRESS, MARKET_ABI, (c) => c.executeCapIncrease())}>{pendingIncreaseReady ? "Execute now (open to anyone)" : "Waiting for delay to pass"}</button>
          </div>
        </div>
      )}

      <div className="zone-grid">
        <article>
          <h3>Raise caps</h3>
          <p>Wraps <code>scheduleCapIncrease</code> — the market layers its own further delay on top of the {gov ? (gov.minDelay / 3600).toFixed(0) : "—"}h Timelock delay.</p>
          <label>New supply cap<input inputMode="decimal" value={raiseSupplyCap} onChange={(e) => setRaiseSupplyCap(e.target.value)} placeholder={market ? formatEther(market.supplyCap) : "0"} /></label>
          <label>New borrow cap<input inputMode="decimal" value={raiseBorrowCap} onChange={(e) => setRaiseBorrowCap(e.target.value)} placeholder={market ? formatEther(market.borrowCap) : "0"} /></label>
          <button disabled={busy || ownerIndex < 0 || !raiseSupplyCap || !raiseBorrowCap} onClick={() => submitProposal("Raise caps", MARKET_IFACE.encodeFunctionData("scheduleCapIncrease", [parseUnits(raiseSupplyCap, 18), parseUnits(raiseBorrowCap, 18)]))}>Submit to multisig</button>
        </article>
        <article>
          <h3>Replace Guardian</h3>
          <p>Rotates the fast-response key. A compromised Guardian can still be paused immediately by itself — only replacing it needs both signers and the delay.</p>
          <label>New Guardian address<input value={nextGuardian} onChange={(e) => setNextGuardian(e.target.value)} placeholder="0x…" /></label>
          <button disabled={busy || ownerIndex < 0 || !nextGuardian} onClick={() => submitProposal("Replace Guardian", MARKET_IFACE.encodeFunctionData("setGuardian", [nextGuardian]))}>Submit to multisig</button>
        </article>
        <article>
          <h3>Withdraw reserves</h3>
          <p>Sends the entire accrued reserve ({market ? Number(formatEther(market.reserves)).toFixed(4) : "—"} USDC) to the Timelock contract itself.</p>
          <button disabled={busy || ownerIndex < 0 || !market || market.reserves === 0n} onClick={() => submitProposal("Withdraw reserves", MARKET_IFACE.encodeFunctionData("withdrawReserves", []))}>Submit to multisig</button>
        </article>
        <article>
          <h3>Record bad debt</h3>
          <p>Permissionless maintenance — writes off a fully-liquidated, still-negative position. Anyone can call this once a user has zero collateral and outstanding debt.</p>
          <label>Borrower address<input value={badDebtUser} onChange={(e) => setBadDebtUser(e.target.value)} placeholder="0x…" /></label>
          <button disabled={busy || !badDebtUser} onClick={() => permissionlessCall("Record bad debt", ARC_LEND_ADDRESS, MARKET_ABI, (c) => c.recordBadDebt(badDebtUser))}>Record</button>
        </article>
      </div>

      <div className="ops-tracker">
        <h3>Multisig transactions — read directly, not tracked by this browser</h3>
        <p className="ops-note">{gov ? `${gov.owners.length}-signer multisig, nonce ${gov.nonce}. Every row below is read from the multisig's own transactions() mapping — open this page from any browser and see the same list.` : "Loading…"}</p>
        {txs.length === 0 ? <p className="ops-empty">No transactions submitted to the multisig yet.</p> : (
          <div className="ops-list">
            {txs.map((tx) => {
              const mine = ownerIndex >= 0 && !tx.ownerConfirmed[ownerIndex];
              const ready = tx.confirmations >= (gov?.threshold ?? 2) && !tx.executed;
              const stillQueued = tx.queuedInfo ? queueState[tx.queuedInfo.opId] : false;
              return (
                <div className="ops-row" key={tx.id}>
                  <div><b>#{tx.id} · {tx.label}</b><small className="mono">to {short(tx.target)}</small></div>
                  <span className={`op-state ${tx.executed ? "op-state-3" : ready ? "op-state-2" : "op-state-1"}`}>{tx.executed ? "Relayed" : `${tx.confirmations}/${gov?.threshold ?? 2} confirmed`}</span>
                  <div className="ops-actions">
                    {!tx.executed && mine && <button disabled={busy} onClick={() => confirmTx(tx.id)}>Confirm</button>}
                    {!tx.executed && ready && <button disabled={busy} onClick={() => executeMultisigTx(tx.id)}>Relay to Timelock</button>}
                    {tx.executed && tx.queuedInfo && stillQueued && (
                      <button disabled={busy || Date.now() / 1000 < tx.queuedInfo.eta} onClick={() => executeQueuedOp(tx.queuedInfo!.target, tx.queuedInfo!.value, tx.queuedInfo!.data, tx.queuedInfo!.eta)}>
                        {Date.now() / 1000 < tx.queuedInfo.eta ? `Ready ${new Date(tx.queuedInfo.eta * 1000).toLocaleDateString()}` : "Execute on market"}
                      </button>
                    )}
                    {tx.executed && tx.queuedInfo && !stillQueued && <span className="op-state op-state-3">Executed on market</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>

    {status && <p className="lend-status">{status}</p>}

    <footer><span>Testnet governance canary · Not audited · Contract enforces every role, this page only reflects it.</span><a href={`https://testnet.arcscan.app/address/${ARC_LEND_ADDRESS}`} target="_blank" rel="noreferrer">View market →</a></footer>
  </main>;
}
