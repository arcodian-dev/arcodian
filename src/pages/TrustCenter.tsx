import { useEffect, useState } from "react";
import { Contract, formatEther, parseEther } from "ethers";
import { ARC, ARC_LEND_ADDRESS, ARC_LEND_COLLATERAL_ADDRESS, ARC_MAINNET, ARC_MAINNET_CONTRACTS, ARC_PAIR_FACTORY_ADDRESS, ARC_PAY_ADDRESS, CCTP_MAINNET_FEE_ROUTER, FEE_TREASURY, PUMP_FACTORY_ADDRESS, AGENT_PASSPORT_ADDRESS, AGENT_JOBS_ADDRESS, REPUTATION_REGISTRY_ADDRESS, VALIDATION_REGISTRY_ADDRESS, AGENT_PAY_V3_FACTORY_ADDRESS, AGENT_PAY_V6_FACTORY_ADDRESS, SESSION_KEY_ACCOUNT_ADDRESS, ADMIN_TIMELOCK_ADDRESS, ARCODIAN_MCP_ENDPOINT } from "../config";
import { FAQ_ITEMS, arcProvider, short } from "../shared";
import { fetchBurnLimitPerMessage, tokenMessengerFor } from "../bridgeRecovery";

function TrustNav({ active, openContracts, openHow }: { active: "contracts" | "how" | "faq" | "canary"; openContracts?: () => void; openHow?: () => void; openFaq?: () => void; openCanary?: () => void }) {
  return <nav className="trust-nav" aria-label="Trust Center sections">
    <span><small>Arcodian</small><b>Trust Center</b></span>
    <button className={active === "contracts" ? "active" : ""} onClick={openContracts}>Contracts</button>
    <button className={active === "how" || active === "faq" ? "active" : ""} onClick={openHow}>Docs, FAQ & Legal</button>
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
          { label: "Graduation threshold", value: `${Number(formatEther(threshold)).toLocaleString()} USDC`, ok: threshold === parseEther("12000") },
        ]);
        setCheckedAt(new Date().toLocaleString());
      } catch { setChecks([]); }
      finally { provider.destroy(); }
    })();
  }, []);
  const contractGroups: { title: string; note: string; cards: (readonly [string, string, string])[] }[] = [
    {
      title: "Money & market",
      note: "The USDC economy: payments, lending, and the permissionless launchpad.",
      cards: [
        ["Launch Factory v10", PUMP_FACTORY_ADDRESS, "Creates price-continuous coin and bonding-curve contracts, then graduates them into the shared pair factory below."],
        ["Pair Factory v2", ARC_PAIR_FACTORY_ADDRESS, "The permissionless AMM registry. While a coin's curve is running, only that curve may open its pair, so graduation liquidity cannot be front-run. LP ownership is burned at graduation."],
        ["Fee treasury", FEE_TREASURY, "Receives protocol fees atomically. Graduation liquidity is permanently burned; liquidity added later is withdrawable by whoever added it."],
        ...(ARC_PAY_ADDRESS ? [["Arc Pay", ARC_PAY_ADDRESS, "Exact-value invoice settlement. Each invoice settles once for its precise amount; a 0.30% fee is taken atomically and 99.70% reaches the merchant in the same transaction."] as const] : []),
        ...(ARC_LEND_ADDRESS ? [["Arc Lend market", ARC_LEND_ADDRESS, "Isolated USDC lending market. Supply native USDC or borrow against EURC collateral at up to 70% LTV; an oracle older than 90 hours fails closed."] as const] : []),
        ...(ARC_LEND_COLLATERAL_ADDRESS ? [["Arc Lend collateral · EURC", ARC_LEND_COLLATERAL_ADDRESS, "The canonical Circle EURC token accepted as collateral in the isolated Arc Lend market (6 decimals)."] as const] : []),
      ],
    },
    {
      title: "Agent economy",
      note: "ERC-8004 identity, escrowed jobs, and verified reputation — an agent is never granted spending authority by its identity alone.",
      cards: [
        ["Agent Passport", AGENT_PASSPORT_ADDRESS, "Binds an official ERC-8004 Agent ID to an authorized wallet with owner-only rotation. Identity never grants spending authority by itself."],
        ["Agent Jobs v2", AGENT_JOBS_ADDRESS, "Escrowed job lifecycle settled in USDC through Arc Pay. A nonzero provider Agent ID is accepted only when the provider is the current Passport-bound wallet — no Agent-ID spoofing."],
        ["Reputation Registry", REPUTATION_REGISTRY_ADDRESS, "Official ERC-8004 registry. Feedback is evidence-backed only when its tag names a real completed job and its authorized client or evaluator."],
        ["Validation Registry", VALIDATION_REGISTRY_ADDRESS, "Official ERC-8004 registry for independent validation of an agent's work, tied to the exact completed job."],
        ["Agent Pay Factory v3", AGENT_PAY_V3_FACTORY_ADDRESS, "Mints one isolated, non-custodial vault per owner whose bounded spending policies are keyed by Agent ID."],
        ["Agent Pay Factory v6 · testnet", AGENT_PAY_V6_FACTORY_ADDRESS, "ERC-1271-aware additive vault template with atomic EIP-712 batch payments. Testnet only; production UI remains on the reviewed migration path."],
      ],
    },
    {
      title: "Operational hardening · spikes",
      note: "Phase F testnet spikes. Bounded, fail-closed, not ERC-4337, not independently audited, not mainnet-ready.",
      cards: [
        ["Session-Key Account", SESSION_KEY_ACCOUNT_ADDRESS, "Owner installs a scoped session key (target + function + per-call and daily caps + time window + instant revoke). The key executes autonomously with no per-call owner signature; the account enforces every bound on-chain. Owner keeps custody."],
        ["Admin Timelock", ADMIN_TIMELOCK_ADDRESS, "Role-gated governed administration: schedule → enforced delay → execute, with cancel and a self-governed delay. The mechanism for moving admin to a production multisig."],
      ],
    },
    {
      title: "Arc Mainnet — live, real value",
      note: `Deployed on Arc Mainnet, chain ${ARC_MAINNET.id}, not Arc Testnet. Governance on these is still deployer-only — no mainnet multisig yet (see Mainnet readiness below). ArcBridgeRouter deployed on 2026-07-31 across 5 chains; verify links below open the relevant chain's own explorer.`,
      cards: [
        ["USDC-only Market Factory (V11, current)", ARC_MAINNET_CONTRACTS.marketUsdcFactoryV11, "Mainnet launch factory — every new coin launches here. Same fair-launch curve as V10 below, plus a creator fee split (1% trading fee, half to the launch's creator via pull-claim, half treasury) and a separate 1% one-time graduation fee (100% treasury)."],
        ["USDC-only Market Factory (V10, legacy)", ARC_MAINNET_CONTRACTS.marketUsdcFactoryV10, "Superseded by V11 above. Kept live read-only for the one coin still trading there that can't be migrated."],
        ["USDC-only Market Factory (V9, legacy)", ARC_MAINNET_CONTRACTS.marketUsdcFactoryV9, "Superseded by V10 above. Kept live read-only for the one coin still trading there that can't be migrated."],
        ["Market Graduation Hub", ARC_MAINNET_CONTRACTS.marketGraduationHub, "Seals graduation authority into the pair factory below."],
        ["Market Pair Factory", ARC_MAINNET_CONTRACTS.marketPairFactory, "Permissionless AMM registry — the direct-pair route Swap/Pools/Create pool read on-chain. No coin has graduated into it on mainnet yet; every V9/V10 graduation lands in its own Uniswap V3 pool instead."],
        ["Arc Pay (mainnet)", ARC_MAINNET_CONTRACTS.arcPay, "Exact-value invoice settlement, deployed to Arc Mainnet."],
        ["Agent Pay Factory v6 · mainnet", ARC_MAINNET_CONTRACTS.agentPayFactoryV6, "Additive ERC-1271-aware batch-payment factory. No automatic vault creation; production UI remains on the existing factory until Gateway and migration gates pass."],
        ["ArcBridgeRouter · Arc", CCTP_MAINNET_FEE_ROUTER[ARC_MAINNET.id], "1.5% fee router over Circle's official CCTP v2 rails. Proven live: real transactions on all 5 chains, plus independent third-party wallets bridging unaided."],
        ["ArcBridgeRouter · Ethereum", CCTP_MAINNET_FEE_ROUTER[1], "Same router contract, deployed on Ethereum mainnet — opens that chain's own explorer, not Arc's."],
        ["ArcBridgeRouter · Optimism", CCTP_MAINNET_FEE_ROUTER[10], "Same router contract, deployed on Optimism mainnet."],
        ["ArcBridgeRouter · Arbitrum", CCTP_MAINNET_FEE_ROUTER[42161], "Same router contract, deployed on Arbitrum mainnet."],
        ["ArcBridgeRouter · Base", CCTP_MAINNET_FEE_ROUTER[8453], "Same router contract, deployed on Base mainnet — the first chain this router was proven on with a real transaction."],
      ],
    },
  ];
  const explorerFor = (groupTitle: string, label: string): string => {
    if (groupTitle !== "Arc Mainnet — live, real value") return ARC.explorer;
    if (label.includes("Ethereum")) return "https://etherscan.io";
    if (label.includes("Optimism")) return "https://optimistic.etherscan.io";
    if (label.includes("Arbitrum")) return "https://arbiscan.io";
    if (label.includes("Base")) return "https://basescan.org";
    return ARC_MAINNET.explorer;
  };
  return <section className="contracts-page">
    <TrustNav active="contracts" openHow={openHow} openFaq={openFaq} openCanary={openCanary} />
    <header><p className="kicker">Public onchain record</p><h1>Trust the wiring.<br/><em>Then verify it.</em></h1><p>These are the canonical Arc Testnet contracts read by Arcodian, where most of the product still runs. Bridge and the USDC-only Market/Launchpad are additionally deployed on Arc Mainnet with real value — see the <a href="/developers/contracts.mainnet.json">mainnet registry</a> and <a href="#docs-readiness">Mainnet readiness</a>. Every address opens in the explorer; live wiring checks run again when this page loads. The <a href={ARCODIAN_MCP_ENDPOINT}>Arcodian MCP</a> reads the same contracts and returns unsigned transactions only — it never holds a key.</p></header>
    {contractGroups.map((group) => <div key={group.title} className="contract-group">
      <div className="contract-group-head"><h2>{group.title}</h2><p>{group.note}</p></div>
      <div className="contract-address-grid">{group.cards.map(([label,address,note])=><article key={label}><small>{label}</small><a href={`${explorerFor(group.title,label)}/address/${address}`} target="_blank" rel="noreferrer">{address} ↗</a><p>{note}</p><button onClick={()=>void navigator.clipboard.writeText(address)}>Copy address</button></article>)}</div>
    </div>)}
    <section className="wiring-proof"><div><p className="kicker">Live wiring proof</p><h2>{checks.length && checks.every((item)=>item.ok) ? "Canonical stack verified" : checks.length ? "Review required" : "Reading Arc Testnet…"}</h2><p>Read directly from chain {ARC.id}. No dashboard value can override these contract getters.</p>{checkedAt&&<small>Last checked {checkedAt}</small>}</div><div className="wiring-checks">{checks.map((item)=><span key={item.label} className={item.ok?"ok":"bad"}><i>{item.ok?"✓":"!"}</i><small>{item.label}</small><b>{item.value}</b></span>)}</div></section>
    <div className="contract-rules"><article><b>1%</b><small>Bonding-curve fee</small><p>Applied atomically to buys and sells before graduation.</p></article><article><b>12,000</b><small>USDC net threshold</small><p>The curve graduates only from its public onchain reserve.</p></article><article><b>0.30%</b><small>DEX total swap fee</small><p>Post-graduation swap pricing follows the canonical pair.</p></article><article><b>100%</b><small>LP ownership burned</small><p>Underlying liquidity stays tradable; its withdrawal right does not.</p></article></div>
  </section>;
}

