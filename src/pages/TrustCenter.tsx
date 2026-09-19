import { useEffect, useState } from "react";
import { Contract, formatEther, parseEther } from "ethers";
import { ARC, ARC_LEND_ADDRESS, ARC_LEND_COLLATERAL_ADDRESS, ARC_MAINNET, ARC_MAINNET_CONTRACTS, ARC_PAIR_FACTORY_ADDRESS, ARC_PAY_ADDRESS, CCTP_MAINNET_FEE_ROUTER, CCTP_MAINNET_TOKEN_MESSENGER_V2, CCTP_MAINNET_MESSAGE_TRANSMITTER_V2, FEE_TREASURY, PUMP_FACTORY_ADDRESS, AGENT_PASSPORT_ADDRESS, AGENT_JOBS_ADDRESS, REPUTATION_REGISTRY_ADDRESS, VALIDATION_REGISTRY_ADDRESS, AGENT_PAY_V3_FACTORY_ADDRESS, AGENT_PAY_V6_FACTORY_ADDRESS, SESSION_KEY_ACCOUNT_ADDRESS, ADMIN_TIMELOCK_ADDRESS, ARCODIAN_MCP_ENDPOINT } from "../config";
import { FAQ_ITEMS, arcProvider, short } from "../shared";
import { STOCKS } from "../stocks";
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

// Every Arcodian contract on this page is source-verified on Circle's
// official explorer, explorer.arc.io (checked 2026-09-18). That explorer sits
// behind a Cloudflare challenge that a server-side proxy cannot pass, so this
// is a recorded fact, while arcexplorer.org's status below is read live.
// The launch hook is only verifiable there and on Sourcify: the other
// explorers do not index contracts created through the CREATE2 deployer.
/** aNVDA … aCOIN, in ArcStockMarket asset-id order. */
const STOCK_TOKENS = [
  "0xF5e18eE81f28A4d68FBE0684EF066720c7a82ab5", "0x5C073fD59bD8D0a36b1D21Eb4bA2C59C26F414E2", "0x7749b8aC3C3748D8eAEA62069CE1374a5f0A5177",
  "0x6C0E702b10Ca01C952F5F1b64378963cC8daf640", "0xca5DE7fbc309e680eE9dA7704dA34aA9937c4e7B", "0x40f1F5dEC1AaBc17C00A58cA2aCfC28C90c1aF85",
  "0xDfEC52612890B31E3E1E4ea754b80aD1F963BD44", "0xfE5FC940fC868a0e38A4e1829670435C61162eCe", "0x5e24d24C21bEBa3a984721CeE533acf45509EdA9",
  "0x99A4e6C7089148f16172DF312bD46b58E0F23250",
];
const OFFICIAL_EXPLORER_VERIFIED = new Set([
  ARC_MAINNET_CONTRACTS.arcStockMarket, ARC_MAINNET_CONTRACTS.arcStockPriceFeed, ...STOCK_TOKENS,
  ARC_MAINNET_CONTRACTS.launchFactoryV15, ARC_MAINNET_CONTRACTS.launchHookV15, ARC_MAINNET_CONTRACTS.v4Router,
  ARC_MAINNET_CONTRACTS.marketRouter, ARC_MAINNET_CONTRACTS.marketPairFactory, ARC_MAINNET_CONTRACTS.v3Factory,
  ARC_MAINNET_CONTRACTS.v3SwapRouter, ARC_MAINNET_CONTRACTS.v3Quoter, ARC_MAINNET_CONTRACTS.v3PositionManager,
  ARC_MAINNET_CONTRACTS.externalV3FeeRouter, ARC_MAINNET_CONTRACTS.fxPool, ARC_MAINNET_CONTRACTS.arcLendMarket, ARC_MAINNET_CONTRACTS.arcEurUsdOracle, ARC_MAINNET_CONTRACTS.arcPay, ARC_MAINNET_CONTRACTS.agentPayFactory,
  ARC_MAINNET_CONTRACTS.agentPassport, ARC_MAINNET_CONTRACTS.agentJobs, ARC_MAINNET_CONTRACTS.sessionKeyAccount,
  ARC_MAINNET_CONTRACTS.adminTimelock,
].map((address) => address.toLowerCase()));

