import { useEffect, useState } from "react";
import { Contract, formatEther, parseEther } from "ethers";
import { ARC, ARC_PAIR_FACTORY_ADDRESS, FEE_TREASURY, PUMP_FACTORY_ADDRESS } from "../config";
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
        // V8 has no suite contract — the launch factory is the root, and it
        // graduates into ArcPairFactoryV2 rather than a DEX of its own. The
        // old suite/DEX-owner checks described V7's shape and are gone with it.
        const pump = new Contract(PUMP_FACTORY_ADDRESS, ["function graduationThreshold() view returns(uint256)", "function treasury() view returns(address)", "function pairFactory() view returns(address)"], provider);
        const pairFactory = new Contract(ARC_PAIR_FACTORY_ADDRESS, ["function graduationAuthority() view returns(address)", "function treasury() view returns(address)"], provider);
        const [threshold, pumpTreasury, pumpPairFactory, authority, pairTreasury] = await Promise.all([
          pump.graduationThreshold(), pump.treasury(), pump.pairFactory(),
          pairFactory.graduationAuthority(), pairFactory.treasury(),
        ]);
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        setChecks([
          { label: "Launch Factory → Pair Factory", value: short(pumpPairFactory), ok: same(pumpPairFactory, ARC_PAIR_FACTORY_ADDRESS) },
          // The pair reservation that makes graduation unstealable is only in
          // force while the authority points back at this launch factory.
          { label: "Graduation authority sealed", value: short(authority), ok: same(authority, PUMP_FACTORY_ADDRESS) },
          { label: "Treasury agreement", value: short(pumpTreasury), ok: [pumpTreasury, pairTreasury].every((value) => same(value, FEE_TREASURY)) },
          { label: "Graduation threshold", value: `${Number(formatEther(threshold)).toLocaleString()} USDC`, ok: threshold === parseEther("4500") },
        ]);
        setCheckedAt(new Date().toLocaleString());
      } catch { setChecks([]); }
      finally { provider.destroy(); }
    })();
  }, []);
  const addressCards = [
    ["Launch Factory v8", PUMP_FACTORY_ADDRESS, "Creates coin and bonding-curve contracts with one public rule set, and graduates them into the shared pair factory below."],
    ["Pair Factory v2", ARC_PAIR_FACTORY_ADDRESS, "The permissionless AMM registry. While a coin's curve is running, only that curve may open its pair, so graduation liquidity cannot be front-run. LP ownership is burned at graduation."],
    ["Fee treasury", FEE_TREASURY, "Receives protocol fees atomically. Graduation liquidity is permanently burned; liquidity added later is withdrawable by whoever added it."],
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

const DOCS_SECTIONS = [
  ["what", "What Arcodian is"],
  ["lifecycle", "Coin lifecycle"],
  ["fees", "Fees & graduation"],
  ["eurc", "EURC launches"],
  ["fx", "StableCoin FX"],
  ["bridge", "Bridge"],
  ["safety", "Safety & custody"],
  ["verify", "Verify everything"],
] as const;

export function HowItWorks({ enterMarket, openContracts, openFaq, openCanary }: { enterMarket: () => void; openContracts: () => void; openFaq: () => void; openCanary: () => void }) {
  return <section className="docs-page">
    <TrustNav active="how" openContracts={openContracts} openFaq={openFaq} openCanary={openCanary} />
    <header className="docs-hero">
      <div>
        <p className="kicker">Documentation</p>
        <h1>How Arcodian works,<br/><em>end to end.</em></h1>
        <p>Arcodian is a permissionless market system on Arc Testnet. Every price, fee, and graduation is executed by public contracts—this page documents each rail and the exact numbers behind it. Nothing here is set from a dashboard.</p>
        <div className="docs-hero-actions"><button className="primary" onClick={enterMarket}>Open the market</button><button onClick={openContracts}>See the contracts →</button></div>
      </div>
      <nav className="docs-toc" aria-label="On this page">
        <small>On this page</small>
        {DOCS_SECTIONS.map(([id, label], i) => <a key={id} href={`#docs-${id}`}><i>{String(i + 1).padStart(2, "0")}</i>{label}</a>)}
      </nav>
    </header>

    <article id="docs-what" className="docs-section">
      <div className="docs-section-head"><span>01</span><h2>What Arcodian is</h2></div>
      <p>A launchpad and exchange built for Arc's USDC-native economy. Anyone can create a coin; it gets a live bonding-curve market the moment it launches. When a coin matures it graduates to a canonical AMM pair and its liquidity ownership is burned. The web app only ever reads contracts and asks your wallet to sign—it holds no keys and takes no custody.</p>
      <div className="docs-cards">
        <div><b>Permissionless</b><p>No allowlist, no approval queue. The same rule set applies to every creator and trader.</p></div>
        <div><b>Readable</b><p>Creator, contract, holders, tape, and curve sit in one view. Quotes come from on-chain reserves.</p></div>
        <div><b>Non-custodial</b><p>Each buy, sell, swap, or bridge is a wallet-signed transaction. Arcodian never receives your seed phrase.</p></div>
      </div>
    </article>

    <article id="docs-lifecycle" className="docs-section">
      <div className="docs-section-head"><span>02</span><h2>Coin lifecycle</h2></div>
      <p>A coin moves through four public states. There is no hidden mint, pause, or exit between them.</p>
      <div className="economics-flow">
        <div><i>01</i><small>Opening state</small><h3>1,000 USDC starting FDV</h3><p>A 1,000 USDC virtual reserve shapes the curve. It is pricing math—not withdrawable liquidity.</p></div>
        <div><i>02</i><small>While trading</small><h3>Open price discovery</h3><p>Buys and sells execute against the curve. Every quote and minimum-output is computed on-chain before you sign.</p></div>
        <div><i>03</i><small>Graduation</small><h3>4,500 USDC net reserve</h3><p>At the threshold, remaining tokens and real collateral move atomically into the canonical ARC DEX pair.</p></div>
        <div><i>04</i><small>After graduation</small><h3>LP ownership burned</h3><p>All LP tokens are minted to the burn address. The token and collateral stay tradable; nobody can withdraw the liquidity.</p></div>
      </div>
    </article>

    <article id="docs-fees" className="docs-section">
      <div className="docs-section-head"><span>03</span><h2>Fees & graduation</h2></div>
      <p>Two fee regimes, both charged atomically by the contracts—before and after graduation.</p>
      <div className="economics-ledger">
        <div><small>Bonding-curve fee</small><strong>1.00%</strong><p>Charged on every curve buy and sell. Buy fees are removed before reserve growth.</p></div>
        <div><small>ARC DEX total swap fee</small><strong>0.30%</strong><p>Symmetric on buys and sells of the graduated pair.</p></div>
        <div><small>Protocol share</small><strong>0.05%</strong><p>Accrues in-contract and is withdrawn by pull, so trading never halts on a treasury failure.</p></div>
        <div><small>Graduation threshold</small><strong>4,500</strong><p>Net collateral reserve. A final transaction can cross slightly above it.</p></div>
      </div>
    </article>

    <article id="docs-eurc" className="docs-section">
      <div className="docs-section-head"><span>04</span><h2>EURC launches</h2></div>
      <p>Coins can be denominated in <b>EURC</b> instead of USDC. Pick the collateral with the USDC/EURC toggle when you create. The bonding curve, 1% fee, and graduation logic are identical; only the quote asset changes.</p>
      <div className="docs-cards">
        <div><b>Auto-detected</b><p>Choose EURC and every trade on that coin routes through EURC—approval, buy, and sell—without another switch.</p></div>
        <div><b>Priced in €</b><p>Reserves, market cap, and the graduation bar display in euros. USDC coins are byte-identical to before.</p></div>
        <div><b>Own pool at graduation</b><p>An EURC coin graduates into an EURC-denominated ARC DEX pair, with the same LP-burn guarantee.</p></div>
      </div>
    </article>

    <article id="docs-fx" className="docs-section">
      <div className="docs-section-head"><span>05</span><h2>StableCoin FX</h2></div>
      <p>The <b>StableCoin FX</b> desk swaps USDC and EURC directly through the on-chain Arc FX pool—a constant-product AMM. It is the fastest path between the two stablecoins: no aggregator, no bridge, one rate quoted by the pool.</p>
      <div className="economics-ledger">
        <div><small>Pool type</small><strong>Constant-product</strong><p>x·y=k AMM over the 6-decimal USDC and EURC interfaces.</p></div>
        <div><small>Pool fee</small><strong>0.10%</strong><p>Lower than a curve trade—this is pure stablecoin conversion.</p></div>
        <div><small>Protection</small><strong>Min-out + deadline</strong><p>Every swap enforces a minimum output and an expiry, wallet-signed.</p></div>
      </div>
    </article>

    <article id="docs-bridge" className="docs-section">
      <div className="docs-section-head"><span>06</span><h2>Bridge</h2></div>
      <p>Move test USDC in and out of Arc over official <b>Circle CCTP</b> rails. Every route starts or ends on Arc, and the destination mint needs a little gas on the destination chain.</p>
      <div className="docs-cards">
        <div><b>Burn → attest → mint</b><p>Circle burns on the source, attests, then mints on the destination. Arcodian only orchestrates the wallet signatures.</p></div>
        <div><b>Recoverable</b><p>If a browser refresh interrupts a flow, the burn is confirmed once and only the pending mint step resumes—no double bridge.</p></div>
        <div><b>Arc-anchored</b><p>Routes that neither start nor end on Arc are rejected before any transaction is built.</p></div>
      </div>
    </article>

    <article id="docs-safety" className="docs-section">
      <div className="docs-section-head"><span>07</span><h2>Safety & custody</h2></div>
      <p>Arcodian is non-custodial by construction. The interface talks only to wallets, official Arc endpoints, and allowlisted route APIs; it never stores or transmits a private key. Community posts and coin links are signed by the wallet and verified server-side, so nobody can impersonate a creator. Mainnet paths stay fail-closed until every release check is signed off.</p>
      <aside className="docs-notice"><strong>Testnet notice</strong><p>Arcodian currently runs on Arc Testnet chain 5042002. Test USDC and test EURC have no financial value. Contract addresses, pool reserves, activity, and LP-burn proof remain independently inspectable through Arc Explorer.</p></aside>
    </article>

    <article id="docs-verify" className="docs-section">
      <div className="docs-section-head"><span>08</span><h2>Verify everything</h2></div>
      <p>Don't take the docs on faith. The Contracts page reads the live wiring straight from chain, the Canary console lets you run small-value signed tests, and the FAQ covers the edge cases.</p>
      <div className="docs-links">
        <button onClick={openContracts}><b>Contracts →</b><small>Live on-chain wiring proof</small></button>
        <button onClick={openCanary}><b>Canary console →</b><small>Run signed release tests</small></button>
        <button onClick={openFaq}><b>FAQ →</b><small>Plain answers to the edge cases</small></button>
        <a href={ARC.explorer} target="_blank" rel="noreferrer"><b>Arc Explorer ↗</b><small>Inspect any address or transaction</small></a>
      </div>
    </article>
  </section>;
}
