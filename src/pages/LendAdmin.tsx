import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, Interface, JsonRpcProvider, ZeroHash, formatEther, formatUnits, parseUnits, randomBytes } from "ethers";
import { ARC, ARC_LEND_ADDRESS } from "../config";
import { rpcUrlsFor } from "../shared";
import { describeTxError } from "../txError";
import "./LendAdmin.css";

type Props = { account: string; chainId: number | null; activeProvider: EthereumProvider | null; connect: () => void; disconnect: () => void };

const MARKET_ABI = [
  "function admin() view returns(address)", "function guardian() view returns(address)",
  "function paused() view returns(bool)", "function pauseFlags() view returns(uint256)",
  "function supplyCap() view returns(uint256)", "function borrowCap() view returns(uint256)",
  "function pendingSupplyCap() view returns(uint256)", "function pendingBorrowCap() view returns(uint256)",
  "function capIncreaseEta() view returns(uint64)", "function reserves() view returns(uint256)",
  "function badDebt() view returns(uint256)", "function oracle() view returns(address)",
  "function maxOracleAge() view returns(uint256)", "function totalAssets() view returns(uint256)",
  "function totalBorrows() view returns(uint256)",
  "function setPaused(bool)", "function setPauseFlags(uint256)", "function setCaps(uint256,uint256)",
  "function scheduleCapIncrease(uint256,uint256)", "function cancelCapIncrease()", "function executeCapIncrease()",
  "function setGuardian(address)", "function withdrawReserves()", "function recordBadDebt(address)",
];
const ORACLE_ABI = ["function price() view returns(uint256,uint64)"];
const TIMELOCK_ABI = [
  "function admin() view returns(address)", "function minDelay() view returns(uint256)",
  "function isProposer(address) view returns(bool)", "function isExecutor(address) view returns(bool)",
  "function hashOperation(address,uint256,bytes,bytes32,bytes32) pure returns(bytes32)",
  "function state(bytes32) view returns(uint8)",
  "function schedule(address,uint256,bytes,bytes32,bytes32,uint256)",
  "function execute(address,uint256,bytes,bytes32,bytes32) payable",
  "function cancel(bytes32)",
];
const MARKET_IFACE = new Interface(MARKET_ABI);

const PAUSE_SUPPLY = 1n, PAUSE_COLLATERAL = 2n, PAUSE_BORROW = 4n;
const OP_STATE = ["Unscheduled", "Waiting", "Ready", "Done"] as const;
const short = (value: string) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—");

type MarketState = {
  admin: string; guardian: string; paused: boolean; pauseFlags: bigint;
  supplyCap: bigint; borrowCap: bigint; pendingSupplyCap: bigint; pendingBorrowCap: bigint; capIncreaseEta: number;
  reserves: bigint; badDebt: bigint; oracle: string; maxOracleAge: number;
  totalAssets: bigint; totalBorrows: bigint; oracleAgeSeconds: number;
};
type TimelockState = { minDelay: number; owner: string; isProposer: boolean; isExecutor: boolean };
type PendingOp = { id: string; label: string; target: string; value: string; data: string; predecessor: string; salt: string; createdAt: number };

const OPS_KEY = "arcodian-lend-admin-ops-v1";
function loadOps(): PendingOp[] { try { return JSON.parse(localStorage.getItem(OPS_KEY) || "[]"); } catch { return []; } }
function saveOp(op: PendingOp) { const all = loadOps(); localStorage.setItem(OPS_KEY, JSON.stringify([op, ...all.filter((o) => o.id !== op.id)].slice(0, 50))); }
function removeOp(id: string) { localStorage.setItem(OPS_KEY, JSON.stringify(loadOps().filter((o) => o.id !== id))); }

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

