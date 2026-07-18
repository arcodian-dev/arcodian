import { useEffect, useState } from "react";
import { Contract, formatEther, parseEther } from "ethers";
import { ARC, ARC_DEX_FACTORY_ADDRESS, FEE_TREASURY, PUMP_FACTORY_ADDRESS, PUMP_SUITE_ADDRESS } from "../config";
import { FAQ_ITEMS, arcProvider, short } from "../shared";

function TrustNav({ active, openContracts, openHow, openFaq, openCanary }: { active: "contracts" | "how" | "faq" | "canary"; openContracts?: () => void; openHow?: () => void; openFaq?: () => void; openCanary?: () => void }) {
  return <nav className="trust-nav" aria-label="Trust Center sections">
    <span><small>Arcodian</small><b>Trust Center</b></span>
    <button className={active === "contracts" ? "active" : ""} onClick={openContracts}>Contracts</button>
    <button className={active === "how" ? "active" : ""} onClick={openHow}>Mechanics</button>
    <button className={active === "faq" ? "active" : ""} onClick={openFaq}>FAQ</button>
    <button className={active === "canary" ? "active" : ""} onClick={openCanary}>Canary</button>
  </nav>;
}

type CanaryStepState = { status: "pending" | "pass" | "fail"; txHash: string; note: string; verifiedAt?: number };
type CanarySession = { startedAt: number; updatedAt: number; steps: Record<string, CanaryStepState> };
const CANARY_STEPS = [
  { id: "buy", title: "Buy Arcodian coin", detail: "Confirm terminal, tape, chart, balance, and Coin Activity.", action: "Market", evidence: "tx" },
  { id: "sell", title: "Sell part of the position", detail: "Confirm exact approval, USDC output, and Coin Activity.", action: "Market", evidence: "tx" },
  { id: "swap-out", title: "Circle Swap USDC → EURC", detail: "Review estimate, minimum output, approval, and final balance.", action: "Swap", evidence: "tx" },
  { id: "swap-back", title: "Circle Swap EURC → USDC", detail: "Prove the return route and final balance.", action: "Swap", evidence: "tx" },
  { id: "bridge-in", title: "Bridge USDC into Arc", detail: "Verify burn, attestation, mint/claim, and destination balance.", action: "Bridge", evidence: "tx" },
  { id: "bridge-out", title: "Bridge USDC out of Arc", detail: "Verify source burn and destination mint/claim.", action: "Bridge", evidence: "tx" },
  { id: "reject", title: "Reject one wallet prompt", detail: "Confirm no transaction is submitted and no funds move.", action: "Manual", evidence: "manual" },
  { id: "recovery", title: "Refresh during a pending flow", detail: "Confirm the UI restores the flow without duplicating execution.", action: "Manual", evidence: "manual" },
] as const;

function newCanarySession(): CanarySession {
  return { startedAt: Date.now(), updatedAt: Date.now(), steps: Object.fromEntries(CANARY_STEPS.map((step) => [step.id, { status: "pending", txHash: "", note: "" }])) };
}