export function ContractsPage({ openHow, openFaq, openCanary }: { openHow: () => void; openFaq: () => void; openCanary: () => void }) {
  const [checks, setChecks] = useState<Array<{ label: string; value: string; ok: boolean }>>([]);
  const [checkedAt, setCheckedAt] = useState("");
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  useEffect(() => {
    // Reads Arc Mainnet. This used to read the testnet launch factory and
    // pair factory, which meant the "live wiring proof" on a page about real
    // money was proving the wiring of contracts holding none.
    const provider = arcProvider(ARC_MAINNET);
    void (async () => {
      try {
        const factory = new Contract(ARC_MAINNET_CONTRACTS.launchFactoryV15, [
          "function wiringOk() view returns(bool)",
          "function ENGINE_VERSION() view returns(uint8)",
          "function POOL_FEE() view returns(uint24)",
          "function GRADUATION_QUOTE() view returns(uint256)",
          "function GRADUATION_FEE_BPS() view returns(uint128)",
          "function treasury() view returns(address)",
          "function poolManager() view returns(address)",
          "function quote() view returns(address)",
        ], provider);
        const hook = new Contract(ARC_MAINNET_CONTRACTS.launchHookV15, [
          "function factory() view returns(address)",
          "function treasury() view returns(address)",
          "function TRADE_FEE_BPS() view returns(uint256)",
          "function CREATOR_FEE_BPS() view returns(uint256)",
        ], provider);
        // One read at a time, each retried once: twelve parallel eth_calls
        // through the shared RPC fallback got throttled and the whole panel
        // stayed on "Reading Arc Mainnet…".
        const read = async (call: () => Promise<unknown>) => { try { return await call(); } catch { return call(); } };
        const values: unknown[] = [];
        for (const call of [
          () => factory.wiringOk(), () => factory.ENGINE_VERSION(), () => factory.POOL_FEE(), () => factory.GRADUATION_QUOTE(), () => factory.GRADUATION_FEE_BPS(),
          () => factory.treasury(), () => factory.poolManager(), () => factory.quote(),
          () => hook.factory(), () => hook.treasury(), () => hook.TRADE_FEE_BPS(), () => hook.CREATOR_FEE_BPS(),
        ]) values.push(await read(call));
        const [wired, engine, poolFee, gradQuote, gradFee, treasury, manager, quote, hookFactory, hookTreasury, tradeFee, creatorFee] = values as [boolean, bigint, bigint, bigint, bigint, string, string, string, string, string, bigint, bigint];
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        setChecks([
          { label: "Launch factory ↔ fee hook bound", value: `engine v${Number(engine)}`, ok: Boolean(wired) && same(hookFactory, ARC_MAINNET_CONTRACTS.launchFactoryV15) && Number(engine) === 15 },
          { label: "Pools open on Uniswap V4", value: short(manager), ok: same(manager, ARC_MAINNET_CONTRACTS.v4PoolManager) },
          { label: "Quoted in native USDC", value: short(quote), ok: same(quote, ARC_MAINNET_CONTRACTS.usdc) },
          { label: "Trading fee · creator share", value: `${Number(tradeFee) / 100}% · ${Number(creatorFee) / 100}%`, ok: Number(tradeFee) === 100 && Number(creatorFee) === 50 },
          { label: "Pool LP fee tier", value: `${Number(poolFee) / 10_000}%`, ok: Number(poolFee) === 0 },
          { label: "Graduation · fee", value: `${(Number(gradQuote) / 1e6).toLocaleString()} USDC · ${Number(gradFee) / 100}%`, ok: Number(gradQuote) === 12_000_000_000 && Number(gradFee) === 100 },
          { label: "Treasury agreement (factory + hook)", value: short(treasury), ok: [treasury, hookTreasury].every((value) => same(value, FEE_TREASURY)) },
        ]);
        setCheckedAt(new Date().toLocaleString());
      } catch { setChecks([]); }
      finally { provider.destroy(); }
    })();
  }, []);

  // Published-source status, straight from the explorer that holds it. A
  // checkmark here is the same fact an external buyer bot relies on when it
  // reads a pasted address's ABI, so it is read live rather than asserted.
  useEffect(() => {
    let alive = true;
    const addresses = [
      ...OFFICIAL_EXPLORER_VERIFIED,
      CCTP_MAINNET_FEE_ROUTER[ARC_MAINNET.id],
    ];
    // Through our own origin: the explorer's API sends no CORS header, so a
    // direct fetch from the browser is blocked and every badge stayed off.
    void fetch(`/api/verified.php?addresses=${addresses.join(",")}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("unavailable"))))
      .then((data: { contracts?: Record<string, { verified?: boolean }> }) => {
        if (!alive) return;
        setVerified(Object.fromEntries(Object.entries(data.contracts || {}).map(([address, row]) => [address, Boolean(row?.verified)])));
      })
      .catch(() => { /* badge is additive; absence of it is the safe default */ });
    return () => { alive = false; };
  }, []);

  // Arc Mainnet only. This page used to lead with three groups of Arc
  // Testnet addresses and put mainnet last, which is backwards for a page
  // whose whole point is letting someone verify the contracts their money
  // touches. Testnet addresses are still in the repo and in
  // developers/contracts.json for anyone developing against them; they do
  // not belong on a public trust page.
  const contractGroups: { title: string; note: string; cards: (readonly [string, string, string])[] }[] = [
    {
      title: "Launchpad",
      note: "Every coin created on Arcodian launches and trades through these. Only the current engine is listed; coins from earlier engines keep trading on-chain.",
      cards: [
        ["Launch Factory · V15", ARC_MAINNET_CONTRACTS.launchFactoryV15, "Every new coin launches here, straight into its own Uniswap V4 pool, so it is indexable and buyable by any router, scanner or buy bot from the block it is created. The whole 1B supply goes into the pool at a ~$5,000 launch valuation; the creator can buy in the same transaction. At 12,000 USDC raised the swap that crosses the line takes a one-time 1% graduation fee in USDC — 1% of the position, its USDC to the treasury and its tokens burned. That is the only removal the factory can ever make; the other 99% stays locked."],
        ["Launch Fee Hook · V15", ARC_MAINNET_CONTRACTS.launchHookV15, "Takes 1% of every swap through a V15 pool — always in USDC, on buys and sells, exact-input or exact-output — and splits it evenly between the coin's creator and the treasury, both pull-claimed. Only the factory can open a pool on it. Its address ends in 0x20CC because Uniswap V4 reads a hook's permissions from its own address."],
        ["V4 Router", ARC_MAINNET_CONTRACTS.v4Router, "What arcodian.fun trades launch pools through: one ordinary token approval, a slippage floor and a deadline on every swap, and quotes computed by running the real swap — so the quote already includes the 1% fee. Holds nothing between calls."],
        ["Fee treasury", FEE_TREASURY, "Receives the treasury half of the 1% trading fee and the 1% graduation fee, both in USDC."],
      ],
    },
    {
      title: "Swap & Arcodian DEX",
      note: "The routes the Swap and FX pages execute through: Arcodian's own Uniswap V3 deployment, its direct-pair AMM, the stablecoin FX pool, and a fee router over the external Uniswap V3 venue.",
      cards: [
        ["Swap Router", ARC_MAINNET_CONTRACTS.marketRouter, "Stateless multi-hop router over the pair factory below. Holds no funds between transactions."],
        ["Pair Factory", ARC_MAINNET_CONTRACTS.marketPairFactory, "Permissionless direct-pair AMM registry the Swap page reads on-chain."],
        ["Arcodian DEX · V3 Factory", ARC_MAINNET_CONTRACTS.v3Factory, "Arcodian's deployment of the official Uniswap v3-core 1.0.0."],
        ["Arcodian DEX · SwapRouter", ARC_MAINNET_CONTRACTS.v3SwapRouter, "Uniswap v3-periphery 1.3.0 SwapRouter over the factory above."],
        ["Arcodian DEX · Quoter", ARC_MAINNET_CONTRACTS.v3Quoter, "Read-only quotes for the factory above."],
        ["Arcodian DEX · Position Manager", ARC_MAINNET_CONTRACTS.v3PositionManager, "Liquidity positions for the factory above, issued as NFTs."],
        ["Swap Fee Router", ARC_MAINNET_CONTRACTS.externalV3FeeRouter, "Routes swaps through the external Uniswap V3 venue and takes the disclosed protocol fee in the same transaction."],
        ["Stablecoin FX pool · USDC/EURC", ARC_MAINNET_CONTRACTS.fxPool, "Arcodian's own USDC/EURC pool on Circle's mainnet EURC. Anyone can add liquidity and earn 0.08% of every swap it fills; 0.02% goes to the treasury. The FX desk quotes it alongside the Uniswap V3 pools and fills wherever the trader receives most."],
      ],
    },
    {
      title: "Arc Lend",
      note: "Isolated USDC lending against Circle's EURC. Suppliers earn the interest borrowers pay; 10% of it goes to the protocol reserve.",
      cards: [
        ["Arc Lend market · EURC / USDC", ARC_MAINNET_CONTRACTS.arcLendMarket, "Supply native USDC to earn, or post EURC and borrow USDC up to 70% LTV. Liquidation above 80% with a 5% bonus. Utilization-priced rates (1% base, +10% to an 80% kink, +200% above). Launched with 5,000 / 3,000 USDC supply / borrow caps; raising a cap waits 48 hours on-chain."],
        ["EUR/USD oracle", ARC_MAINNET_CONTRACTS.arcEurUsdOracle, "30-minute TWAP of the deepest Uniswap V3 USDC/EURC pool on Arc, cross-checked against Pyth when Pyth has a fresh report. If the two disagree by more than 1.5% it refuses to answer and the market keeps its last good price."],
      ],
    },
    {
      title: "Stocks",
      note: "Ten US stocks and ETFs at live market prices, traded against an LP-funded USDC pool. 0.30% per trade: 80% to LPs, 20% to the treasury.",
      cards: [
        ["ArcStockMarket", ARC_MAINNET_CONTRACTS.arcStockMarket, "Buys fill at the top of the signed price band, sells at the bottom. Prices older than 60 seconds or with a band wider than 1% are refused. 250 USDC open-interest cap per stock, and total open interest never above half the pool. LP deposits lock for 15 minutes."],
        ["ArcSignedPriceFeed · price oracle", ARC_MAINNET_CONTRACTS.arcStockPriceFeed, "Stores stock prices signed by Arcodian's price service (median of three independent market-data sources). Accepts only the authorized signer's signatures, bound to this chain and contract; the signer can be rotated by the admin."],
        ...STOCKS.map((s) => [`a${s.symbol} · ${s.name}`, STOCK_TOKENS[s.id], `Price-tracking token for ${s.name}, minted and burned only by ArcStockMarket.`] as [string, string, string]),
      ],
    },
    {
      title: "Bridge",
      note: "A 1.5% fee router over Circle's official CCTP v2 rails, deployed on all five chains. Each non-Arc address opens that chain's own explorer.",
      cards: [
        ["ArcBridgeRouter · Arc", CCTP_MAINNET_FEE_ROUTER[ARC_MAINNET.id], "Proven live with real transactions on every chain below, including third-party wallets bridging unaided."],
        ["ArcBridgeRouter · Ethereum", CCTP_MAINNET_FEE_ROUTER[1], "Same router contract, deployed on Ethereum mainnet."],
        ["ArcBridgeRouter · Optimism", CCTP_MAINNET_FEE_ROUTER[10], "Same router contract, deployed on Optimism mainnet."],
        ["ArcBridgeRouter · Arbitrum", CCTP_MAINNET_FEE_ROUTER[42161], "Same router contract, deployed on Arbitrum mainnet."],
        ["ArcBridgeRouter · Base", CCTP_MAINNET_FEE_ROUTER[8453], "Same router contract, deployed on Base mainnet — the first chain this router was proven on."],
      ],
    },
    {
      title: "Payments & agent economy",
      note: "Invoice settlement and agent identity. An agent is never granted spending authority by its identity alone.",
      cards: [
        ["Arc Pay", ARC_MAINNET_CONTRACTS.arcPay, "Exact-value invoice settlement. Each invoice settles once for its precise amount; a 0.30% fee is taken atomically and 99.70% reaches the merchant in the same transaction."],
        ["Agent Passport", ARC_MAINNET_CONTRACTS.agentPassport, "Binds an ERC-8004 Agent ID to an authorized wallet with owner-only rotation."],
        ["Agent Jobs", ARC_MAINNET_CONTRACTS.agentJobs, "Escrowed job lifecycle settled in USDC through Arc Pay."],
        ["Agent Pay Factory", ARC_MAINNET_CONTRACTS.agentPayFactory, "Mints one isolated, non-custodial vault per owner, with bounded spending policies, paying through Arc Pay above."],
      ],
    },
    {
      title: "Circle's own contracts",
      note: "Not Arcodian's. Published by Circle for Arc Mainnet and listed so the addresses this app reads can be checked against Circle's own documentation.",
      cards: [
        ["USDC (native)", ARC_MAINNET_CONTRACTS.usdc, "Arc's native gas token, exposed at a fixed address as an ERC-20 view. 18 decimals natively, 6 through this interface — the same balance, never two."],
        ["EURC", ARC_MAINNET_CONTRACTS.eurc, "Circle's Arc Mainnet EURC, published on 2026-09-16. A different contract from the testnet EURC, which has no code on this chain."],
        ["CCTP TokenMessenger v2", CCTP_MAINNET_TOKEN_MESSENGER_V2, "Burns USDC on the source chain. Identical address on every CCTP v2 chain."],
        ["CCTP MessageTransmitter v2", CCTP_MAINNET_MESSAGE_TRANSMITTER_V2, "Mints on the destination chain once Circle attests the burn."],
        ["Gateway Wallet", ARC_MAINNET_CONTRACTS.gatewayWallet, "Circle Gateway's chain-abstracted USDC balance contract."],
        ["StableFX Escrow", ARC_MAINNET_CONTRACTS.stableFxEscrow, "Circle's own permissioned RFQ FX settlement contract. Arcodian's FX desk is a separate, permissionless pool."],
      ],
    },
    {
      title: "Uniswap V4",
      note: "Not Arcodian's. The venue every launch trades on, listed so a pool id from this site can be checked against the contracts that hold it.",
      cards: [
        ["V4 Pool Manager", ARC_MAINNET_CONTRACTS.v4PoolManager, "Holds every V4 pool's tokens together and calls a pool's hook on each swap. Verified canonical before use — it answers extsload, protocolFeesAccrued and protocolFeeController. Not the address V4 uses on Ethereum, which has no code on Arc."],
        ["V4 Position Manager", ARC_MAINNET_CONTRACTS.v4PositionManager, "Uniswap's own manager for V4 liquidity positions, issued as NFTs. Launches do not use it: their liquidity is added directly through the PoolManager and owned by the factory, which has no way to remove it."],
      ],
    },
    {
      title: "Governance",
      note: "Administration is still deployer-held on mainnet. These are the mechanisms for moving it, not evidence that it has moved.",
      cards: [
        ["Session-Key Account", ARC_MAINNET_CONTRACTS.sessionKeyAccount, "Owner installs a scoped session key — target, function, per-call and daily caps, time window, instant revoke — and the account enforces every bound on-chain. Owner keeps custody."],
        ["Admin Timelock", ARC_MAINNET_CONTRACTS.adminTimelock, "Role-gated administration: schedule, enforced delay, execute, with cancel and a self-governed delay."],
      ],
    },
  ];
  // Arc addresses link to arcexplorer.org specifically: it is where this
  // project's source is published, so the link lands on a page that can show
  // the verified code rather than just a balance.
  const explorerFor = (_groupTitle: string, label: string): string => {
    if (label.includes("Ethereum")) return "https://etherscan.io";
    if (label.includes("Optimism")) return "https://optimistic.etherscan.io";
    if (label.includes("Arbitrum")) return "https://arbiscan.io";
    if (label.includes("Base")) return "https://basescan.org";
    return ARC_MAINNET.explorer;
  };
  return <section className="contracts-page">
    <TrustNav active="contracts" openHow={openHow} openFaq={openFaq} openCanary={openCanary} />
    <header><p className="kicker">Public onchain record</p><h1>Trust the wiring.<br/><em>Then verify it.</em></h1><p>Every contract below is deployed on Arc Mainnet, chain {ARC_MAINNET.id}, holding real value. Source is published on Circle's official explorer, <a href={ARC_MAINNET.explorer} target="_blank" rel="noreferrer">explorer.arc.io</a>, and on Sourcify — a <b>Verified</b> badge means anyone, including an external buyer bot, can read that contract's real ABI straight from the chain. Addresses open in the explorer, and the wiring checks below re-run on every page load, read from chain {ARC_MAINNET.id} itself. Testnet addresses are in <a href="/developers/contracts.json">the developer registry</a> rather than here. The <a href={ARCODIAN_MCP_ENDPOINT}>Arcodian MCP</a> reads these same contracts and returns unsigned transactions only — it never holds a key.</p></header>
    {contractGroups.map((group) => <div key={group.title} className="contract-group">
      <div className="contract-group-head"><h2>{group.title}</h2><p>{group.note}</p></div>
      <div className="contract-address-grid">{group.cards.map(([label,address,note])=><article key={label}><small>{label}{(verified[address.toLowerCase()] || OFFICIAL_EXPLORER_VERIFIED.has(address.toLowerCase())) && <a className="contract-verified" href={`${ARC_MAINNET.explorer}/address/${address}?tab=contract`} target="_blank" rel="noreferrer" title="Source published on explorer.arc.io">✓ Verified</a>}</small><a href={`${explorerFor(group.title,label)}/address/${address}`} target="_blank" rel="noreferrer">{address} ↗</a><p>{note}</p><button onClick={()=>void navigator.clipboard.writeText(address)}>Copy address</button></article>)}</div>
    </div>)}
    <section className="wiring-proof"><div><p className="kicker">Live wiring proof</p><h2>{checks.length && checks.every((item)=>item.ok) ? "Canonical stack verified" : checks.length ? "Review required" : "Reading Arc Mainnet…"}</h2><p>Read directly from chain {ARC_MAINNET.id}. No dashboard value can override these contract getters.</p>{checkedAt&&<small>Last checked {checkedAt}</small>}</div><div className="wiring-checks">{checks.map((item)=><span key={item.label} className={item.ok?"ok":"bad"}><i>{item.ok?"✓":"!"}</i><small>{item.label}</small><b>{item.value}</b></span>)}</div></section>
    <div className="contract-rules"><article><b>1%</b><small>Trading fee, in USDC</small><p>On every buy and sell, from any router. Half to the coin's creator, half to the treasury.</p></article><article><b>0%</b><small>Pool LP fee</small><p>The hook's 1% is the whole cost of a trade.</p></article><article><b>12,000</b><small>USDC graduation</small><p>The swap that crosses it takes a one-time 1% of the position: USDC to the treasury, tokens burned.</p></article><article><b>99%</b><small>Liquidity locked</small><p>The factory owns the position and has no other code path that touches it.</p></article></div>
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
  ["stocks", "Stocks"],
  ["bridge", "Bridge"],
  ["fx", "StableCoin FX"],
  ["agent", "Agent economy"],
  ["lifecycle", "Launchpad & lifecycle"],
  ["fees", "Fees & graduation"],
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
      <p>One non-custodial app for Arc's USDC economy. Hold and send USDC, get paid with a single exact-value invoice, put idle USDC to work in an isolated lending market, bridge across chains over Circle CCTP, convert USDC⇄EURC, and launch or trade coins in their own Uniswap V4 pools. The web app and the Android wallet only ever read contracts and ask your wallet to sign—they hold no keys and take no custody.</p>
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
        <div><small>Price source</small><strong>TWAP + Pyth</strong><p>EUR/USD is the 30-minute average of the deepest Uniswap V3 USDC/EURC pool on Arc, cross-checked against Pyth whenever Pyth has a fresh report; if they disagree by more than 1.5% the market keeps its last good price.</p></div>
        <div><small>Price freshness</small><strong>≤ 6h</strong><p>The market uses a synced price. A keeper re-syncs it as it ages or moves, and anyone can sync it; a price older than six hours fails closed for new borrows.</p></div>
      </div>
      <aside className="docs-notice"><strong>Live on Arc Mainnet, small caps</strong><p>Market {ARC_MAINNET_CONTRACTS.arcLendMarket}, launched with 5,000 USDC supply and 3,000 USDC borrow caps. The contracts are source-verified but not externally audited; the caps are sized for that.</p></aside>
    </article>

    <article id="docs-stocks" className="docs-section">
      <div className="docs-section-head"><span>04b</span><h2>Stocks</h2></div>
      <p><b>Stocks</b> lets you trade ten US stocks and ETFs (NVDA, AAPL, TSLA, SPY, QQQ, MSFT, AMZN, GOOGL, META, COIN) in USDC on Arc. Each trade carries the latest signed price for that stock; you receive a token (aNVDA, aAAPL, …) that the pool buys back at the market price when you sell.</p>
      <div className="economics-ledger">
        <div><small>Trade fee</small><strong>0.30%</strong><p>On every buy and sell. 80% stays in the pool for LPs, 20% goes to the Arcodian treasury.</p></div>
        <div><small>Fill price</small><strong>Median ± band</strong><p>Prices are the median of CNBC, Nasdaq and Yahoo quotes, signed only when at least two agree within 0.5%. Buys fill at the top of the band, sells at the bottom. Prices older than 60 seconds or with a band wider than 1% are refused.</p></div>
        <div><small>Liquidity</small><strong>Public LP pool</strong><p>Anyone can deposit USDC. LPs earn the fees and take the other side of traders: trader profits are paid from the pool, trader losses stay in it. Deposits lock for 15 minutes.</p></div>
        <div><small>Limits</small><strong>250 USDC / stock</strong><p>Open interest per stock is capped, and total open interest can never exceed half the pool. Trading follows US market hours (09:30–16:00 New York).</p></div>
      </div>
      <aside className="docs-notice"><strong>Price tracking, not ownership</strong><p>Tokens carry no ownership, votes or dividends and cannot be redeemed for stock. Market {ARC_MAINNET_CONTRACTS.arcStockMarket}, price oracle {ARC_MAINNET_CONTRACTS.arcStockPriceFeed}. Prices are signed by Arcodian&apos;s price service, so that signer is the trust point; per-stock caps bound the exposure. Source-verified, not externally audited.</p></aside>
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
      <p>The <b>StableCoin FX</b> desk converts USDC and EURC on Arc Mainnet at the best executable rate. Every order is quoted exactly — by simulating the real swap — against Arcodian&apos;s own pool and the Uniswap V3 USDC/EURC pools on Arc, and fills wherever you receive the most. Anyone can provide liquidity to Arcodian&apos;s pool and earn from every swap it fills.</p>
      <div className="economics-ledger">
        <div><small>Arcodian pool fee</small><strong>0.10%</strong><p>0.08% to liquidity providers, 0.02% to the treasury. Constant-product pool over Circle&apos;s USDC and EURC.</p></div>
        <div><small>Uniswap V3 route</small><strong>0.30% + tier</strong><p>Arcodian&apos;s 0.30% routing fee plus the pool&apos;s own tier, taken in the same transaction.</p></div>
        <div><small>Protection</small><strong>Min-out + deadline</strong><p>Re-quoted before you sign; every swap enforces a minimum output and an expiry.</p></div>
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
      <p>The launchpad is permissionless: anyone can create a coin, and it trades in its own Uniswap V4 pool from the block it is created — on arcodian.fun and through any external router, scanner or buy bot. There is no hidden mint, pause, or exit.</p>
      <div className="economics-flow">
        <div><i>01</i><small>Launch</small><h3>~$5,000 starting FDV</h3><p>The whole 1B supply goes into the pool at the launch price. The creator can buy in the same transaction, before anyone else can trade.</p></div>
        <div><i>02</i><small>While trading</small><h3>Open price discovery</h3><p>Buys add USDC to the pool and move the price up; sells do the reverse. Quotes run the real swap, so they already include the fee.</p></div>
        <div><i>03</i><small>Graduation</small><h3>12,000 USDC raised</h3><p>The swap that carries the pool past 12,000 USDC takes a one-time 1% of the position: its USDC to the treasury, its tokens burned. The price does not jump.</p></div>
        <div><i>04</i><small>Liquidity</small><h3>Locked for good</h3><p>The factory owns the position and has no code path that removes it, other than that single 1% at graduation. There is no LP token to sell or pull.</p></div>
      </div>
    </article>

    <article id="docs-fees" className="docs-section">
      <div className="docs-section-head"><span>09</span><h2>Fees & graduation</h2></div>
      <p>Every fee is taken by the contracts in the same transaction, in USDC.</p>
      <div className="economics-ledger">
        <div><small>Trading fee</small><strong>1.00%</strong><p>On every buy and sell, from any router — taken from the USDC going in on a buy and the USDC coming out on a sell.</p></div>
        <div><small>Creator share</small><strong>0.50%</strong><p>Half of the trading fee accrues to the coin's creator, claimable any time from the coin page.</p></div>
        <div><small>Pool LP fee</small><strong>0%</strong><p>The pool's own fee tier is zero, so the 1% above is the whole cost of a trade.</p></div>
        <div><small>Graduation fee</small><strong>1% once</strong><p>At 12,000 USDC raised, 1% of the position, paid in USDC to the treasury. Nothing is taken from the supply at launch.</p></div>
      </div>
    </article>


    <article id="docs-roadmap" className="docs-section">
      <div className="docs-section-head"><span>10</span><h2>Roadmap</h2></div>
      <p>Where Arcodian is heading, in order. Each phase ships as public contracts plus a wallet surface — Bridge and USDC-only Market are already live on Arc Mainnet with real value; the rest run on testnet.</p>
      <div className="economics-flow">
        <div><i>01</i><small>Live · testnet + mainnet</small><h3>Payments</h3><p>Arc Pay exact-value invoices are live on both Arc Testnet and Arc Mainnet. Next: recurring requests, payment links, and merchant webhooks.</p></div>
        <div><i>02</i><small>Live · mainnet</small><h3>Stablecoin FX</h3><p>USDC⇄EURC is live on Arc Mainnet, routed to the best executable rate across Arcodian&apos;s pool and Uniswap V3. Next: deeper Arcodian liquidity from public LPs and more Arc stablecoins.</p></div>
        <div><i>03</i><small>Planned</small><h3>E-commerce</h3><p>A checkout SDK and hosted pay pages so any store can accept exact USDC/EURC settlement with an order lifecycle.</p></div>
        <div><i>04</i><small>Planned</small><h3>Agentic economy</h3><p>Programmable, policy-scoped wallets so autonomous agents can pay, get paid, and settle on Arc under spending limits.</p></div>
      </div>
    </article>

    <article id="docs-safety" className="docs-section">
      <div className="docs-section-head"><span>11</span><h2>Safety & custody</h2></div>
      <p>Arcodian is non-custodial by construction. The interface talks only to wallets, official Arc endpoints (or, where no official Arc Mainnet endpoint yet exists, an independently-verified third-party one — see Mainnet readiness below), and allowlisted route APIs; it never stores or transmits a private key. Community posts and coin links are signed by the wallet and verified server-side, so nobody can impersonate a creator. Features without an explicit mainnet deployment and readiness sign-off stay Arc Testnet only.</p>
      <aside className="docs-notice"><strong>Mixed testnet/mainnet notice</strong><p>Bridge, the USDC-only Market/Launchpad, and the additive Agent Pay V6 factory are deployed on Arc Mainnet, chain 5042. V6 has no automatic vault creation and the production UI remains on the reviewed migration path. Always check the network your wallet shows before signing. The active agent-economy surfaces and V6 batch vault testing run on Arc Testnet chain 5042002, where test USDC and test EURC have no financial value. Contract addresses, pool reserves, activity, and LP-burn proof remain independently inspectable through each network's explorer.</p></aside>
    </article>

    <article id="docs-verify" className="docs-section">
      <div className="docs-section-head"><span>12</span><h2>Verify everything</h2></div>
      <p>Don't take the docs on faith. The Contracts page reads the live wiring straight from chain, the FAQ covers the edge cases, and Arc Explorer lets you inspect any address or transaction yourself.</p>
      <div className="docs-links">
        <button onClick={openContracts}><b>Contracts →</b><small>Live on-chain wiring proof</small></button>
        <a href="#docs-faq"><b>FAQ ↓</b><small>Plain answers to the edge cases</small></a>
        <a href={ARC_MAINNET.explorer} target="_blank" rel="noreferrer"><b>Arc Explorer ↗</b><small>Inspect any address or transaction</small></a>
      </div>
    </article>

    <article id="docs-readiness" className="docs-section readiness-section">
      <div className="docs-section-head"><span>13</span><h2>Mainnet readiness</h2></div>
      <p><b>Current decision: PARTIAL GO.</b> Bridge (Circle CCTP), the USDC-only Market/Launchpad, and Swap (Arcodian's own on-chain routing across the Mainnet launch/DEX stack and permissionless external pools) are deployed and live on Arc Mainnet with real USDC — verified with real on-chain transactions, not just a deployment script. StableCoin FX and Arc Lend are live on mainnet too. Everything else (EURC launches, the agent-economy stack) stays testnet-only until its own gates below clear — for the EURC surfaces the external blocker lifted on 2026-09-16 when Circle published the Arc Mainnet EURC address, leaving only the Arcodian-side mainnet deployments. Governance and audit gates for the mainnet contracts that do exist remain open.</p>
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
      <div className="docs-section-head"><span>14</span><h2>Frequently asked questions</h2></div>
      <div className="faq-list docs-faq-list">{FAQ_ITEMS.map(([question,answer],index)=><details key={question} open={index===0}><summary><span>{String(index+1).padStart(2,"0")}</span>{question}<i>+</i></summary><p>{answer}</p></details>)}</div>
    </article>

    <article id="docs-legal" className="docs-section">
      <div className="docs-section-head"><span>15</span><h2>Terms, risk & refunds</h2></div>
      <p>Bridge, the USDC-only Market/Launchpad, Swap, StableCoin FX and Arc Lend move real USDC and EURC on Arc Mainnet — treat every transaction there as final and irreversible with real financial consequences. Every other Arcodian surface (EURC launches, the agent-economy contracts) is a testnet interface where test assets have no financial value. Users remain responsible for reviewing the network, recipient, amount, allowance, price impact, health factor, and transaction before signing, on either network.</p>
      <div className="docs-cards">
        <div><b>Self-custody</b><p>Arcodian does not hold recovery phrases or sign on a user&apos;s behalf. Blockchain transactions are public and normally irreversible.</p></div>
        <div><b>Payments & refunds</b><p>Arc Pay refunds are new merchant-funded transactions returning the gross amount. The original protocol fee and network costs are not reversed.</p></div>
        <div><b>Audit status</b><p>No product, on either network, is represented as independently audited, insured, or guaranteed. Arc Mainnet Bridge and Market are live and proven with real transactions but have not had third-party audit sign-off — see Mainnet readiness. Availability may change while canary controls are tested.</p></div>
      </div>
      <div className="docs-links"><a href="/terms.html"><b>Full Terms ↗</b><small>Canonical legal text</small></a><a href="/refund-policy.html"><b>Refund Policy ↗</b><small>Eligibility and process</small></a><a href="mailto:support@arcodian.fun"><b>Support ↗</b><small>support@arcodian.fun</small></a></div>
    </article>
  </section>;
}