export default function LendAdmin({ account, chainId, activeProvider, connect, disconnect }: Props) {
  const [market, setMarket] = useState<MarketState | null>(null);
  const [timelock, setTimelock] = useState<TimelockState | null>(null);
  const [ops, setOps] = useState<PendingOp[]>(loadOps());
  const [opStates, setOpStates] = useState<Record<string, number>>({});
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const onArc = chainId === ARC.id;

  const [lowerSupplyCap, setLowerSupplyCap] = useState("");
  const [lowerBorrowCap, setLowerBorrowCap] = useState("");
  const [raiseSupplyCap, setRaiseSupplyCap] = useState("");
  const [raiseBorrowCap, setRaiseBorrowCap] = useState("");
  const [nextGuardian, setNextGuardian] = useState("");
  const [badDebtUser, setBadDebtUser] = useState("");
  const [lookupTarget, setLookupTarget] = useState("");
  const [lookupValue, setLookupValue] = useState("0");
  const [lookupData, setLookupData] = useState("");
  const [lookupPredecessor, setLookupPredecessor] = useState(ZeroHash);
  const [lookupSalt, setLookupSalt] = useState("");
  const [lookupResult, setLookupResult] = useState<{ id: string; state: number } | null>(null);

  const refresh = useCallback(async () => {
    if (!ARC_LEND_ADDRESS) return;
    try {
      const provider = activeProvider ? new BrowserProvider(activeProvider) : new JsonRpcProvider(ARC.rpcs[1] || ARC.rpc, undefined, { batchMaxCount: 1 });
      const m = new Contract(ARC_LEND_ADDRESS, MARKET_ABI, provider);
      const [admin, guardian, paused, pauseFlags, supplyCap, borrowCap, pendingSupplyCap, pendingBorrowCap, capIncreaseEta, reserves, badDebt, oracleAddress, maxOracleAge, totalAssets, totalBorrows] = await Promise.all([
        m.admin(), m.guardian(), m.paused(), m.pauseFlags(), m.supplyCap(), m.borrowCap(), m.pendingSupplyCap(), m.pendingBorrowCap(), m.capIncreaseEta(), m.reserves(), m.badDebt(), m.oracle(), m.maxOracleAge(), m.totalAssets(), m.totalBorrows(),
      ]);
      const [, updatedAt] = await new Contract(oracleAddress, ORACLE_ABI, provider).price().catch(() => [0n, 0n]);
      const oracleAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(updatedAt));
      setMarket({ admin, guardian, paused, pauseFlags, supplyCap, borrowCap, pendingSupplyCap, pendingBorrowCap, capIncreaseEta: Number(capIncreaseEta), reserves, badDebt, oracle: oracleAddress, maxOracleAge: Number(maxOracleAge), totalAssets, totalBorrows, oracleAgeSeconds });

      const tl = new Contract(admin, TIMELOCK_ABI, provider);
      try {
        const [minDelay, owner, isProposer, isExecutor] = await Promise.all([
          tl.minDelay(), tl.admin(),
          account ? tl.isProposer(account) : false,
          account ? tl.isExecutor(account) : false,
        ]);
        setTimelock({ minDelay: Number(minDelay), owner, isProposer: Boolean(isProposer), isExecutor: Boolean(isExecutor) });
      } catch { setTimelock(null); }

      const currentOps = loadOps();
      const states: Record<string, number> = {};
      await Promise.all(currentOps.map(async (op) => { try { states[op.id] = Number(await tl.state(op.id)); } catch { states[op.id] = -1; } }));
      setOpStates(states);
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

  const role = useMemo(() => {
    if (!account || !market) return null;
    const lower = account.toLowerCase();
    const tags: string[] = [];
    if (lower === market.guardian.toLowerCase()) tags.push("Guardian");
    if (timelock?.isProposer) tags.push("Timelock proposer");
    if (timelock?.isExecutor) tags.push("Timelock executor");
    if (timelock && lower === timelock.owner.toLowerCase()) tags.push("Governance owner");
    return tags;
  }, [account, market, timelock]);

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

  async function proposeOperation(label: string, data: string) {
    if (!account || !activeProvider || !market || !timelock) return connect();
    if (!onArc) return switchArc();
    setBusy(true); setStatus("");
    try {
      const signer = await new BrowserProvider(activeProvider).getSigner();
      const tl = new Contract(market.admin, TIMELOCK_ABI, signer);
      const salt = "0x" + Buffer.from(randomBytes(32)).toString("hex");
      const id = await tl.hashOperation(ARC_LEND_ADDRESS, 0n, data, ZeroHash, salt);
      const tx = await tl.schedule(ARC_LEND_ADDRESS, 0n, data, ZeroHash, salt, timelock.minDelay);
      setStatus(`Proposal submitted ${short(tx.hash)}…`); await tx.wait();
      saveOp({ id, label, target: ARC_LEND_ADDRESS, value: "0", data, predecessor: ZeroHash, salt, createdAt: Date.now() });
      setOps(loadOps());
      setStatus(`Proposed — ready to execute in ${(timelock.minDelay / 3600).toFixed(0)}h.`);
      await refresh();
    } catch (error) { setStatus(describeTxError(error)); }
    finally { setBusy(false); }
  }

  async function executeOperation(op: PendingOp) {
    if (!account || !activeProvider || !market) return connect();
    if (!onArc) return switchArc();
    setBusy(true); setStatus("");
    try {
      const signer = await new BrowserProvider(activeProvider).getSigner();
      const tl = new Contract(market.admin, TIMELOCK_ABI, signer);
      const tx = await tl.execute(op.target, BigInt(op.value), op.data, op.predecessor, op.salt);
      setStatus(`Execute submitted ${short(tx.hash)}…`); await tx.wait(); setStatus("Executed on Arc.");
      removeOp(op.id); setOps(loadOps()); await refresh();
    } catch (error) { setStatus(describeTxError(error)); }
    finally { setBusy(false); }
  }

  async function permissionlessCall(label: string, fn: (c: Contract) => Promise<{ hash: string; wait: () => Promise<unknown> }>) {
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

  async function lookupOperation() {
    if (!market) return;
    setBusy(true); setStatus("");
    try {
      const provider = activeProvider ? new BrowserProvider(activeProvider) : new JsonRpcProvider(ARC.rpcs[1] || ARC.rpc, undefined, { batchMaxCount: 1 });
      const tl = new Contract(market.admin, TIMELOCK_ABI, provider);
      const id = await tl.hashOperation(lookupTarget, BigInt(lookupValue || "0"), lookupData || "0x", lookupPredecessor || ZeroHash, lookupSalt || ZeroHash);
      const state = Number(await tl.state(id));
      setLookupResult({ id, state });
    } catch (error) { setStatus(describeTxError(error)); }
    finally { setBusy(false); }
  }

  const pendingIncreaseActive = Boolean(market && market.capIncreaseEta > 0);
  const pendingIncreaseReady = Boolean(market && pendingIncreaseActive && Date.now() / 1000 >= market.capIncreaseEta);
  const pendingIncreasePct = market && pendingIncreaseActive
    ? Math.min(100, 100 - ((market.capIncreaseEta - Date.now() / 1000) / (timelock?.minDelay || 172800)) * 100)
    : 0;

  return <main className="lend-admin-site">
    <nav>
      <a href="https://lend.arcodian.fun/" className="lend-brand"><img src="/arcodian-mark.svg" alt="" /><span>ARCODIAN<small>ARC LEND · CONTROL ROOM</small></span></a>
      <div className="lend-nav-links"><a href="https://lend.arcodian.fun/">Market</a><a className="active" href="https://lend.arcodian.fun/admin">Admin</a><a href="https://arcodian.fun/contracts">Trust Center</a></div>
      <div className="lend-wallet"><button onClick={account ? disconnect : connect}>{short(account)}</button></div>
    </nav>

    <header className="admin-hero">
      <p className="admin-eyebrow">GOVERNED ADMINISTRATION · TWO-TIER ACCESS</p>
      <h1>Nothing moves<br />without a witness.</h1>
      <p className="admin-sub">
        Every risk-reducing action (pause, lower a cap) is a single signature from the <b>Guardian</b> key —
        fast, because incidents don't wait. Every risk-increasing action (raise a cap, replace the Guardian,
        withdraw reserves) must pass through the <b>Timelock</b>: proposed on-chain, held for a fixed delay
        anyone can watch, then executed — never both steps by the same signer, never hidden.
      </p>
      {role && role.length > 0 && <div className="admin-role-badge">{role.map((tag) => <span key={tag}>{tag}</span>)}</div>}
      {account && role && role.length === 0 && <div className="admin-role-badge muted"><span>Connected — read-only (no admin role on this wallet)</span></div>}
    </header>

    {!account ? (
      <div className="lend-gate"><h2>Connect an EVM wallet</h2><p>Read access is open to everyone. Signing an action requires the matching Guardian or Timelock role — enforced on-chain, not by this page.</p><button onClick={connect}>Connect wallet</button></div>
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
      <article><small>TIMELOCK</small><strong className="mono">{market ? short(market.admin) : "—"}</strong><small>{timelock ? `${(timelock.minDelay / 3600).toFixed(0)}h delay` : "—"}</small></article>
      <article><small>GOVERNANCE OWNER</small><strong className="mono">{timelock ? short(timelock.owner) : "—"}</strong><small>can add/remove signers</small></article>
    </section>

    <section className="admin-zone guardian-zone">
      <div className="zone-head"><span className="zone-tag guardian-tag">IMMEDIATE · GUARDIAN</span><h2>Fast controls</h2><p>One signature, no delay. Scoped to defense only — the Guardian can pause and lower caps, never raise them or touch reserves.</p></div>
      <div className="zone-grid">
        <article>
          <h3>Circuit breaker</h3>
          <p>{market?.paused ? "The whole market is paused. Only supply/borrow/repay/withdraw actions using the live modifier are blocked." : "Market is live."}</p>
          <button className={market?.paused ? "" : "danger"} disabled={busy || !isGuardian} onClick={() => guardianCall("Pause toggle", (c) => c.setPaused(!market?.paused))}>{market?.paused ? "Unpause market" : "Pause market"}</button>
        </article>
        <article>
          <h3>Granular pause</h3>
          <p>Stop one action without freezing the whole market.</p>
          <div className="flag-row">
            {[["Supply", PAUSE_SUPPLY], ["Collateral", PAUSE_COLLATERAL], ["Borrow", PAUSE_BORROW]].map(([label, bit]) => {
              const flagBit = bit as bigint;
              const active = Boolean(market && (market.pauseFlags & flagBit));
              return <button key={label as string} className={active ? "danger" : ""} disabled={busy || !isGuardian} onClick={() => guardianCall(`${label} ${active ? "unpause" : "pause"}`, (c) => c.setPauseFlags((market ? market.pauseFlags ^ flagBit : flagBit)))}>{label as string}: {active ? "Paused" : "Open"}</button>;
            })}
          </div>
        </article>
        <article>
          <h3>Lower caps</h3>
          <p>Can only move down. Raising a cap requires the Timelock.</p>
          <label>Supply cap<input inputMode="decimal" value={lowerSupplyCap} onChange={(e) => setLowerSupplyCap(e.target.value)} placeholder={market ? formatEther(market.supplyCap) : "0"} /></label>
          <label>Borrow cap<input inputMode="decimal" value={lowerBorrowCap} onChange={(e) => setLowerBorrowCap(e.target.value)} placeholder={market ? formatEther(market.borrowCap) : "0"} /></label>
          <button disabled={busy || !isGuardian || !lowerSupplyCap || !lowerBorrowCap} onClick={() => guardianCall("Lower caps", (c) => c.setCaps(parseUnits(lowerSupplyCap, 18), parseUnits(lowerBorrowCap, 18)))}>Apply lower caps</button>
        </article>
        <article>
          <h3>Cancel pending increase</h3>
          <p>{pendingIncreaseActive ? "A cap increase is currently proposed or waiting." : "No cap increase is pending right now."}</p>
          <button disabled={busy || !isGuardian || !pendingIncreaseActive} onClick={() => guardianCall("Cancel pending increase", (c) => c.cancelCapIncrease())}>Cancel</button>
        </article>
      </div>
    </section>

    <section className="admin-zone timelock-zone">
      <div className="zone-head"><span className="zone-tag timelock-tag">DELAYED · TIMELOCK</span><h2>Governed actions</h2><p>Anything that increases risk or moves funds. Propose here, wait out the delay in the open, then execute — cancellable by the Guardian at any point before it fires.</p></div>

      {pendingIncreaseActive && market && (
        <div className="pending-increase">
          {ring(pendingIncreasePct, pendingIncreaseReady ? "Ready" : `${Math.max(0, Math.ceil((market.capIncreaseEta - Date.now() / 1000) / 3600))}h left`, "cap increase")}
          <div>
            <b>Cap increase in flight</b>
            <span>Supply → {Number(formatEther(market.pendingSupplyCap)).toLocaleString()} USDC · Borrow → {Number(formatEther(market.pendingBorrowCap)).toLocaleString()} USDC</span>
            <small>Eta {new Date(market.capIncreaseEta * 1000).toLocaleString()}</small>
            <button disabled={busy || !pendingIncreaseReady} onClick={() => permissionlessCall("Execute cap increase", (c) => c.executeCapIncrease())}>{pendingIncreaseReady ? "Execute now (open to anyone)" : "Waiting for delay to pass"}</button>
          </div>
        </div>
      )}

      <div className="zone-grid">
        <article>
          <h3>Raise caps</h3>
          <p>Proposer schedules; executor fires after {timelock ? (timelock.minDelay / 3600).toFixed(0) : "—"}h. This calls the market's own <code>scheduleCapIncrease</code>, which layers its own delay on top.</p>
          <label>New supply cap<input inputMode="decimal" value={raiseSupplyCap} onChange={(e) => setRaiseSupplyCap(e.target.value)} placeholder={market ? formatEther(market.supplyCap) : "0"} /></label>
          <label>New borrow cap<input inputMode="decimal" value={raiseBorrowCap} onChange={(e) => setRaiseBorrowCap(e.target.value)} placeholder={market ? formatEther(market.borrowCap) : "0"} /></label>
          <button disabled={busy || !timelock?.isProposer || !raiseSupplyCap || !raiseBorrowCap} onClick={() => proposeOperation("Raise caps", MARKET_IFACE.encodeFunctionData("scheduleCapIncrease", [parseUnits(raiseSupplyCap, 18), parseUnits(raiseBorrowCap, 18)]))}>Propose raise</button>
        </article>
        <article>
          <h3>Replace Guardian</h3>
          <p>Rotates the fast-response key. Takes the full Timelock delay — a compromised Guardian can be paused immediately by itself, but only replaced with witness.</p>
          <label>New Guardian address<input value={nextGuardian} onChange={(e) => setNextGuardian(e.target.value)} placeholder="0x…" /></label>
          <button disabled={busy || !timelock?.isProposer || !nextGuardian} onClick={() => proposeOperation("Replace Guardian", MARKET_IFACE.encodeFunctionData("setGuardian", [nextGuardian]))}>Propose replacement</button>
        </article>
        <article>
          <h3>Withdraw reserves</h3>
          <p>Sends the entire accrued reserve ({market ? Number(formatEther(market.reserves)).toFixed(4) : "—"} USDC) to the Timelock contract itself — a second, separate action is needed to move it onward.</p>
          <button disabled={busy || !timelock?.isProposer || !market || market.reserves === 0n} onClick={() => proposeOperation("Withdraw reserves", MARKET_IFACE.encodeFunctionData("withdrawReserves", []))}>Propose withdrawal</button>
        </article>
        <article>
          <h3>Record bad debt</h3>
          <p>Permissionless maintenance — writes off a fully-liquidated, still-negative position. Anyone can call this once a user has zero collateral and outstanding debt.</p>
          <label>Borrower address<input value={badDebtUser} onChange={(e) => setBadDebtUser(e.target.value)} placeholder="0x…" /></label>
          <button disabled={busy || !badDebtUser} onClick={() => permissionlessCall("Record bad debt", (c) => c.recordBadDebt(badDebtUser))}>Record</button>
        </article>
      </div>

      <div className="ops-tracker">
        <h3>Proposals tracked from this browser</h3>
        <p className="ops-note">Anyone can verify these independently — the id is a pure hash of the target, calldata, and salt. This list is a convenience, not the source of truth.</p>
        {ops.length === 0 ? <p className="ops-empty">No proposals raised from this browser yet.</p> : (
          <div className="ops-list">
            {ops.map((op) => {
              const state = opStates[op.id];
              const label = state === undefined ? "Checking…" : OP_STATE[state] ?? "Unknown";
              return (
                <div className="ops-row" key={op.id}>
                  <div><b>{op.label}</b><small className="mono">{short(op.id)}</small></div>
                  <span className={`op-state op-state-${state ?? -1}`}>{label}</span>
                  <div className="ops-actions">
                    {state === 2 && <button disabled={busy || !timelock?.isExecutor} onClick={() => executeOperation(op)}>Execute</button>}
                    <button className="ghost" onClick={() => { removeOp(op.id); setOps(loadOps()); }}>Forget</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <details className="lookup-tool">
        <summary>Look up any operation by its parameters</summary>
        <p>Reconstruct the id the same way the Timelock does — useful to verify a proposal someone else raised, or one raised from a different browser.</p>
        <div className="lookup-grid">
          <label>Target<input value={lookupTarget} onChange={(e) => setLookupTarget(e.target.value)} placeholder={ARC_LEND_ADDRESS} /></label>
          <label>Value (wei)<input value={lookupValue} onChange={(e) => setLookupValue(e.target.value)} placeholder="0" /></label>
          <label>Calldata<input value={lookupData} onChange={(e) => setLookupData(e.target.value)} placeholder="0x…" /></label>
          <label>Predecessor<input value={lookupPredecessor} onChange={(e) => setLookupPredecessor(e.target.value)} placeholder={ZeroHash} /></label>
          <label>Salt<input value={lookupSalt} onChange={(e) => setLookupSalt(e.target.value)} placeholder="0x…" /></label>
        </div>
        <button disabled={busy || !lookupTarget || !lookupData} onClick={() => void lookupOperation()}>Check state</button>
        {lookupResult && <p className="lookup-result">id <code className="mono">{lookupResult.id}</code> — <b>{OP_STATE[lookupResult.state] ?? "Unknown"}</b></p>}
      </details>
    </section>

    {status && <p className="lend-status">{status}</p>}

    <footer><span>Testnet governance canary · Not audited · Contract enforces every role, this page only reflects it.</span><a href={`https://testnet.arcscan.app/address/${ARC_LEND_ADDRESS}`} target="_blank" rel="noreferrer">View market →</a></footer>
  </main>;
}