export function FaqPage({ openHow, openContracts, openCanary }: { openHow: () => void; openContracts: () => void; openCanary: () => void }) {
  return <section className="faq-page"><TrustNav active="faq" openHow={openHow} openContracts={openContracts} openCanary={openCanary} /><header><p className="kicker">Plain answers</p><h1>Before you touch<br/><em>the market.</em></h1><p>Short answers about testnet status, pricing, fees, graduation, liquidity, and wallet safety.</p><button onClick={openHow}>Read the full mechanics →</button></header><div className="faq-list">{FAQ_ITEMS.map(([question,answer],index)=><details key={question} open={index===0}><summary><span>{String(index+1).padStart(2,"0")}</span>{question}<i>+</i></summary><p>{answer}</p></details>)}</div></section>;
}

const DOCS_SECTIONS = [
  ["what", "What Arcodian is"],
  ["wallet", "Wallet"],
  ["pay", "Arc Pay"],
  ["lend", "Arc Lend"],
  ["bridge", "Bridge"],
  ["fx", "StableCoin FX"],
  ["agent", "Agent economy"],
  ["lifecycle", "Launchpad & lifecycle"],
  ["fees", "Fees & graduation"],
  ["eurc", "EURC launches"],
  ["roadmap", "Roadmap"],
  ["safety", "Safety & custody"],
  ["verify", "Verify everything"],
  ["readiness", "Mainnet readiness"],
  ["faq", "FAQ"],
  ["legal", "Terms & refunds"],
] as const;