export function CanaryConsole({ account, connect, openContracts, openHow, openFaq, openMarket, openSwap, openBridge }: { account: string; connect: () => void; openContracts: () => void; openHow: () => void; openFaq: () => void; openMarket: () => void; openSwap: () => void; openBridge: () => void }) {
  const storageKey = `arcodian-canary-v1:${account.toLowerCase() || "disconnected"}`;
  const [session, setSession] = useState<CanarySession | null>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "null") as CanarySession | null; } catch { return null; }
  });
  const [checking, setChecking] = useState("");
  const passed = session ? CANARY_STEPS.filter((step) => session.steps[step.id]?.status === "pass").length : 0;

  useEffect(() => {
    try { setSession(JSON.parse(localStorage.getItem(storageKey) || "null") as CanarySession | null); } catch { setSession(null); }
  }, [storageKey]);
  useEffect(() => { if (session) localStorage.setItem(storageKey, JSON.stringify(session)); }, [session, storageKey]);

  const patchStep = (id: string, patch: Partial<CanaryStepState>) => setSession((current) => current ? ({ ...current, updatedAt: Date.now(), steps: { ...current.steps, [id]: { ...current.steps[id], ...patch } } }) : current);
  const verifyHash = async (id: string) => {
    const hash = session?.steps[id]?.txHash.trim() || "";
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) { patchStep(id, { status: "fail", note: "Enter a valid 0x transaction hash." }); return; }
    setChecking(id);
    const provider = arcProvider();
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) patchStep(id, { status: "pending", note: "Transaction submitted; waiting for Arc confirmation." });
      else if (receipt.status !== 1) patchStep(id, { status: "fail", note: "Transaction reverted onchain.", verifiedAt: Date.now() });
      else {
        const tx = await provider.getTransaction(hash);
        const owned = !account || tx?.from.toLowerCase() === account.toLowerCase();
        patchStep(id, { status: owned ? "pass" : "fail", note: owned ? `Confirmed on Arc block ${receipt.blockNumber}.` : "Hash is confirmed, but it was not sent by the connected wallet.", verifiedAt: Date.now() });
      }
    } catch { patchStep(id, { status: "pending", note: "Arc RPC is busy; verification will retry automatically." }); }
    finally { provider.destroy(); setChecking(""); }
  };

  useEffect(() => {
    if (!session || !account) return;
    let stopped = false;
    const sync = async () => {
      try {
        const response = await fetch(`/data/market-index.json?canary=${Date.now()}`, { cache: "no-store" });
        const index = await response.json() as { launches?: Array<{ trades?: Array<{ side: string; tx: string; user: string; timestamp?: number }> }> };
        const trades = (index.launches || []).flatMap((launch) => launch.trades || []).filter((trade) => trade.user.toLowerCase() === account.toLowerCase() && Number(trade.timestamp || 0) * 1000 >= session.startedAt);
        for (const [id, side] of [["buy", "BUY"], ["sell", "SELL"]] as const) {
          const trade = trades.filter((item) => item.side === side).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0];
          if (trade && !stopped && session.steps[id]?.status !== "pass") patchStep(id, { txHash: trade.tx, status: "pass", note: `Detected automatically from canonical ${side} index.`, verifiedAt: Date.now() });
        }
      } catch { /* retain the last signed canary evidence */ }
    };
    void sync(); const timer = window.setInterval(sync, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [account, session?.startedAt]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => { for (const step of CANARY_STEPS) if (step.evidence === "tx" && session.steps[step.id]?.txHash && session.steps[step.id]?.status === "pending") void verifyHash(step.id); }, 6000);
    return () => window.clearInterval(timer);
  }, [session]);

  const exportReport = () => {
    if (!session) return;
    const report = { product: "Arcodian", environment: "Arc Testnet", chainId: ARC.id, wallet: account, result: passed === CANARY_STEPS.length ? "PASS" : "INCOMPLETE", exportedAt: new Date().toISOString(), ...session, steps: CANARY_STEPS.map((definition) => ({ ...definition, ...session.steps[definition.id] })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `arcodian-canary-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
  };
  const openAction = (action: string) => action === "Market" ? openMarket() : action === "Swap" ? openSwap() : action === "Bridge" ? openBridge() : undefined;

  return <section className="canary-page">
    <TrustNav active="canary" openContracts={openContracts} openHow={openHow} openFaq={openFaq} />
    <header><div><p className="kicker">Signed release evidence</p><h1>Canary Console</h1><p>Run small-value wallet-signed tests. Arcodian verifies receipts and keeps the evidence in this browser; it never requests a private key.</p></div><div className={`canary-score ${passed === CANARY_STEPS.length ? "complete" : ""}`}><strong>{passed}/{CANARY_STEPS.length}</strong><small>checks passed</small></div></header>
    {!account ? <div className="canary-gate"><b>Connect the canary wallet first</b><p>Every report is isolated to one public wallet address.</p><button className="primary" onClick={connect}>Connect wallet</button></div> : !session ? <div className="canary-gate"><b>Ready for a small-value test run</b><p>Starting creates a local baseline so old transactions cannot be counted as new canary evidence.</p><button className="primary" onClick={() => setSession(newCanarySession())}>Start canary session</button></div> : <>
      <div className="canary-meta"><span><small>Wallet</small><b>{short(account)}</b></span><span><small>Started</small><b>{new Date(session.startedAt).toLocaleString()}</b></span><span><small>Network</small><b>Arc Testnet · {ARC.id}</b></span><button onClick={exportReport}>Export JSON report</button></div>
      <div className="canary-list">{CANARY_STEPS.map((step, index) => { const state = session.steps[step.id]; return <article key={step.id} className={state.status}><i>{state.status === "pass" ? "✓" : state.status === "fail" ? "!" : String(index + 1).padStart(2, "0")}</i><div className="canary-copy"><small>{step.action} · {step.evidence === "tx" ? "onchain evidence" : "manual observation"}</small><h3>{step.title}</h3><p>{step.detail}</p>{state.note && <em>{state.note}</em>}</div><div className="canary-controls">{step.action !== "Manual" && <button onClick={() => openAction(step.action)}>Open {step.action}</button>}{step.evidence === "tx" ? <><input aria-label={`${step.title} transaction hash`} value={state.txHash} onChange={(event) => patchStep(step.id, { txHash: event.target.value, status: "pending", note: "" })} placeholder="Paste 0x transaction hash"/><button disabled={checking === step.id} onClick={() => void verifyHash(step.id)}>{checking === step.id ? "Checking…" : "Verify receipt"}</button></> : <><button className="pass" onClick={() => patchStep(step.id, { status: "pass", note: "Observed and confirmed manually.", verifiedAt: Date.now() })}>Mark pass</button><button className="fail" onClick={() => patchStep(step.id, { status: "fail", note: "Needs investigation.", verifiedAt: Date.now() })}>Mark fail</button></>}</div>{state.txHash && <a href={`${ARC.explorer}/tx/${state.txHash}`} target="_blank" rel="noreferrer">Explorer ↗</a>}</article>; })}</div>
      <footer className="canary-footer"><p><b>{passed === CANARY_STEPS.length ? "Canary complete." : "Release candidate is not frozen yet."}</b><span>{passed === CANARY_STEPS.length ? "Export the evidence, then perform the backup and rollback drill." : "Complete every signed check before freezing this testnet release candidate."}</span></p><button onClick={() => { if (window.confirm("Reset this wallet's canary evidence and start a new run?")) setSession(newCanarySession()); }}>Reset session</button></footer>
    </>}
  </section>;
}

export function ContractsPage({ openHow, openFaq, openCanary }: { openHow: () => void; openFaq: () => void; openCanary: () => void }) {
  const [checks, setChecks] = useState<Array<{ label: string; value: string; ok: boolean }>>([]);
  const [checkedAt, setCheckedAt] = useState("");
  useEffect(() => {
    const provider = arcProvider();
    void (async () => {
      try {
        const suite = new Contract(PUMP_SUITE_ADDRESS, ["function pumpFactory() view returns(address)", "function dexFactory() view returns(address)", "function treasury() view returns(address)"], provider);
        const pump = new Contract(PUMP_FACTORY_ADDRESS, ["function graduationThreshold() view returns(uint256)", "function treasury() view returns(address)", "function dexFactory() view returns(address)"], provider);
        const dex = new Contract(ARC_DEX_FACTORY_ADDRESS, ["function owner() view returns(address)", "function treasury() view returns(address)"], provider);
        const [suitePump, suiteDex, suiteTreasury, threshold, pumpTreasury, pumpDex, dexOwner, dexTreasury] = await Promise.all([suite.pumpFactory(), suite.dexFactory(), suite.treasury(), pump.graduationThreshold(), pump.treasury(), pump.dexFactory(), dex.owner(), dex.treasury()]);
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        setChecks([
          { label: "Suite → Launch Factory", value: short(suitePump), ok: same(suitePump, PUMP_FACTORY_ADDRESS) },
          { label: "Suite → DEX", value: short(suiteDex), ok: same(suiteDex, ARC_DEX_FACTORY_ADDRESS) },
          { label: "DEX owner lock", value: short(dexOwner), ok: same(dexOwner, PUMP_SUITE_ADDRESS) },
          { label: "Treasury agreement", value: short(suiteTreasury), ok: [pumpTreasury, dexTreasury].every((value) => same(value, FEE_TREASURY)) && same(suiteTreasury, FEE_TREASURY) },
          { label: "Graduation threshold", value: `${Number(formatEther(threshold)).toLocaleString()} USDC`, ok: threshold === parseEther("4500") },
          { label: "Launch Factory → DEX", value: short(pumpDex), ok: same(pumpDex, ARC_DEX_FACTORY_ADDRESS) },
        ]);
        setCheckedAt(new Date().toLocaleString());
      } catch { setChecks([]); }
      finally { provider.destroy(); }
    })();
  }, []);
  const addressCards = [
    ["Arcodian Suite v6", PUMP_SUITE_ADDRESS, "Deploys and permanently wires the canonical Launch Factory and ARC DEX stack. Protocol fees accrue in-contract and are withdrawn by pull, so trading can never halt on treasury failure."],
    ["Launch Factory v6", PUMP_FACTORY_ADDRESS, "Creates canonical coin and bonding-curve contracts with one public rule set."],
    ["ARC DEX Factory", ARC_DEX_FACTORY_ADDRESS, "Creates the post-graduation pair and sends LP ownership to the burn address."],
    ["Fee treasury", FEE_TREASURY, "Receives protocol fees atomically; it cannot withdraw burned LP ownership."],
  ];
  return <section className="contracts-page">
    <TrustNav active="contracts" openHow={openHow} openFaq={openFaq} openCanary={openCanary} />
    <header><p className="kicker">Public onchain record</p><h1>Trust the wiring.<br/><em>Then verify it.</em></h1><p>These are the canonical Arc Testnet contracts read by Arcodian. Every address opens in the explorer; live wiring checks run again when this page loads.</p></header>
    <div className="contract-address-grid">{addressCards.map(([label,address,note])=><article key={address}><small>{label}</small><a href={`${ARC.explorer}/address/${address}`} target="_blank" rel="noreferrer">{address} ↗</a><p>{note}</p><button onClick={()=>void navigator.clipboard.writeText(address)}>Copy address</button></article>)}</div>
    <section className="wiring-proof"><div><p className="kicker">Live wiring proof</p><h2>{checks.length && checks.every((item)=>item.ok) ? "Canonical stack verified" : checks.length ? "Review required" : "Reading Arc Testnet…"}</h2><p>Read directly from chain {ARC.id}. No dashboard value can override these contract getters.</p>{checkedAt&&<small>Last checked {checkedAt}</small>}</div><div className="wiring-checks">{checks.map((item)=><span key={item.label} className={item.ok?"ok":"bad"}><i>{item.ok?"✓":"!"}</i><small>{item.label}</small><b>{item.value}</b></span>)}</div></section>
    <div className="contract-rules"><article><b>1%</b><small>Bonding-curve fee</small><p>Applied atomically to buys and sells before graduation.</p></article><article><b>4,500</b><small>USDC net threshold</small><p>The curve graduates only from its public onchain reserve.</p></article><article><b>0.30%</b><small>DEX total swap fee</small><p>Post-graduation swap pricing follows the canonical pair.</p></article><article><b>100%</b><small>LP ownership burned</small><p>Underlying liquidity stays tradable; its withdrawal right does not.</p></article></div>
  </section>;
}

export function FaqPage({ openHow, openContracts, openCanary }: { openHow: () => void; openContracts: () => void; openCanary: () => void }) {
  return <section className="faq-page"><TrustNav active="faq" openHow={openHow} openContracts={openContracts} openCanary={openCanary} /><header><p className="kicker">Plain answers</p><h1>Before you touch<br/><em>the market.</em></h1><p>Short answers about testnet status, pricing, fees, graduation, liquidity, and wallet safety.</p><button onClick={openHow}>Read the full mechanics →</button></header><div className="faq-list">{FAQ_ITEMS.map(([question,answer],index)=><details key={question} open={index===0}><summary><span>{String(index+1).padStart(2,"0")}</span>{question}<i>+</i></summary><p>{answer}</p></details>)}</div></section>;
}

export function HowItWorks({ enterMarket, openContracts, openFaq, openCanary }: { enterMarket: () => void; openContracts: () => void; openFaq: () => void; openCanary: () => void }) {
  return <section className="economics-page">
    <TrustNav active="how" openContracts={openContracts} openFaq={openFaq} openCanary={openCanary} />
    <header><p className="kicker">The workings, in public</p><h1>One curve. One threshold.<br/><em>No hidden exit.</em></h1><p>Arcodian v5 is a permissionless Arc Testnet market system. The interface reads the same contracts used for pricing, fees, graduation, and liquidity.</p><button className="primary" onClick={enterMarket}>Open the market</button></header>
    <div className="economics-flow">
      <article><i>01</i><small>Opening state</small><h2>1,000 USDC starting FDV</h2><p>A 1,000 USDC virtual reserve shapes the curve. It is pricing math—not withdrawable liquidity.</p></article>
      <article><i>02</i><small>While trading</small><h2>1% curve fee</h2><p>Every curve Buy or Sell charges 1%. Buy fees are removed before reserve growth; quotes and minimum output are calculated onchain.</p></article>
      <article><i>03</i><small>Graduation</small><h2>4,500 USDC net reserve</h2><p>At the threshold, the remaining tokens and real USDC move atomically into the canonical ARC DEX pair.</p></article>
      <article><i>04</i><small>After graduation</small><h2>LP ownership burned</h2><p>All LP tokens are minted to the burn address. The underlying token and USDC remain tradable, but no creator or deployer can withdraw the liquidity.</p></article>
    </div>
    <div className="economics-ledger">
      <div><small>ARC DEX total swap fee</small><strong>0.30%</strong><p>Applied to each post-graduation swap.</p></div>
      <div><small>Protocol share</small><strong>0.05%</strong><p>Sent to the immutable treasury; the remainder stays in pool economics.</p></div>
      <div><small>Expected graduation FDV</small><strong>≈30,250 USDC</strong><p>At the exact threshold; a final transaction can cross slightly above it.</p></div>
    </div>
    <aside><strong>Testnet notice</strong><p>Arcodian currently runs on Arc Testnet chain 5042002. Test USDC has no financial value. Contract addresses, pair reserves, activity, and LP burn proof remain independently inspectable through Arc Explorer.</p></aside>
  </section>;
}