export function HowItWorks({ enterMarket, openContracts, openFaq, openCanary }: { enterMarket: () => void; openContracts: () => void; openFaq: () => void; openCanary: () => void }) {
  // Circle's own TokenMinter.burnLimitsPerMessage for outbound Arc Mainnet
  // burns, read live — it was 1 USDC when first confirmed 2026-07-31,
  // already 100,000 USDC by 2026-08-30, and Circle raises it over time
  // without notice, so a hardcoded number in this page's copy goes stale
  // exactly like the frontend's bridge gate itself used to.
  const [bridgeOutLimit, setBridgeOutLimit] = useState<bigint | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchBurnLimitPerMessage(ARC_MAINNET.rpc, tokenMessengerFor(ARC_MAINNET.id), ARC_MAINNET.nativeToken)
      .then((limit) => { if (!cancelled) setBridgeOutLimit(limit); });
    return () => { cancelled = true; };
  }, []);
  return <section className="docs-page">
    <TrustNav active="how" openContracts={openContracts} openFaq={openFaq} openCanary={openCanary} />
    <header className="docs-hero">
      <div>
        <p className="kicker">Documentation</p>
        <h1>How Arcodian works,<br/><em>end to end.</em></h1>
        <p>Arcodian is a USDC-native money app and market system on Arc: a self-custody wallet, exact-value payments, isolated lending, cross-chain bridging, stablecoin FX, and a permissionless launchpad. Bridge and the USDC-only launchpad/market are live on Arc Mainnet with real value; the rest of the stack runs on Arc Testnet. Every balance, price, fee, and graduation is executed by public contracts—this page documents each rail and the exact numbers behind it. Nothing here is set from a dashboard.</p>
        <div className="docs-hero-actions"><button className="primary" onClick={enterMarket}>Open the market</button><button onClick={openContracts}>See the contracts →</button></div>
      </div>
      <nav className="docs-toc" aria-label="On this page">
        <small>On this page</small>
        {DOCS_SECTIONS.map(([id, label], i) => <a key={id} href={`#docs-${id}`}><i>{String(i + 1).padStart(2, "0")}</i>{label}</a>)}
      </nav>
    </header>

    <article id="docs-what" className="docs-section">
      <div className="docs-section-head"><span>01</span><h2>What Arcodian is</h2></div>
      <p>One non-custodial app for Arc's USDC economy. Hold and send USDC, get paid with a single exact-value invoice, put idle USDC to work in an isolated lending market, bridge across chains over Circle CCTP, convert USDC⇄EURC, and launch or trade coins on a live bonding curve. The web app and the Android wallet only ever read contracts and ask your wallet to sign—they hold no keys and take no custody.</p>
      <div className="docs-cards">
        <div><b>Non-custodial</b><p>Keys live on your device or in your own wallet. Every action is a signature you approve—Arcodian never receives your seed phrase.</p></div>
        <div><b>USDC-native</b><p>USDC is the gas and the unit of account on Arc. Balances, fees, and payments are all denominated in it—no wrapped placeholder token.</p></div>
        <div><b>Verifiable</b><p>Contracts, reserves, invoices, and LP-burn proof are inspectable on Arc Explorer. The docs quote numbers; the chain confirms them.</p></div>
      </div>
    </article>

    <article id="docs-wallet" className="docs-section">
      <div className="docs-section-head"><span>02</span><h2>Wallet</h2></div>
      <p>A self-custody wallet for Arc—on the web and as a native Android app. It creates or imports a seed on-device, signs Arc transactions directly, and reaches every other product (Pay, Lend, Bridge, Swap) without handing control to a third party.</p>
      <div className="docs-cards">
        <div><b>On-device keys</b><p>The Android app stores the seed in the platform secure vault; the web wallet signs through your connected wallet. Raw key material is never written to localStorage or sent to a server.</p></div>
        <div><b>Multi-chain by design</b><p>The same address works on Arc Mainnet plus Ethereum, Arbitrum, Base, and Optimism mainnets (real USDC via Bridge), and on the equivalent testnets for testing. The wallet auto-switches network for every bridge approval and claim.</p></div>
        <div><b>Everything in one place</b><p>Send, receive, bridge, swap, pay an invoice, and supply or borrow—each is a wallet-signed transaction with the amount shown before you confirm.</p></div>
      </div>
      <aside className="docs-notice"><strong>Get the app</strong><p>The Arcodian testnet wallet ships as a downloadable Android APK from the wallet page. It is a debug/testnet build—install it only to exercise Arc Testnet flows, never with mainnet value.</p></aside>
    </article>

    <article id="docs-pay" className="docs-section">
      <div className="docs-section-head"><span>03</span><h2>Arc Pay</h2></div>
      <p><b>Arc Pay</b> turns a request into one exact-value, on-chain settlement. A merchant creates an invoice for a fixed USDC amount; the payer settles it in a single signed transaction that must match the amount to the cent. No streaming, no partial states, no custody in between.</p>
      <div className="economics-ledger">
        <div><small>Protocol fee</small><strong>0.30%</strong><p>Taken atomically on settlement; 99.70% reaches the merchant in the same transaction.</p></div>
        <div><small>Replay safety</small><strong>One-shot</strong><p>Each invoice settles exactly once. A second attempt on a paid or expired invoice reverts.</p></div>
        <div><small>Invoice expiry</small><strong>≤ 30 days</strong><p>Invoices carry an expiry (max 30 days) and an optional expected-payer lock. Refunds are merchant-funded and gross.</p></div>
      </div>
    </article>

    <article id="docs-lend" className="docs-section">
      <div className="docs-section-head"><span>04</span><h2>Arc Lend</h2></div>
      <p><b>Arc Lend</b> is an isolated money market: supply native USDC to earn borrower interest, or post EURC as collateral and borrow USDC against it. One collateral, one contract, one oracle—risk from any other asset can never spill into this market.</p>
      <div className="economics-ledger">
        <div><small>Max LTV</small><strong>70%</strong><p>Borrow up to 70% of collateral value. Liquidation opens at an 80% threshold with a 5% liquidator bonus.</p></div>
        <div><small>Interest reserve</small><strong>10%</strong><p>A tenth of accrued interest is retained as a protocol reserve; the rest compounds to suppliers via a borrow index.</p></div>
        <div><small>Oracle freshness</small><strong>≤ 90h</strong><p>Prices older than 90 hours fail closed—new borrows and risk-increasing actions revert until the oracle is refreshed. Widened from a 1-hour bound (2026-07-27): EUR/USD is a traditional-FX Pyth feed that goes fully quiet over the weekend, so the tighter window falsely reverted every Friday close through Sunday reopen regardless of oracle health.</p></div>
      </div>
      <aside className="docs-notice"><strong>Pyth canary</strong><p>The live market uses conservative 100 / 50 USDC caps and the official Pyth EUR/USD feed through an Arc adapter. A dedicated permissionless keeper updates Pyth and syncs the market; stale prices fail closed.</p></aside>
    </article>

    <article id="docs-bridge" className="docs-section">
      <div className="docs-section-head"><span>05</span><h2>Bridge</h2></div>
      <p>Move USDC between Arc and other chains over official <b>Circle CCTP</b> rails—burn-and-mint, not a third-party bridge. It runs standalone and inside the wallet, which switches networks for you on both the burn and the mint. <b>Outbound (Arc → Ethereum, Optimism, Arbitrum, Base) is live on Arc Mainnet with real USDC</b>, proven with real transactions including independent third-party wallets bridging unaided. <b>Inbound (another chain → Arc) is not currently completing</b>: burns land fine on the source chain, but Circle's attestation service isn't yet attesting messages where Arc is the destination — confirmed 2026-08-30 against real burns that never progressed past "pending" regardless of age. This should resolve once Arc's public mainnet launches; nothing in Arcodian's own contracts blocks it. A dedicated testnet version (plus Avalanche and Polygon Amoy) is also available for testing without real value — check which network you're connected to before signing.</p>
      <div className="docs-cards">
        <div><b>Burn → attest → mint</b><p>Circle burns on the source chain, issues an attestation, then mints the same USDC on the destination. Arcodian only orchestrates the two wallet signatures.</p></div>
        <div><b>Five mainnet routes, five testnet routes</b><p>Arc, Ethereum, Arbitrum, Base, and Optimism on mainnet (plus Avalanche and Polygon Amoy on testnet). Each CCTP domain is wired to the deterministic v2 messenger address, identical across every chain.</p></div>
        <div><b>Circle's mainnet burn limit</b><p>Circle caps a single burn out of Arc Mainnet at {bridgeOutLimit !== null ? `${(Number(bridgeOutLimit) / 1e6).toLocaleString()} USDC` : "a per-transaction amount"} right now — a network-side rollout limit on their side, not Arcodian's, that rises over time. Read live rather than hardcoded so this figure can't go stale; the interface surfaces it clearly and caps the amount to match.</p></div>
        <div><b>Recoverable</b><p>If a refresh interrupts a flow, the burn is recorded once and only the pending mint resumes—no double bridge. The destination mint needs a little gas on the destination chain.</p></div>
      </div>
    </article>

    <article id="docs-fx" className="docs-section">
      <div className="docs-section-head"><span>06</span><h2>StableCoin FX</h2></div>
      <p>The <b>StableCoin FX</b> desk smart-routes USDC and EURC. Arcodian&apos;s on-chain pool competes with configured external venues, while strict target allowlisting prevents an aggregator response from redirecting approvals or transactions to an untrusted contract.</p>
      <div className="economics-ledger">
        <div><small>Pool type</small><strong>Constant-product</strong><p>x·y=k AMM over the 6-decimal USDC and EURC interfaces.</p></div>
        <div><small>Pool fee</small><strong>0.10%</strong><p>Lower than a curve trade—this is pure stablecoin conversion.</p></div>
        <div><small>Protection</small><strong>Min-out + deadline</strong><p>Every swap enforces a minimum output and an expiry, wallet-signed.</p></div>
      </div>
    </article>

    <article id="docs-agent" className="docs-section">
      <div className="docs-section-head"><span>07</span><h2>Agent economy</h2></div>
      <p>Arcodian lets software hold money <b>with limits, not a blank check</b>. An agent gets an official on-chain identity, can be given a bounded budget, can take on paid work, and builds a reputation from verifiable outcomes — without anyone handing it an unrestricted wallet.</p>
      <div className="economics-ledger">
        <div><small>Identity</small><strong>Agent Passport</strong><p>An ERC-8004 Agent ID is bound to one authorized wallet with owner-only rotation. Identity never grants spending authority by itself.</p></div>
        <div><small>Bounded spend</small><strong>Agent Pay</strong><p>One isolated, non-custodial vault per owner with per-payment, daily, expiry, and merchant-allowlist limits. The owner can pause or withdraw anytime.</p></div>
        <div><small>Work</small><strong>Jobs</strong><p>USDC is escrowed and released only when a job is verifiably completed; rejected or expired jobs refund the client.</p></div>
        <div><small>Reputation</small><strong>Evidence-backed</strong><p>Scores come only from real completed jobs plus independent validation. Owners and their agents cannot rate themselves.</p></div>
        <div><small>Access</small><strong>Arcodian MCP</strong><p>Agents read state and receive <em>unsigned</em> transactions to sign themselves — the server never holds a key or signs.</p></div>
        <div><small>Delegation</small><strong>Scoped, on-chain</strong><p>Session-key and timelock spikes enforce capability, target, amount, time, and revocation at execution time. Testnet spikes — not audited, not mainnet.</p></div>
      </div>
      <p className="docs-note">Every agent-economy contract is listed with a live wiring proof in the <a href="/contracts">Trust Center</a>, and machine-readable feeds are on the <a href="/developers">developer portal</a>.</p>
    </article>

    <article id="docs-lifecycle" className="docs-section">
      <div className="docs-section-head"><span>08</span><h2>Launchpad & lifecycle</h2></div>
      <p>The launchpad is permissionless: anyone can create a coin and it gets a live bonding-curve market immediately. A coin then moves through four public states—there is no hidden mint, pause, or exit between them.</p>
      <div className="economics-flow">
        <div><i>01</i><small>Opening state</small><h3>1,000 USDC starting FDV</h3><p>A 1,000 USDC virtual reserve shapes the curve. It is pricing math—not withdrawable liquidity.</p></div>
        <div><i>02</i><small>While trading</small><h3>Open price discovery</h3><p>Buys and sells execute against the curve. Every quote and minimum-output is computed on-chain before you sign.</p></div>
        <div><i>03</i><small>Graduation</small><h3>12,000 USDC net reserve</h3><p>At the threshold, remaining tokens and real collateral move atomically into the canonical ARC DEX pair.</p></div>
        <div><i>04</i><small>After graduation</small><h3>LP ownership burned</h3><p>All LP tokens are minted to the burn address. The token and collateral stay tradable; nobody can withdraw the liquidity.</p></div>
      </div>
    </article>

    <article id="docs-fees" className="docs-section">
      <div className="docs-section-head"><span>09</span><h2>Fees & graduation</h2></div>
      <p>Two fee regimes, both charged atomically by the contracts—before and after graduation.</p>
      <div className="economics-ledger">
        <div><small>Bonding-curve fee</small><strong>1.00%</strong><p>Charged on every curve buy and sell. Buy fees are removed before reserve growth.</p></div>
        <div><small>ARC DEX total swap fee</small><strong>0.30%</strong><p>Symmetric on buys and sells of the graduated pair.</p></div>
        <div><small>Protocol share</small><strong>0.05%</strong><p>Accrues in-contract and is withdrawn by pull, so trading never halts on a treasury failure.</p></div>
        <div><small>Graduation threshold</small><strong>12,000</strong><p>Net collateral reserve. A final transaction can cross slightly above it.</p></div>
      </div>
    </article>

    <article id="docs-eurc" className="docs-section">
      <div className="docs-section-head"><span>10</span><h2>EURC launches</h2></div>
      <p>Coins can be denominated in <b>EURC</b> instead of USDC. Pick the collateral with the USDC/EURC toggle when you create. The bonding curve, 1% fee, and graduation logic are identical; only the quote asset changes.</p>
      <div className="docs-cards">
        <div><b>Auto-detected</b><p>Choose EURC and every trade on that coin routes through EURC—approval, buy, and sell—without another switch.</p></div>
        <div><b>Priced in €</b><p>Reserves, market cap, and the graduation bar display in euros. USDC coins are byte-identical to before.</p></div>
        <div><b>Own pool at graduation</b><p>An EURC coin graduates into an EURC-denominated ARC DEX pair, with the same LP-burn guarantee.</p></div>
      </div>
    </article>

    <article id="docs-roadmap" className="docs-section">
      <div className="docs-section-head"><span>11</span><h2>Roadmap</h2></div>
      <p>Where Arcodian is heading, in order. Each phase ships as public contracts plus a wallet surface — Bridge and USDC-only Market are already live on Arc Mainnet with real value; the rest run on testnet.</p>
      <div className="economics-flow">
        <div><i>01</i><small>Live · testnet + mainnet</small><h3>Payments</h3><p>Arc Pay exact-value invoices are live on both Arc Testnet and Arc Mainnet. Next: recurring requests, payment links, and merchant webhooks.</p></div>
        <div><i>02</i><small>Live · testnet</small><h3>Stablecoin FX</h3><p>USDC⇄EURC desk is live on Arc Testnet — no official Arc Mainnet EURC address exists yet, so this stays testnet-only until one does. Next: deeper pools and best-execution routing across more Arc stablecoins.</p></div>
        <div><i>03</i><small>Planned</small><h3>E-commerce</h3><p>A checkout SDK and hosted pay pages so any store can accept exact USDC/EURC settlement with an order lifecycle.</p></div>
        <div><i>04</i><small>Planned</small><h3>Agentic economy</h3><p>Programmable, policy-scoped wallets so autonomous agents can pay, get paid, and settle on Arc under spending limits.</p></div>
      </div>
    </article>

    <article id="docs-safety" className="docs-section">
      <div className="docs-section-head"><span>12</span><h2>Safety & custody</h2></div>
      <p>Arcodian is non-custodial by construction. The interface talks only to wallets, official Arc endpoints (or, where no official Arc Mainnet endpoint yet exists, an independently-verified third-party one — see Mainnet readiness below), and allowlisted route APIs; it never stores or transmits a private key. Community posts and coin links are signed by the wallet and verified server-side, so nobody can impersonate a creator. Features without an explicit mainnet deployment and readiness sign-off stay Arc Testnet only.</p>
      <aside className="docs-notice"><strong>Mixed testnet/mainnet notice</strong><p>Bridge, the USDC-only Market/Launchpad, and the additive Agent Pay V6 factory are deployed on Arc Mainnet, chain 5042. V6 has no automatic vault creation and the production UI remains on the reviewed migration path. Always check the network your wallet shows before signing. The active agent-economy surfaces and V6 batch vault testing run on Arc Testnet chain 5042002, where test USDC and test EURC have no financial value. Contract addresses, pool reserves, activity, and LP-burn proof remain independently inspectable through each network's explorer.</p></aside>
    </article>

    <article id="docs-verify" className="docs-section">
      <div className="docs-section-head"><span>13</span><h2>Verify everything</h2></div>
      <p>Don't take the docs on faith. The Contracts page reads the live wiring straight from chain, the FAQ covers the edge cases, and Arc Explorer lets you inspect any address or transaction yourself.</p>
      <div className="docs-links">
        <button onClick={openContracts}><b>Contracts →</b><small>Live on-chain wiring proof</small></button>
        <a href="#docs-faq"><b>FAQ ↓</b><small>Plain answers to the edge cases</small></a>
        <a href={ARC.explorer} target="_blank" rel="noreferrer"><b>Arc Explorer ↗</b><small>Inspect any address or transaction</small></a>
      </div>
    </article>

    <article id="docs-readiness" className="docs-section readiness-section">
      <div className="docs-section-head"><span>14</span><h2>Mainnet readiness</h2></div>
      <p><b>Current decision: PARTIAL GO.</b> Bridge (Circle CCTP), the USDC-only Market/Launchpad, and Swap (Arcodian's own on-chain routing across the Mainnet launch/DEX stack and permissionless external pools) are deployed and live on Arc Mainnet with real USDC — verified with real on-chain transactions, not just a deployment script. Everything else (StableCoin FX, Arc Lend, EURC launches, the agent-economy stack) stays testnet-only until its own gates below clear. Governance and audit gates for the mainnet contracts that do exist remain open.</p>
      <div className="readiness-grid">
        <div className="ready"><small>LIVE</small><b>Bridge + USDC Market + Swap on Arc Mainnet</b><p>ArcBridgeRouter (Ethereum, Optimism, Arbitrum, Base, Arc), the USDC-only launch/DEX stack, and Swap's routing across it plus permissionless external pools are deployed to Arc Mainnet, chain 5042, and proven with real transactions. Source-verified on Sourcify + public Blockscout mirrors for the 4 EVM chains; Arc's own explorer is third-party and unofficial (no official Circle explorer is public yet) and its verify endpoint currently errors server-side on their end.</p></div>
        <div className="blocked"><small>BLOCKER</small><b>Official Arc Mainnet infrastructure</b><p>No official Circle RPC or explorer for Arc Mainnet is public yet — the RPC in use is a third-party operator's endpoint, independently verified against known on-chain state but not Circle's own. Swap this out the moment an official endpoint exists.</p></div>
        <div className="blocked"><small>BLOCKER</small><b>Mainnet governance multisig</b><p>The mainnet contracts deployed so far are still controlled by a single deployer key, not a multisig. A production multisig + timelock for mainnet admin is not yet deployed (the 2-of-2 canary below is a testnet ArcLendV2 rehearsal, not the mainnet path).</p></div>
        <div className="blocked"><small>BLOCKER</small><b>Independent audit</b><p>A 2026-07-27 in-house self-review across market, lending, and frontend surfaces found no critical/high issue and fixed every medium finding it did surface — but a self-review is not a substitute for an independent third-party audit with sign-off, which remains open, including for the mainnet bridge/market contracts.</p></div>
        <div className="warning"><small>CANARY LIVE (TESTNET)</small><b>Multisig + timelock rehearsal</b><p>A 2-of-2 governance canary and 24-hour timelock control ArcLendV2 on Arc Testnet. All 27 canonical testnet contracts are source-verified; this is the rehearsal for the mainnet governance path above, not mainnet itself.</p></div>
        <div className="ready"><small>VERIFIED</small><b>Separated risk controls</b><p>Guardian can pause and lower caps immediately but cannot override oracle, raise caps, withdraw reserves, or replace itself. Increases require 24h timelock plus 48h market delay.</p></div>
        <div className="warning"><small>HARDEN</small><b>Indexer redundancy</b><p>Monitoring and keepers are healthy but run on one host. Add a second independent reader/alert path and keeper failover.</p></div>
        <div className="ready"><small>VERIFIED</small><b>Testnet controls</b><p>Pyth confidence + 20% deviation guards, a 90-hour staleness window sized to EUR/USD's real weekend market closure, granular pause, 50,000/25,000 USDC caps, bad-debt accounting, live E2E, monitoring, and negative controls are active.</p></div>
      </div>
      <p className="readiness-links"><a href="/developers">Open Developer Portal ↗</a><a href="/contracts">Inspect live contracts ↗</a></p>
      <details className="machine-resources"><summary>Machine-readable resources +</summary><div><a href="/developers/mainnet-readiness.json">Readiness report</a><a href="/developers/contracts.json">Contract registry</a><a href="/developers/legacy-migration.json">Migration manifest</a></div></details>
    </article>

    <article id="docs-faq" className="docs-section">
      <div className="docs-section-head"><span>15</span><h2>Frequently asked questions</h2></div>
      <div className="faq-list docs-faq-list">{FAQ_ITEMS.map(([question,answer],index)=><details key={question} open={index===0}><summary><span>{String(index+1).padStart(2,"0")}</span>{question}<i>+</i></summary><p>{answer}</p></details>)}</div>
    </article>

    <article id="docs-legal" className="docs-section">
      <div className="docs-section-head"><span>16</span><h2>Terms, risk & refunds</h2></div>
      <p>Bridge, the USDC-only Market/Launchpad, and Swap move real USDC on Arc Mainnet — treat every transaction there as final and irreversible with real financial consequences. Every other Arcodian surface (StableCoin FX, Arc Lend, EURC launches, the agent-economy contracts) is a testnet interface where test assets have no financial value. Users remain responsible for reviewing the network, recipient, amount, allowance, price impact, health factor, and transaction before signing, on either network.</p>
      <div className="docs-cards">
        <div><b>Self-custody</b><p>Arcodian does not hold recovery phrases or sign on a user&apos;s behalf. Blockchain transactions are public and normally irreversible.</p></div>
        <div><b>Payments & refunds</b><p>Arc Pay refunds are new merchant-funded transactions returning the gross amount. The original protocol fee and network costs are not reversed.</p></div>
        <div><b>Audit status</b><p>No product, on either network, is represented as independently audited, insured, or guaranteed. Arc Mainnet Bridge and Market are live and proven with real transactions but have not had third-party audit sign-off — see Mainnet readiness. Availability may change while canary controls are tested.</p></div>
      </div>
      <div className="docs-links"><a href="/terms.html"><b>Full Terms ↗</b><small>Canonical legal text</small></a><a href="/refund-policy.html"><b>Refund Policy ↗</b><small>Eligibility and process</small></a><a href="mailto:support@arcodian.fun"><b>Support ↗</b><small>support@arcodian.fun</small></a></div>
    </article>
  </section>;
}
