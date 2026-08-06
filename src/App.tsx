import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import {
  BrowserProvider,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  ZeroHash,
  formatEther,
  parseUnits,
  zeroPadValue,
} from "ethers";
import {
  ARC,
  ARC_MAINNET,
  BRIDGE_FEE_BPS,
  CCTP_MAINNET_FEE_ROUTER,
  CHAINS,
  FEE_TREASURY,
  MAINNET_CHAINS,
  MAINNET_DEPLOY,
  SWAP_FEE_BPS,
  TOKENS,
  WALLETCONNECT_PROJECT_ID,
  V5_TESTNET_DEPLOY,
  navHref,
  subdomainTab,
} from "./config";
import { ARC_PUMP_SUITE_ABI } from "./generated/arcPumpSuite";
import { mainnetReadiness } from "./readiness";
import { isArcBridgeRoute } from "./bridgeRoute";
import { CIRCLE_BRIDGE_EXECUTION } from "./circleBridgeConfig";
import { CCTP_DOMAIN, burnConfirmed, burnHashFromResult, fetchCctpFee, savePendingClaim, tokenMessengerFor } from "./bridgeRecovery";
import { canonicalRedirect, isWalletAppRoute } from "./routeIntegrity";

// Every chain the bridge can move USDC between, testnet and real mainnet
// together. Looking a chain up must search both — a plain CHAINS.find(...)
// silently returns undefined for any mainnet chain id.
const ALL_BRIDGE_CHAINS = [...CHAINS, ...MAINNET_CHAINS];
const findBridgeChain = (id: number) => ALL_BRIDGE_CHAINS.find((chain) => chain.id === id);
const isMainnetBridgeChain = (id: number) => id === ARC_MAINNET.id || MAINNET_CHAINS.some((chain) => chain.id === id);

// Both signatures here previously (wrongly) declared a uint64 return value.
// Harmless for ethers when only ever used to send a transaction (it doesn't
// try to decode a return value off a mined tx) — but the real mainnet and
// testnet TokenMessengerV2.depositForBurn both return nothing (verified
// against their deployed, verified implementation ABIs), and ArcBridgeRouter
// itself made this exact mistake as a Solidity interface, which DOES revert
// at the EVM level on empty return data. Kept accurate here too.
const TOKEN_MESSENGER_ABI = [
  "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)",
];
const BRIDGE_FEE_ROUTER_ABI = [
  "function bridge(uint256 grossAmount,uint32 destinationDomain,bytes32 mintRecipient,uint256 maxFee,uint32 minFinalityThreshold)",
];
const CCTP_USDC_ABI = [
  "function approve(address,uint256) returns(bool)",
  "function allowance(address,address) view returns(uint256)",
];
import { BrandMark, FAQ_ITEMS, ensureWalletChain, rpcUrlsFor, short, type WalletOption } from "./shared";
import { describeTxError } from "./txError";

const Screener = lazy(() => import("./pages/Market"));
const FxDesk = lazy(() => import("./components/FxDesk"));
const SwapPanel = lazy(() => import("./components/SwapPanel"));
const PoolsPanel = lazy(() => import("./components/PoolsPanel"));
const CreatePairPanel = lazy(() => import("./components/CreatePairPanel"));
const PortfolioPanel = lazy(() => import("./components/PortfolioPanel"));
const LiquidityPanel = lazy(() => import("./components/LiquidityPanel"));
const Profile = lazy(() => import("./pages/Profile"));
const LandingExperience = lazy(() => import("./pages/Landing"));
const loadTrustCenter = () => import("./pages/TrustCenter");
const ContractsPage = lazy(() => loadTrustCenter().then((m) => ({ default: m.ContractsPage })));
const FaqPage = lazy(() => loadTrustCenter().then((m) => ({ default: m.FaqPage })));
const HowItWorks = lazy(() => loadTrustCenter().then((m) => ({ default: m.HowItWorks })));
const CanaryConsole = lazy(() => loadTrustCenter().then((m) => ({ default: m.CanaryConsole })));
const WalletPage = lazy(() => import("./pages/Wallet"));
const ProductLanding = lazy(() => import("./pages/ProductLanding"));
const ArcPayLanding = lazy(() => import("./pages/ArcPayLanding"));
const LendApp = lazy(() => import("./pages/LendApp"));
const Analytics = lazy(() => import("./pages/Analytics"));
const Treasury = lazy(() => import("./pages/Treasury"));
const AgentPay = lazy(() => import("./pages/AgentPay"));
const Jobs = lazy(() => import("./pages/Jobs"));
const JobDetail = lazy(() => import("./pages/JobDetail"));
const Developers = lazy(() => import("./pages/Developers"));
const BridgeClaim = lazy(() => import("./components/BridgeClaim"));
const BridgeStudio = lazy(() => import("./components/BridgeStudio"));
const AgentProfile = lazy(() => import("./pages/AgentProfile"));
const AgentsIndex = lazy(() => import("./pages/AgentsIndex"));
const TradingTerminal = lazy(() => import("./pages/TradingTerminal"));
const AUSD = lazy(() => import("./pages/AUSD"));

type Tab = "home" | "wallet" | "arcpay" | "agentpay" | "jobs" | "analytics" | "treasury" | "developers" | "screener" | "bridge" | "swap" | "terminal" | "fx" | "ausd" | "profile" | "how" | "faq" | "contracts" | "canary";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  11155111: "Ethereum Sepolia",
  42161: "Arbitrum",
  421614: "Arbitrum Sepolia",
  8453: "Base",
  84532: "Base Sepolia",
  43113: "Avalanche Fuji",
  10: "Optimism",
  11155420: "OP Sepolia",
  80002: "Polygon Amoy",
  [ARC.id]: ARC.name,
  [ARC_MAINNET.id]: ARC_MAINNET.name,
};

function circleBridgeFailure(result: { steps?: Array<{ name?: string; state?: string; errorMessage?: string; error?: unknown }> }) {
  const failed = result.steps?.find((step) => step.state === "error");
  const burn = result.steps?.find((step) => step.name?.toLowerCase().includes("burn") && step.state === "success");
  const nested = failed?.error && typeof failed.error === "object" && "message" in failed.error ? String((failed.error as { message?: unknown }).message || "") : "";
  const detail = failed?.errorMessage || nested || "Circle could not complete this route.";
  const stage = failed?.name ? `${failed.name}: ` : "";
  if (burn) return `Source burn confirmed. ${stage}${friendlySdkError(detail)} Do not bridge again; fund destination gas if required, then retry only the pending mint step.`;
  return `${stage}${friendlySdkError(detail)}`;
}
function friendlySdkError(value: unknown) {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const clean = raw.replace(/\[object Object\]/g, "Circle route detail").replace(/0x[a-fA-F0-9]{130,}/g, "onchain data").replace(/\s+/g, " ").trim();
  if (!clean) return "Circle could not complete this request.";
  if (/user rejected|denied|cancelled/i.test(clean)) return "Wallet request was cancelled. No new transaction was submitted.";
  if (/insufficient funds|insufficient.*gas/i.test(clean)) return "The active network does not have enough gas token to finish this step.";
  if (/wallet context|address:\s*required/i.test(clean)) return "Reconnect the original bridge wallet, then try completing the bridge again.";
  if (/timeout|timed out|polling/i.test(clean)) return "Circle confirmation is taking longer than expected.";
  return clean.length > 220 ? `${clean.slice(0, 217)}…` : clean;
}
function sdkTokenLabel(value: unknown, fallback: string) {
  if (typeof value === "string" && value && value !== "[object Object]") return value;
  if (value && typeof value === "object") {
    const token = value as { symbol?: unknown; name?: unknown };
    if (typeof token.symbol === "string") return token.symbol;
    if (typeof token.name === "string") return token.name;
  }
  return fallback;
}

type BridgeEstimateView = {
  amount: string;
  source: string;
  destination: string;
  fees: Array<{ type: string; token: string; amount: string | null }>;
  gasFees: Array<{ name: string; token: string; amount: string | null }>;
  destinationGas: { ready: boolean; symbol: string; balance: string };
};
type CircleSwapEstimateView = {
  output: string;
  outputToken: string;
  minimum: string;
  fees: Array<{ type: string; token: string; amount: string | null }>;
};

const ROUTE_TABS = ["wallet", "arcpay", "agentpay", "jobs", "analytics", "treasury", "developers", "screener", "bridge", "swap", "terminal", "fx", "ausd", "profile", "how", "faq", "contracts"] as const;
function initialTab(): Tab {
  if (typeof window === "undefined") return "bridge";
  const segment = window.location.pathname.split("/").filter(Boolean)[0];
  // A dedicated subdomain (market/swap/bridge/docs) picks the default view unless
  // the path already points somewhere specific on that host.
  const hostTab = subdomainTab(window.location.hostname) as Tab | null;
  if (hostTab && !segment) return hostTab;
  if (!segment) return hostTab || "home";
  if (segment === "tools" || segment === "resources") {
    window.history.replaceState({}, "", "/");
    return "screener";
  }
  if (segment === "market" || segment === "explore" || segment === "launch" || segment === "launchpad" || segment === "coin")
    return "screener";
  if (segment === "docs") return "how";
  if (segment === "faq") {
    window.history.replaceState({}, "", "/docs#docs-faq");
    return "how";
  }
  // Canary is an internal release-testing console, not a public docs page.
  if (segment === "canary") {
    window.history.replaceState({}, "", "/docs");
    return "how";
  }
  if (segment === "profil") return "profile";
  return (ROUTE_TABS as readonly string[]).includes(segment)
    ? (segment as Tab)
    : hostTab || "screener";
}

export default function App() {
  const readiness = mainnetReadiness(MAINNET_DEPLOY);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [account, setAccount] = useState("");
  // Bridge defaults to real mainnet now that Arc Mainnet is live — testnet
  // stays fully working in the code (Wallet/Lend/Market still run on it) but
  // is no longer the default or an offered option on the public Bridge page.
  const [fromChain, setFromChain] = useState<number>(1); // Ethereum
  const [toChain, setToChain] = useState<number>(ARC_MAINNET.id);
  const [fromToken, setFromToken] = useState<string>(TOKENS[0].address);
  const [toToken, setToToken] = useState<string>(TOKENS[1].address);
  const [amount, setAmount] = useState("100");
  const [bridgeEstimate, setBridgeEstimate] = useState<BridgeEstimateView | null>(null);
  const [bridgeRetryResult, setBridgeRetryResult] = useState<unknown>(null);
  const [bridgeRecoveryHash, setBridgeRecoveryHash] = useState("");
  const [bridgeStats, setBridgeStats] = useState<{ outOfArc: { grossUsd: number; txCount: number }; intoArc: { grossUsd: number; txCount: number }; totalFeeUsd: number; totalTxCount: number; indexedAt: string } | null>(null);
  useEffect(() => {
    // Server-side snapshot (arcodian-bridge-stats.timer, every 5 min) —
    // the browser never queries all 5 chains' RPCs directly for this, since
    // Arc's own RPC rate-limits under concurrent load (hit 429s repeatedly
    // during manual load-testing 2026-07-31).
    let cancelled = false;
    const load = () => fetch("/data/bridge-stats.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((data) => { if (!cancelled && data) setBridgeStats(data); }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const [mainnetRpcDown, setMainnetRpcDown] = useState(false);
  useEffect(() => {
    // arc-rpc.stakeme.pro (the only Arc Mainnet RPC we have — no official
    // Circle endpoint is public yet) has gone down before with no warning
    // (2026-07-31 CORS misconfig, 2026-08-01 the upstream Alchemy app had
    // its ARC_MAINNET network disabled entirely, 403 on every call). This
    // is a real, live-changing upstream condition — poll for it instead of
    // hardcoding a banner someone has to remember to remove once it recovers.
    let cancelled = false;
    const check = () => fetch("/api/rpc-mainnet.php", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    })
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setMainnetRpcDown(Boolean(data?.error)); })
      .catch(() => { if (!cancelled) setMainnetRpcDown(true); });
    check();
    const timer = window.setInterval(check, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [walletOpen, setWalletOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(() => localStorage.getItem("arcodian-risk-ack-v1") === "accepted");
  const [mainnetDeployBusy, setMainnetDeployBusy] = useState(false);
  const [mainnetDeployStatus, setMainnetDeployStatus] = useState("");
  const [v5DeployBusy, setV5DeployBusy] = useState(false);
  const [v5DeployStatus, setV5DeployStatus] = useState(() => localStorage.getItem("arcodian-v5-deploy-tx") ? `Deployment already submitted: ${localStorage.getItem("arcodian-v5-deploy-tx")}` : "");
  const [activeProvider, setActiveProvider] = useState<EthereumProvider | null>(
    null,
  );
  const [chainId, setChainId] = useState<number | null>(null);
  const [coinAddress, setCoinAddress] = useState(() =>
    window.location.pathname.split("/").filter(Boolean)[0] === "coin"
      ? window.location.pathname.split("/").filter(Boolean)[1] || ""
      : "",
  );
  const [profileAddress, setProfileAddress] = useState(() => {
    const parts = window.location.pathname.split("/").filter(Boolean);
    return parts[0] === "profile" || parts[0] === "profil"
      ? parts[1] || ""
      : "";
  });

  useEffect(() => {
    if (!account) { setBridgeRetryResult(null); return; }
    try { setBridgeRetryResult(JSON.parse(localStorage.getItem(`arcodian-bridge-recovery:${account.toLowerCase()}`) || "null")); }
    catch { setBridgeRetryResult(null); }
  }, [account]);

  useEffect(() => {
    // The nav-group dropdowns are plain <details>/<summary> — native, but
    // native means they only close by clicking their own summary again.
    // There's no click-outside-to-close and no auto-close after picking an
    // item, so a dropdown stayed stuck open until you clicked it a second
    // time. Close every open one on any click that lands outside it, and
    // close the specific one a fraction of a second after picking an item
    // inside it (letting the item's own onClick/navigation fire first).
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const group = target.closest<HTMLDetailsElement>(".nav-group");
      if (!group) {
        document.querySelectorAll<HTMLDetailsElement>(".nav-group[open]").forEach((el) => { el.open = false; });
        return;
      }
      if (target.closest("button, a") && !target.closest("summary")) {
        window.setTimeout(() => { group.open = false; }, 120);
      }
    };
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, []);

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (!ref || !/^0x[a-fA-F0-9]{40}$/.test(ref)) return;
    void fetch("/api/referral.php", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref }), keepalive: true }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const syncRoute = () => {
      const parts = window.location.pathname.split("/").filter(Boolean);
      setCoinAddress(parts[0] === "coin" ? parts[1] || "" : "");
      setProfileAddress(
        parts[0] === "profile" || parts[0] === "profil" ? parts[1] || "" : "",
      );
      setTab(initialTab());
    };
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    const discovered = new Map<string, WalletOption>();
    const publish = () => setWallets(Array.from(discovered.values()));
    const announce = (event: Event) => {
      const detail = (event as CustomEvent<EIP6963ProviderDetail>).detail;
      if (!detail?.provider || !detail.info) return;
      discovered.set(detail.info.uuid || detail.info.rdns, detail);
      publish();
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // window.ethereum isn't always present the instant this effect runs —
    // mobile in-app wallet browsers (OKX's included) often inject it a beat
    // after the page's own scripts start, especially the first load after a
    // cold app launch. A single synchronous check here missed that window
    // entirely: the wallet was really there, it just hadn't attached yet, so
    // it silently never appeared in "Choose your wallet" (reported 2026-07-31
    // as OKX not showing up at all). Now retries for a few seconds and also
    // listens for the de-facto `ethereum#initialized` event wallets dispatch
    // once they've attached.
    const registerLegacy = () => {
      if (!window.ethereum) return false;
      const provider = window.ethereum;
      const name =
        provider.isOkxWallet || provider.isOKExWallet
          ? "OKX Wallet"
          : provider.isBitKeep || provider.isBitgetWallet
            ? "Bitget Wallet"
            : provider.isRabby
              ? "Rabby"
              : provider.isCoinbaseWallet
                ? "Coinbase Wallet"
                : provider.isZerion
                  ? "Zerion"
                  : provider.isMetaMask
                    ? "MetaMask"
                    : "Browser Wallet";
      discovered.set("legacy", {
        info: { uuid: "legacy", name, icon: "", rdns: "injected" },
        provider,
      });
      publish();
      return true;
    };
    if (!registerLegacy()) {
      window.addEventListener("ethereum#initialized", registerLegacy, { once: true });
      // Was 10 attempts * 300ms = 3s total — too short in practice (reported
      // 2026-08-03: OKX still missing from the wallet picker). Injection
      // delay varies a lot by device/cold-start/network, especially inside
      // a wallet's own mobile in-app browser, so this needs real headroom
      // rather than a tight budget — 20 * 400ms = 8s.
      let attempts = 0;
      const poll = window.setInterval(() => {
        attempts += 1;
        if (registerLegacy() || attempts >= 20) window.clearInterval(poll);
      }, 400);
      return () => {
        window.removeEventListener("eip6963:announceProvider", announce);
        window.removeEventListener("ethereum#initialized", registerLegacy);
        window.clearInterval(poll);
      };
    }
    return () =>
      window.removeEventListener("eip6963:announceProvider", announce);
  }, []);

  useEffect(() => {
    if (!activeProvider) return;
    const updateChain = (value: unknown) =>
      setChainId(
        typeof value === "string" ? Number.parseInt(value, 16) : Number(value),
      );
    const updateAccounts = (value: unknown) =>
      setAccount(Array.isArray(value) ? String(value[0] || "") : "");
    const checkChain = () =>
      activeProvider
        .request({ method: "eth_chainId" })
        .then(updateChain)
        .catch(() => setChainId(null));
    checkChain();
    activeProvider.on?.("chainChanged", updateChain);
    activeProvider.on?.("accountsChanged", updateAccounts);
    // A one-time check on connect isn't enough: if the wallet's eth_chainId
    // read failed or timed out right when it happened (e.g. it still had a
    // broken RPC saved for this chain — see rpcUrlsFor in shared.tsx), that
    // failure never gets retried. Editing a wallet's RPC for a chain it
    // already has doesn't change the chain ID itself, so wallets don't fire
    // chainChanged for it — a user fixing their RPC mid-session had no way
    // to recover without a full disconnect/reconnect (reported 2026-08-03:
    // balance stayed unreadable on /terminal even after fixing the RPC).
    // Poll as a safety net so state self-heals.
    const poll = window.setInterval(checkChain, 8_000);
    return () => {
      activeProvider.removeListener?.("chainChanged", updateChain);
      activeProvider.removeListener?.("accountsChanged", updateAccounts);
      window.clearInterval(poll);
    };
  }, [activeProvider]);

  const isSwap = tab === "swap";
  const [dexView, setDexView] = useState<"swap" | "pools" | "create" | "portfolio">("swap");
  // Set when the portfolio hands a pool over to the Pools tab, so "Manage"
  // lands on that pool instead of an empty address box.
  const [focusPair, setFocusPair] = useState("");
  const host = typeof window !== "undefined" ? window.location.hostname : "";
  const selectedFrom = TOKENS.find((t) => t.address === fromToken) || TOKENS[0];
  const selectedTo = TOKENS.find((t) => t.address === toToken) || TOKENS[1];
  const bridgeFrom = findBridgeChain(fromChain) || CHAINS[0];
  const bridgeTo = findBridgeChain(toChain) || CHAINS[3];
  // Which Arc network the bridge is currently pointed at — real mainnet if
  // either side is Arc Mainnet, otherwise testnet (the default). Peers are
  // scoped to the same environment so a route never mixes a mainnet chain
  // with Arc Testnet or vice versa (testnet and mainnet CCTP are separate
  // Circle deployments; mixing them would burn real funds toward a domain
  // number that resolves to the wrong environment on the destination side).
  const arcNetworkMode: "testnet" | "mainnet" = fromChain === ARC_MAINNET.id || toChain === ARC_MAINNET.id ? "mainnet" : "testnet";
  const activeArcId = arcNetworkMode === "mainnet" ? ARC_MAINNET.id : ARC.id;
  const bridgePeers = (arcNetworkMode === "mainnet" ? MAINNET_CHAINS : CHAINS).filter((chain) => chain.id !== activeArcId);
  const bridgeFromArc = fromChain === activeArcId;
  const canQuote = Boolean(account && Number(amount) > 0 && (!isSwap || fromToken.toLowerCase() !== toToken.toLowerCase()));

  async function connect(option?: WalletOption) {
    if (!option) {
      setWalletOpen(true);
      return;
    }
    try {
      const accounts = (await option.provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      setActiveProvider(option.provider);
      setAccount(accounts[0] || "");
      setWalletOpen(false);
      setStatus("");
      // Prompt the network switch/add right at connect time, not only the
      // first time a user happens to attempt a swap — but only on the
      // surfaces that actually run on Arc Mainnet. Lend and the
      // agent-economy tools are deliberately Arc Testnet only (see the
      // acknowledgment gate copy); forcing a mainnet switch prompt there
      // would be actively wrong, not just unnecessary. A wallet that's
      // never seen Arc Mainnet before gets the native "Add this network?"
      // popup immediately (with our correct RPC — see rpcUrlsFor), so it's
      // never left silently on the wrong chain wondering why nothing loads.
      const mainnetTabs: Tab[] = ["swap", "terminal", "screener", "bridge"];
      if (mainnetTabs.includes(tab)) {
        try {
          await ensureWalletChain(option.provider, ARC_MAINNET);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Wallet network setup failed.");
        }
      }
    } catch (error) {
      setStatus(describeTxError(error));
    }
  }

  async function disconnect() {
    try {
      await activeProvider?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      /* Wallet may not implement revocation. */
    }
    setAccount("");
    setActiveProvider(null);
    setChainId(null);
    setStatus("");
    if (tab === "profile") chooseTab("screener");
  }
  async function connectWalletConnect() {
    if (!WALLETCONNECT_PROJECT_ID) return;
    setStatus("Opening WalletConnect…");
    try {
      const { default: EthereumProvider } = await import("@walletconnect/ethereum-provider");
      const provider = await EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        chains: [ARC.id],
        optionalChains: CHAINS.map((chain) => chain.id),
        showQrModal: true,
        metadata: { name: "Arcodian", description: "Onchain markets in orbit", url: window.location.origin, icons: [`${window.location.origin}/arcodian-mark.svg`] },
      });
      await provider.connect();
      const accounts = provider.accounts || [];
      setActiveProvider(provider as never);
      setAccount(accounts[0] || "");
      setWalletOpen(false);
      setStatus("");
    } catch (error) { setStatus(describeTxError(error)); }
  }

  async function deployMainnetSuite() {
    if (!MAINNET_DEPLOY.enabled || !activeProvider || !account) return;
    if (!readiness.ready) {
      setMainnetDeployStatus("Mainnet deployment is locked until every readiness check is verified.");
      return;
    }
    if (
      !MAINNET_DEPLOY.chainId ||
      !/^0x[a-fA-F0-9]{40}$/.test(MAINNET_DEPLOY.treasury) ||
      account.toLowerCase() !== MAINNET_DEPLOY.deployer
    ) {
      setMainnetDeployStatus("Mainnet deployment configuration is incomplete or this wallet is not authorized.");
      return;
    }
    setMainnetDeployBusy(true);
    setMainnetDeployStatus("Checking network and deployment parameters…");
    try {
      const provider = new BrowserProvider(activeProvider as never);
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== MAINNET_DEPLOY.chainId)
        throw new Error(`Switch wallet to approved mainnet chain ${MAINNET_DEPLOY.chainId}.`);
      const signer = await provider.getSigner();
      if ((await signer.getAddress()).toLowerCase() !== MAINNET_DEPLOY.deployer)
        throw new Error("Only the approved deployer wallet can deploy the mainnet suite.");
      const confirmed = window.confirm(
        `FINAL MAINNET DEPLOYMENT\n\nChain: ${MAINNET_DEPLOY.chainId}\nTreasury: ${MAINNET_DEPLOY.treasury}\nThreshold: ${MAINNET_DEPLOY.threshold}\n\nThis creates a new immutable Arcodian Launch + DEX stack. Continue?`,
      );
      if (!confirmed) throw new Error("Mainnet deployment cancelled.");
      const { ARC_PUMP_SUITE_BYTECODE } = await import("./generated/arcPumpSuiteBytecode");
      const deployment = await new ContractFactory(
        ARC_PUMP_SUITE_ABI,
        ARC_PUMP_SUITE_BYTECODE,
        signer,
      ).deploy(parseUnits(MAINNET_DEPLOY.threshold, 18), MAINNET_DEPLOY.treasury);
      setMainnetDeployStatus(`Submitted: ${deployment.deploymentTransaction()?.hash || "waiting"}`);
      await deployment.waitForDeployment();
      const suiteAddress = await deployment.getAddress();
      const suite = new Contract(suiteAddress, ARC_PUMP_SUITE_ABI, provider);
      setMainnetDeployStatus(
        `Suite ${suiteAddress} · Launch Factory ${await suite.pumpFactory()} · DEX ${await suite.dexFactory()}`,
      );
    } catch (error) {
      setMainnetDeployStatus(error instanceof Error ? error.message : "Mainnet deployment failed");
    } finally {
      setMainnetDeployBusy(false);
    }
  }
  async function deployV5TestnetSuite() {
    if (!V5_TESTNET_DEPLOY.enabled || !activeProvider || account.toLowerCase() !== V5_TESTNET_DEPLOY.deployer) return;
    if (localStorage.getItem("arcodian-v5-deploy-tx")) { setV5DeployStatus("A v5 deployment was already submitted from this browser. Verify it before any retry."); return; }
    if (!window.confirm("DEPLOY ARCODIAN V5 TESTNET\n\nStart FDV: 1,000 USDC\nNet graduation: 4,500 USDC\nGraduation FDV: ~30,250 USDC\nLP: ~18.18%, permanently burned\n\nContinue with this one-time deployment?")) return;
    setV5DeployBusy(true); setV5DeployStatus("Switching to Arc Testnet…");
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] });
      const provider = new BrowserProvider(activeProvider as never);
      const signer = await provider.getSigner();
      if ((await signer.getAddress()).toLowerCase() !== V5_TESTNET_DEPLOY.deployer) throw new Error("Only the approved deployer wallet can deploy v5.");
      const { ARC_PUMP_SUITE_BYTECODE } = await import("./generated/arcPumpSuiteBytecode");
      const deployment = await new ContractFactory(ARC_PUMP_SUITE_ABI, ARC_PUMP_SUITE_BYTECODE, signer).deploy(parseUnits(V5_TESTNET_DEPLOY.threshold, 18), V5_TESTNET_DEPLOY.treasury);
      const txHash = deployment.deploymentTransaction()?.hash || "";
      if (txHash) localStorage.setItem("arcodian-v5-deploy-tx", txHash);
      setV5DeployStatus(`Submitted ${txHash}. Waiting for confirmation…`);
      await deployment.waitForDeployment();
      const suiteAddress = await deployment.getAddress();
      const suite = new Contract(suiteAddress, ARC_PUMP_SUITE_ABI, provider);
      setV5DeployStatus(`V5 ready · Suite ${suiteAddress} · Launch Factory ${await suite.pumpFactory()} · DEX ${await suite.dexFactory()}`);
    } catch (error) { setV5DeployStatus(error instanceof Error ? error.message : "V5 deployment failed"); }
    finally { setV5DeployBusy(false); }
  }

  async function requestQuote() {
    if (!canQuote) return;
    await estimateCircleBridge();
  }

  async function circleBridgeContext() {
    if (!activeProvider || fromChain === toChain) throw new Error(fromChain === toChain ? "Choose two different networks." : "Connect a wallet first.");
    // Circle's App Kit SDK does not list Arc Mainnet as a supported bridge
    // chain yet (its BridgeChainIdentifier type has no "Arc" entry, only
    // "Arc_Testnet") — this whole estimate path is testnet-only. The direct
    // manual burn in bridgeWithCircle doesn't use this SDK and works on both.
    if (arcNetworkMode === "mainnet") throw new Error("Estimate isn't available yet for Arc Mainnet — Circle's SDK doesn't list it as a known chain. Use Bridge directly instead; it doesn't depend on this estimate.");
    const [{ AppKit }, { createViemAdapterFromProvider }] = await Promise.all(
      [import("@circle-fin/app-kit"), import("@circle-fin/adapter-viem-v2")],
    );
    const adapter = await createViemAdapterFromProvider({ provider: activeProvider as never });
    const from = CHAINS.find((chain) => chain.id === fromChain);
    const to = CHAINS.find((chain) => chain.id === toChain);
    if (!from || !to) throw new Error("Unsupported Circle bridge network");
    if (!isArcBridgeRoute(from.id, to.id, ARC.id)) throw new Error("Every Arcodian bridge route must start or end on Arc Testnet.");
    // NO customFee: routing the burn through the SDK fee-collector contract
    // (approve → splitter → CCTP) was reverting after the approval, so the burn
    // failed and nothing could be claimed. A plain CCTP burn approves the Circle
    // TokenMessenger directly and always completes. (Protocol fees can be taken
    // on other rails instead of inside the bridge burn.)
    return {
      kit: new AppKit(), adapter, from, to,
      params: {
        from: { adapter, chain: from.appKit },
        to: { adapter, chain: to.appKit },
        amount,
        config: { ...CIRCLE_BRIDGE_EXECUTION },
      },
    };
  }

  async function estimateCircleBridge() {
    setBusy(true); setStatus("Estimating Circle CCTP route without sending a transaction…");
    setBridgeEstimate(null); setBridgeRetryResult(null);
    try {
      const { kit, params, from, to } = await circleBridgeContext();
      const estimate = await kit.estimateBridge(params);
      const destinationProvider = new JsonRpcProvider(to.rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
      let destinationBalance = 0n;
      try { destinationBalance = await destinationProvider.getBalance(account); }
      finally { destinationProvider.destroy(); }
      setBridgeEstimate({
        amount: estimate.amount,
        source: from.name,
        destination: to.name,
        fees: estimate.fees.map((fee) => ({ type: fee.type, token: fee.token, amount: fee.amount })),
        gasFees: estimate.gasFees.map((fee) => ({ name: fee.name, token: fee.token, amount: fee.fees?.fee || null })),
        destinationGas: { ready: destinationBalance > 0n, symbol: to.gasSymbol, balance: formatEther(destinationBalance) },
      });
      setStatus(destinationBalance > 0n ? "Estimate ready. Destination gas check passed." : `Add a small amount of ${to.gasSymbol} on ${to.name} before bridging; the mint step needs destination gas.`);
    } catch (error) { setStatus(friendlySdkError(error)); }
    finally { setBusy(false); }
  }

  // Direct CCTP v2 burn — no SDK, no fee-collector. Switches the wallet to the
  // source chain, approves the Circle TokenMessenger, and burns (Fast Transfer
  // with a Standard fallback so it never reverts on a fee/amount edge). The claim
  // panel below then auto-switches to the destination and mints once attested.
  async function bridgeWithCircle() {
    if (!activeProvider) { setStatus("Connect a wallet first."); return; }
    if (fromChain === toChain) { setStatus("Choose two different networks."); return; }
    const from = findBridgeChain(fromChain);
    const to = findBridgeChain(toChain);
    if (!from || !to) { setStatus("Unsupported bridge network."); return; }
    if (CCTP_DOMAIN[from.id] === undefined || CCTP_DOMAIN[to.id] === undefined) {
      setStatus("This route is not supported by Circle CCTP."); return;
    }
    const tokenMessenger = tokenMessengerFor(from.id);
    const feeRouter = CCTP_MAINNET_FEE_ROUTER[from.id];
    if (isMainnetBridgeChain(from.id) && !feeRouter) {
      setStatus(`${from.name} is temporarily unavailable while its 1.5% fee router is being deployed.`);
      return;
    }
    const spender = feeRouter || tokenMessenger;
    const value = parseUnits(amount || "0", 6); // CCTP USDC is 6-decimal
    if (value <= 0n) { setStatus("Enter an amount to bridge."); return; }
    // Circle's own TokenMinter.burnLimitsPerMessage for USDC out of Arc is
    // capped at 1,000,000 (1 USDC) right now — confirmed live on-chain
    // 2026-07-31, not something we control. Burns above that revert with
    // "Burn amount exceeds per tx limit" deep in TokenMessenger, which reads
    // as a broken app rather than a network-side rollout limit. Cap here so
    // the message is clear instead of a raw revert; remove once Circle
    // raises the limit for Arc.
    if (from.id === ARC_MAINNET.id && value > 1_000_000n) {
      setStatus("Arc Mainnet's CCTP burn limit is capped at 1 USDC per transaction right now (Circle's own network-side limit, not ours) — bridge in 1 USDC steps until Circle raises it.");
      return;
    }

    setBusy(true);
    setStatus(`Switching to ${from.name}…`);
    try {
      const sourceHex = `0x${fromChain.toString(16)}`;
      if (from.id === ARC.id || from.id === ARC_MAINNET.id) {
        // Arc is a custom network in wallets such as OKX. A plain switch can
        // succeed while leaving the wallet on a stale saved RPC, causing the
        // following approval preflight to fail with a misleading Bech32
        // "Invalid prefix" error. Reuse the canonical switch + RPC probe used
        // by Market so outbound bridge actions refresh and verify Arc first.
        await ensureWalletChain(activeProvider, from.id === ARC_MAINNET.id ? ARC_MAINNET : ARC);
      } else {
        try {
          await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: sourceHex }] });
        } catch (switchError) {
          const code = (switchError as { code?: number })?.code;
          if (code === 4902 && MAINNET_CHAINS.some((c) => c.id === from.id)) {
            await activeProvider.request({ method: "wallet_addEthereumChain", params: [{ chainId: sourceHex, chainName: from.name, nativeCurrency: { name: from.gasSymbol, symbol: from.gasSymbol, decimals: 18 }, rpcUrls: rpcUrlsFor(from) }] });
            await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: sourceHex }] });
          } else if (code === 4001) { setStatus("Network switch was rejected. Approve it to continue."); setBusy(false); return; }
          else if (code === 4902) { setStatus(`Add ${from.name} to your wallet, then try again.`); setBusy(false); return; }
          else throw switchError;
        }
      }
      // wallet_switchEthereumChain can resolve before the wallet's own
      // provider has actually finished rotating — building a signer right
      // after and sending it straight to depositForBurn then sends a
      // chain-8453-shaped (or whichever) transaction to a node still on the
      // old network, which several public RPCs reject outright as a
      // malformed/"Bad Request" call rather than a normal revert. Poll
      // eth_chainId until the wallet actually confirms the new network
      // before touching any contract.
      let confirmedChainId = "";
      for (let i = 0; i < 10; i++) {
        confirmedChainId = String(await activeProvider.request({ method: "eth_chainId" }));
        if (confirmedChainId.toLowerCase() === sourceHex.toLowerCase()) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (confirmedChainId.toLowerCase() !== sourceHex.toLowerCase()) {
        setStatus(`Your wallet is still on a different network than ${from.name}. Switch to ${from.name} in your wallet, then try again.`);
        setBusy(false);
        return;
      }
      let signer = await new BrowserProvider(activeProvider as never).getSigner();
      const owner = await signer.getAddress();

      let usdc = new Contract(from.token, CCTP_USDC_ABI, signer);
      // Do not route read-only bridge preflights through an injected wallet.
      // OKX mobile can expose the correct chain ID while its internal custom-
      // network transport still rejects eth_call before it ever opens a
      // signing popup (reported as missing revert data / invalid prefix).
      // Arcodian's RPC is already health-checked independently, so use it for
      // allowance reads and reserve the wallet provider strictly for signing.
      // This also makes mobile and desktop follow the same deterministic read
      // path instead of depending on wallet-specific RPC implementations.
      const bridgeReadProvider = new JsonRpcProvider(from.rpc, from.id, { staticNetwork: true });
      const readUsdc = new Contract(from.token, CCTP_USDC_ABI, bridgeReadProvider);
      let allowance: bigint = await readUsdc.allowance(owner, spender);
      if (allowance < value) {
        for (let attempt = 0; attempt < 2 && allowance < value; attempt += 1) {
          setStatus(attempt === 0 ? `Approving USDC on ${from.name}…` : `Refreshing ${from.name} RPC and retrying approval…`);
          if (attempt > 0 && (from.id === ARC.id || from.id === ARC_MAINNET.id)) {
            await ensureWalletChain(activeProvider, from.id === ARC_MAINNET.id ? ARC_MAINNET : ARC);
            signer = await new BrowserProvider(activeProvider as never).getSigner();
            usdc = new Contract(from.token, CCTP_USDC_ABI, signer);
          }
          const approval = await usdc.approve(spender, value, { gasLimit: 120000n });
          await approval.wait();
          allowance = await readUsdc.allowance(owner, spender);
        }
        if (allowance < value) throw new Error("Approval did not register on-chain after the wallet RPC was refreshed.");
      }

      const messenger = new Contract(feeRouter || tokenMessenger, feeRouter ? BRIDGE_FEE_ROUTER_ABI : TOKEN_MESSENGER_ABI, signer);
      const fee = await fetchCctpFee(from.id, to.id);
      const fastFee = value / 100n > 0n ? value / 100n : 1n; // 1% ceiling (cap only)
      const attempts: Array<{ maxFee: bigint; threshold: number }> = [];
      if ((fee?.threshold ?? 2000) === 1000) attempts.push({ maxFee: fastFee, threshold: 1000 });
      attempts.push({ maxFee: 0n, threshold: 2000 });

      setStatus(`Burning ${amount} USDC on ${from.name}…`);
      let tx;
      let lastError: unknown;
      for (let i = 0; i < attempts.length; i++) {
        try {
          tx = feeRouter
            ? await messenger.bridge(value, CCTP_DOMAIN[to.id], zeroPadValue(owner, 32), attempts[i].maxFee, attempts[i].threshold, { gasLimit: 420000n })
            : await messenger.depositForBurn(value, CCTP_DOMAIN[to.id], zeroPadValue(owner, 32), from.token, ZeroHash, attempts[i].maxFee, attempts[i].threshold, { gasLimit: 300000n });
          await tx.wait();
          break;
        } catch (burnError) {
          lastError = burnError;
          tx = undefined;
          if (i < attempts.length - 1) setStatus("Fast transfer unavailable for this route — retrying with standard finality…");
        }
      }
      if (!tx) throw lastError instanceof Error ? lastError : new Error("Burn failed on all transfer speeds");

      savePendingClaim(owner, { burnHash: tx.hash, fromChainId: from.id, toChainId: to.id, amount: value.toString() });
      setBridgeRecoveryHash(tx.hash);
      setStatus(`Burned on ${from.name}. Circle is attesting — the claim panel below auto-switches to ${to.name} and mints your USDC once ready. Keep a little ${to.gasSymbol} on ${to.name} for the mint.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(/exceeds allowance/i.test(message) ? "Approval didn't register — try the bridge again to re-approve." : describeTxError(error));
    } finally {
      setBusy(false);
    }
  }

  async function retryCircleBridge() {
    if (!bridgeRetryResult) return;
    setBusy(true); setStatus("Retrying only the failed Circle bridge step…");
    try {
      const { kit, adapter } = await circleBridgeContext();
      const result = await kit.retryBridge(bridgeRetryResult as never, { from: adapter, to: adapter });
      if (result.state === "error") { setBridgeRetryResult(result); throw new Error(circleBridgeFailure(result)); }
      if (result.state === "pending") { setBridgeRetryResult(result); localStorage.setItem(`arcodian-bridge-recovery:${account.toLowerCase()}`, JSON.stringify(result)); setStatus("Recovery resumed. Circle attestation or destination mint is still pending."); }
      else { setBridgeRetryResult(null); localStorage.removeItem(`arcodian-bridge-recovery:${account.toLowerCase()}`); setStatus("Bridge recovery completed. Destination USDC is ready."); }
    } catch (error) { setStatus(friendlySdkError(error)); }
    finally { setBusy(false); }
  }

  function chooseTab(next: Tab) {
    setTab(next);
    setCoinAddress("");
    setProfileAddress("");
    setBridgeEstimate(null);
    setBridgeRetryResult(null);
    setStatus("");
    window.history.pushState({}, "", next === "home" ? "/" : next === "screener" ? "/market" : `/${next}`);
    if (next === "swap") {
      setFromChain(ARC.id);
      setToChain(ARC.id);
    } else if (next === "bridge" && !(isMainnetBridgeChain(fromChain) && isMainnetBridgeChain(toChain))) {
      // Landing on Bridge from anywhere that left it on a testnet pairing
      // (e.g. straight from Swap, which runs on Arc Testnet) snaps back to
      // mainnet — the public Bridge page no longer offers testnet at all.
      setFromChain(MAINNET_CHAINS.find((c) => c.id !== ARC_MAINNET.id)!.id);
      setToChain(ARC_MAINNET.id);
    }
  }

  function chooseCoin(address: string) {
    setTab("screener");
    setCoinAddress(address);
    window.history.pushState({}, "", `/coin/${address}`);
  }

  function chooseProfile(address: string) {
    setTab("profile");
    setCoinAddress("");
    setProfileAddress(address);
    window.history.pushState({}, "", `/profile/${address}`);
  }

  function openCreateStudio() {
    sessionStorage.setItem("arcodian-open-create", "1");
    chooseTab("screener");
    window.dispatchEvent(new Event("arcodian:open-create"));
  }

  const productName = window.location.hostname.split(".")[0] as "wallet" | "lend";
  const productHost = ["wallet", "lend"].includes(productName);
  const walletOnlyExperience = Capacitor.isNativePlatform();
  const redirect = canonicalRedirect(window.location.hostname, window.location.pathname);

  if (redirect) {
    window.location.replace(redirect);
    return <div className="loading-board route-fallback">Opening Arcodian product…</div>;
  }

  if (walletOnlyExperience) {
    return (
      <main className="wallet-product-app">
        <Suspense fallback={<div className="loading-board route-fallback">Opening Arcodian Wallet…</div>}>
          <WalletPage account={account} chainId={chainId} activeProvider={activeProvider} connect={() => connect()} disconnect={disconnect} />
        </Suspense>
        {walletOpen && (
          <WalletModal
            wallets={wallets}
            close={() => setWalletOpen(false)}
            connect={connect}
            walletConnect={connectWalletConnect}
          />
        )}
      </main>
    );
  }

  if (window.location.pathname === "/agents") {
    return (
      <main className="agent-profile-app">
        <Suspense fallback={<div className="loading-board route-fallback">Loading agents…</div>}>
          <AgentsIndex />
        </Suspense>
      </main>
    );
  }

  const agentMatch = window.location.pathname.match(/^\/agent\/(\d+)/);
  if (agentMatch) {
    return (
      <main className="agent-profile-app">
        <Suspense fallback={<div className="loading-board route-fallback">Loading agent…</div>}>
          <AgentProfile agentId={agentMatch[1]} />
        </Suspense>
      </main>
    );
  }

  const jobMatch = window.location.pathname.match(/^\/job\/(\d+)/);
  if (jobMatch) {
    return (
      <main className="agent-profile-app">
        <Suspense fallback={<div className="loading-board route-fallback">Loading job…</div>}>
          <JobDetail jobId={jobMatch[1]} account={account} chainId={chainId} activeProvider={activeProvider} connect={() => connect()} />
        </Suspense>
      </main>
    );
  }

  if (productHost) {
    return <Suspense fallback={<div className="loading-board route-fallback">Opening Arcodian…</div>}>
      {productName === "lend" ? <><LendApp account={account} chainId={chainId} activeProvider={activeProvider} connect={() => connect()} disconnect={disconnect}/>{walletOpen && <WalletModal wallets={wallets} close={() => setWalletOpen(false)} connect={connect} walletConnect={connectWalletConnect}/>}</> : isWalletAppRoute(window.location.hostname, window.location.pathname) ? <><main className="wallet-product-app"><WalletPage account={account} chainId={chainId} activeProvider={activeProvider} connect={() => connect()} disconnect={disconnect} /></main>{walletOpen && <WalletModal wallets={wallets} close={() => setWalletOpen(false)} connect={connect} walletConnect={connectWalletConnect}/>}</> : <ProductLanding product="wallet" />}
    </Suspense>;
  }

  if (tab === "terminal") {
    return <Suspense fallback={<div className="loading-board route-fallback">Opening Trading Terminal…</div>}>
      <TradingTerminal account={account} activeProvider={activeProvider} chainId={chainId} connect={() => connect()} />
      {walletOpen && <WalletModal wallets={wallets} close={() => setWalletOpen(false)} connect={connect} walletConnect={connectWalletConnect} />}
    </Suspense>;
  }

  return (
    <main className={tab === "home" ? "app-home" : undefined}>
      <nav className="nav">
        <button className="brand" onClick={() => chooseTab("home")}>
          <BrandMark />
          <span className="brand-name">ARCODIAN<small>ARC MARKETS</small></span>
        </button>
        <div className="nav-links">
          <details className={`nav-group ${["wallet", "swap", "terminal", "bridge", "arcpay", "fx", "ausd"].includes(tab) ? "active" : ""}`}>
            <summary>Product <i>⌄</i></summary>
            <div>
              <a href={navHref("wallet", host) || "/wallet"}><b>Wallet</b><small>Self-custody on Arc</small></a>
              <button onClick={() => chooseTab("swap")}><b>Swap</b><small>Trade Arc assets</small></button>
              <button onClick={() => chooseTab("terminal")}><b>Trading Terminal</b><small>Full-screen market desk</small></button>
              <button onClick={() => chooseTab("bridge")}><b>Bridge</b><small>Move USDC over CCTP</small></button>
              <button onClick={() => chooseTab("ausd")}><b>AUSD Rail</b><small>Intent bridge into Arc</small></button>
              <button onClick={() => chooseTab("arcpay")}><b>Pay</b><small>Exact-value invoices</small></button>
              <button onClick={() => chooseTab("fx")}><b>Stablecoin FX</b><small>USDC ⇄ EURC</small></button>
            </div>
          </details>
          <details className={`nav-group ${["screener"].includes(tab) ? "active" : ""}`}>
            <summary>Market <i>⌄</i></summary>
            <div>
              <button onClick={() => chooseTab("screener")}><b>Markets</b><small>Discover Arc assets</small></button>
              <button onClick={openCreateStudio}><b>Launchpad</b><small>Create a coin on Arc Mainnet</small></button>
              <a href="https://lend.arcodian.fun/"><b>Lend</b><small>Supply and borrow</small></a>
            </div>
          </details>
          <details className={`nav-group ${["agentpay", "jobs"].includes(tab) ? "active" : ""}`}>
            <summary>Agent <i>⌄</i></summary>
            <div>
              <button onClick={() => chooseTab("agentpay")}><b>Agent Pay</b><small>Bounded agent spending</small></button>
              <button onClick={() => chooseTab("jobs")}><b>Jobs</b><small>Outcome escrow</small></button>
              <a href="/agents"><b>Agents</b><small>Browse the directory</small></a>
            </div>
          </details>
          <details className={`nav-group ${["how", "contracts", "faq", "canary", "analytics", "treasury", "developers"].includes(tab) ? "active" : ""}`}>
            <summary>Resources <i>⌄</i></summary>
            <div>
              <button onClick={() => chooseTab("developers")}><b>Developers</b><small>SDK, registry & MCP</small></button>
              <button onClick={() => chooseTab("contracts")}><b>Trust Center</b><small>Canonical contracts</small></button>
              <button onClick={() => chooseTab("analytics")}><b>Analytics</b><small>Public protocol metrics</small></button>
              <button onClick={() => chooseTab("treasury")}><b>Treasury</b><small>Protocol treasury</small></button>
              <button onClick={() => chooseTab("how")}><b>Docs, FAQ & Legal</b><small>How everything works</small></button>
            </div>
          </details>
        </div>
        <div className="wallet-area">
          {chainId && (
            <span
              className={chainId === ARC.id ? "chain-pill arc" : "chain-pill"}
            >
              ● {CHAIN_NAMES[chainId] || `Chain ${chainId}`}
            </span>
          )}
          {account ? (
            <>
              <button
                className="wallet profile-link"
                onClick={() => chooseProfile(account)}
              >
                Profile {short(account)}
              </button>
              <button className="disconnect" onClick={disconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <button className="wallet" onClick={() => connect()}>
              Connect wallet
            </button>
          )}
        </div>
      </nav>

      {MAINNET_DEPLOY.enabled &&
        account.toLowerCase() === MAINNET_DEPLOY.deployer && (
          <aside className="mainnet-deploy-gate">
            <div className="readiness-summary"><strong>Mainnet release control</strong><span>{readiness.ready ? "All release checks verified" : `${readiness.checks.filter((check) => check.ok).length}/${readiness.checks.length} checks verified`}</span></div>
            <div className="readiness-checks">{readiness.checks.map((check) => <span key={check.key} className={check.ok ? "ok" : "pending"}><i>{check.ok ? "✓" : "—"}</i>{check.label}</span>)}</div>
            <button disabled={mainnetDeployBusy || !readiness.ready} onClick={deployMainnetSuite}>
              {mainnetDeployBusy ? "Waiting for wallet…" : "Deploy mainnet suite"}
            </button>
            {mainnetDeployStatus && <small>{mainnetDeployStatus}</small>}
          </aside>
        )}
      {V5_TESTNET_DEPLOY.enabled && account.toLowerCase() === V5_TESTNET_DEPLOY.deployer && (
        <aside className="mainnet-deploy-gate v5-deploy-gate">
          <strong>Arcodian v5 testnet</strong><span>MC 1K → 30.25K · raise 4.5K · LP ~18.18% burned</span>
          <button disabled={v5DeployBusy || Boolean(localStorage.getItem("arcodian-v5-deploy-tx"))} onClick={deployV5TestnetSuite}>{v5DeployBusy ? "Waiting for wallet…" : "Deploy v5 suite"}</button>
          {v5DeployStatus && <small>{v5DeployStatus}</small>}
        </aside>
      )}

      <Suspense fallback={<div className="loading-board route-fallback">Loading workspace…</div>}>
      {tab === "home" && (
        <section
          className="hero"
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            e.currentTarget.style.setProperty("--mx", String((e.clientX - r.left) / r.width - 0.5));
            e.currentTarget.style.setProperty("--my", String((e.clientY - r.top) / r.height - 0.5));
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.setProperty("--mx", "0");
            e.currentTarget.style.setProperty("--my", "0");
          }}
        >
          <div className="hero-content">
            <p className="kicker">The stablecoin financial operating system on Arc</p>
            <h1>
              Money moves.
              <br />
              <em>One operating layer.</em>
            </h1>
            <p className="hero-copy">
              Send, receive, swap, bridge, manage, and automate USDC and EURC
              through one non-custodial wallet and payment platform on Arc.
            </p>
            <div className="hero-actions">
              <button className="primary hero-primary" onClick={() => chooseTab("wallet")}>Open wallet</button>
              <button className="hero-secondary" onClick={() => chooseTab("arcpay")}>
                Explore Arc Pay
              </button>
            </div>
            <div className="proof">
              <span>No custody</span>
              <span>USDC + EURC</span>
              <span>Circle CCTP</span>
              <span>Arc-native settlement</span>
            </div>
          </div>
          <div className="hero-logo-stage" aria-hidden="true">
            <div className="hero-coin"><img src="/arcodian-mark.svg" alt="" /></div>
          </div>
        </section>
      )}

      {tab === "home" && <LandingExperience enterMarket={() => chooseTab("screener")} chooseCoin={chooseCoin} openTab={(t) => chooseTab(t as Tab)} />}

      {tab === "home" ? null : tab === "faq" ? (
        <FaqPage openHow={() => chooseTab("how")} openContracts={() => chooseTab("contracts")} openCanary={() => chooseTab("canary")} />
      ) : tab === "how" ? (
        <HowItWorks enterMarket={() => chooseTab("screener")} openContracts={() => chooseTab("contracts")} openFaq={() => chooseTab("faq")} openCanary={() => chooseTab("canary")} />
      ) : tab === "contracts" ? (
        <ContractsPage openHow={() => chooseTab("how")} openFaq={() => chooseTab("faq")} openCanary={() => chooseTab("canary")} />
      ) : tab === "canary" ? (
        <CanaryConsole account={account} connect={() => connect()} openContracts={() => chooseTab("contracts")} openHow={() => chooseTab("how")} openFaq={() => chooseTab("faq")} openMarket={() => chooseTab("screener")} openSwap={() => chooseTab("swap")} openBridge={() => chooseTab("bridge")} />
      ) : tab === "wallet" ? (
        <WalletPage account={account} chainId={chainId} activeProvider={activeProvider} connect={() => connect()} disconnect={disconnect} />
      ) : tab === "arcpay" ? (
        <ArcPayLanding account={account} chainId={chainId} activeProvider={activeProvider} connect={() => connect()} />
      ) : tab === "ausd" ? (
        <AUSD account={account} chainId={chainId} activeProvider={activeProvider} connect={() => connect()} />
      ) : tab === "analytics" ? (
        <Analytics />
      ) : tab === "treasury" ? (
        <Treasury account={account} chainId={chainId} activeProvider={activeProvider} connect={() => connect()} />
      ) : tab === "agentpay" ? (
        <AgentPay account={account} chainId={chainId} activeProvider={activeProvider} connect={() => connect()} />
      ) : tab === "jobs" ? (
        <Jobs account={account} chainId={chainId} activeProvider={activeProvider} connect={() => connect()} />
      ) : tab === "developers" ? (
        <Developers />
      ) : tab === "screener" ? (
        <Screener
          account={account}
          chainId={chainId}
          activeProvider={activeProvider}
          connect={() => connect()}
          coinAddress={coinAddress}
          chooseCoin={chooseCoin}
          closeCoin={() => chooseTab("screener")}
        />
      ) : tab === "profile" ? (
        <Profile
          account={profileAddress || account}
          chainId={chainId}
          connect={() => connect()}
          chooseCoin={chooseCoin}
        />
      ) : tab === "fx" ? (
        <section className="workspace workspace-fx">
          <div className="workspace-copy">
            <p className="kicker">StableCoin desk</p>
            <h2>USDC ⇄ EURC,<br /><em>one on-chain rate.</em></h2>
            <p>
              Convert between the two Arc stablecoins with automatic venue selection.
              Arcodian&apos;s permissionless pool is always quoted; approved external
              liquidity can compete for the order when it offers a better executable result.
            </p>
            <div className="fx-facts">
              <span><i>◎</i><small>Routing</small><b>Best quote</b></span>
              <span><i>✓</i><small>Custody</small><b>Wallet-signed</b></span>
              <span><i>⇄</i><small>Pair</small><b>USDC · EURC</b></span>
              <span><i>◈</i><small>Network</small><b>Arc Testnet</b></span>
            </div>
          </div>
          <div className="fx-stage">
            <Suspense fallback={<div className="loading-board">Loading FX…</div>}>
              <FxDesk account={account} activeProvider={activeProvider} onConnect={() => connect()} />
            </Suspense>
          </div>
        </section>
      ) : isSwap ? (
        <section className="workspace workspace-swap">
          <div className="workspace-copy">
            <p className="kicker">Execution desk</p>
            <h2>Trade any Arc token.</h2>
            <p>
              Permissionless pools on Arc. Paste a token&apos;s contract address to
              trade it — the address is the only identity that matters.
            </p>
          </div>
          <div className="panel">
            <div className="dex-tabs">
              {(["swap", "pools", "create", "portfolio"] as const).map((view) => (
                <button
                  key={view}
                  className={dexView === view ? "active" : ""}
                  onClick={() => setDexView(view)}
                >
                  {view === "swap" ? "Swap" : view === "pools" ? "Pools"
                    : view === "create" ? "Create pool" : "Portfolio"}
                </button>
              ))}
            </div>
            <Suspense fallback={<div className="loading-board">Loading…</div>}>
              {dexView === "swap" && <SwapPanel account={account} activeProvider={activeProvider} onConnect={() => connect()} chainId={chainId} />}
              {dexView === "pools" && <PoolsPanel account={account} activeProvider={activeProvider} onConnect={() => connect()} initialPair={focusPair} chainId={chainId} />}
              {dexView === "create" && <CreatePairPanel account={account} activeProvider={activeProvider} onConnect={() => connect()} chainId={chainId} />}
              {dexView === "portfolio" && (
                <PortfolioPanel
                  account={account}
                  onConnect={() => connect()}
                  onManagePool={(pair) => { setFocusPair(pair); setDexView("pools"); }}
                  chainId={chainId}
                />
              )}
            </Suspense>
          </div>
        </section>
      ) : (
        <section className="workspace workspace-bridge">
          <div className="workspace-copy">
            <p className="kicker">Execution desk</p>
            <h2>
              {tab === "bridge"
                ? "Move USDC in—or back out."
                : "Trade the Arc economy."}
            </h2>
            <p>
              {tab === "bridge"
                ? "Bridge real USDC between Arc Mainnet and Ethereum, Arbitrum, Optimism, or Base through official Circle rails. Every route starts or ends on Arc."
                : "Move between official Arc Testnet assets with every address visible before signing."}
            </p>
            {tab === "bridge" && mainnetRpcDown && (
              <div className="rpc-incident-banner" role="status">
                <b>⚠ Arc Mainnet RPC is temporarily down</b>
                <span>This is an upstream infrastructure issue on Arc Mainnet itself — not an Arcodian bug. Balances, quotes, and transfers may fail until it recovers. Please try again shortly.</span>
              </div>
            )}
            {tab === "bridge" && bridgeStats && (
              <div className="bridge-stats-strip">
                <span><b>${bridgeStats.outOfArc.grossUsd.toFixed(2)}</b><small>Bridged out of Arc · {bridgeStats.outOfArc.txCount} tx</small></span>
                <span><b>${bridgeStats.intoArc.grossUsd.toFixed(2)}</b><small>Bridged into Arc · {bridgeStats.intoArc.txCount} tx</small></span>
                <span><b>${bridgeStats.totalFeeUsd.toFixed(4)}</b><small>Total protocol fees</small></span>
              </div>
            )}
          </div>

          <div className="panel">
            {tab === "bridge" ? (
              <BridgeStudio
                account={account}
                activeProvider={activeProvider as never}
                connect={() => connect()}
                fromChain={fromChain}
                toChain={toChain}
                setFromChain={setFromChain}
                setToChain={setToChain}
                amount={amount}
                setAmount={setAmount}
                busy={busy}
                status={status}
                onBridge={bridgeWithCircle}
                bridgeFromArc={bridgeFromArc}
                bridgePeers={bridgePeers}
                reloadSignal={bridgeRecoveryHash}
              />
            ) : (
            <>
              <div className="panel-head">
                <span>{tab === "bridge" ? "Arcodian Bridge" : "Arcodian Swap"}</span>
                <small>
                  {tab === "bridge" ? "Circle CCTP" : "Testnet route preview"}
                </small>
              </div>
              <div className="execution-rail" aria-label={tab === "bridge" ? "Bridge execution stages" : "Swap execution stages"}>
                {(tab === "bridge" ? ["Burn on source", "Circle attestation", "Mint on destination"] : ["Review route", "Approve exact amount", "Execute swap"]).map((stage, index) => <span key={stage}><i>{String(index + 1).padStart(2, "0")}</i><b>{stage}</b></span>)}
              </div>
              {tab === "bridge" ? (
                <div className="chain-grid bridge-two-way">
                  <label>
                    From
                    {bridgeFromArc ? <div className="fixed-chain"><b>{arcNetworkMode === "mainnet" ? "Arc Mainnet" : "Arc Testnet"}</b><small>Chain {activeArcId} · USDC</small></div> : <select value={fromChain} onChange={(e) => { setFromChain(Number(e.target.value)); setBridgeEstimate(null); setBridgeRetryResult(null); }}>{bridgePeers.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select>}
                  </label>
                  <button type="button" className="route-reverse" aria-label="Reverse bridge direction" onClick={() => {
                    if (bridgeFromArc) { setFromChain(toChain === ARC.id ? bridgePeers[0].id : toChain); setToChain(ARC.id); }
                    else { setToChain(fromChain); setFromChain(ARC.id); }
 setBridgeEstimate(null); setBridgeRetryResult(null); setStatus("");
                  }}>⇄<small>Reverse</small></button>
                  <label>
                    To
                    {bridgeFromArc ? <select value={toChain} onChange={(e) => { setToChain(Number(e.target.value)); setBridgeEstimate(null); setBridgeRetryResult(null); }}>{bridgePeers.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select> : <div className="fixed-chain"><b>{arcNetworkMode === "mainnet" ? "Arc Mainnet" : "Arc Testnet"}</b><small>Chain {activeArcId} · USDC</small></div>}
                  </label>
                </div>
              ) : (
                <div className="chain-grid">
                  <label>
                    Pay with
                    <select
                      value={fromToken}
                      onChange={(e) => {
                        setFromToken(e.target.value);
                      }}
                    >
                      {TOKENS.map((t) => (
                        <option value={t.address} key={t.address}>
                          {t.symbol}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="route-arrow">→</span>
                  <label>
                    Receive
                    <select
                      value={toToken}
                      onChange={(e) => {
                        setToToken(e.target.value);
                      }}
                    >
                      {TOKENS.map((t) => (
                        <option value={t.address} key={t.address}>
                          {t.symbol}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <label className="amount">
                Amount
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setBridgeEstimate(null);
                    setBridgeRetryResult(null);
                  }}
                />
                <strong>USDC</strong>
              </label>
              <div className="fee-strip">
                <span>{tab === "bridge" ? "Bridge fee" : "Route fees"}</span>
                <b>{tab === "bridge" ? "Circle CCTP only" : "Shown in quote"}</b>
                <small>
                  {tab === "bridge"
                    ? "No extra Arcodian fee on the burn — you pay only Circle's tiny CCTP fee and destination gas."
                    : "Aggregator, liquidity, and gas costs are included in the reviewed quote."}
                </small>
              </div>
              <div className="workspace-assurance">
                <span><i>✓</i><small>Network</small><b>{tab === "bridge" ? "Arc endpoint enforced" : "Arc Testnet only"}</b></span>
                <span><i>✓</i><small>Custody</small><b>Wallet-signed only</b></span>
                <span><i>✓</i><small>Protection</small><b>{bridgeEstimate ? "Bridge estimate reviewed" : "Quote before execution"}</b></span>
              </div>
              {tab === "bridge" && (
                <div className="bridge-finality">
                  <span><small>Source finality</small><b>Single confirmation on Arc</b></span>
                  <span><small>Attestation</small><b>Circle CCTP · typically minutes</b></span>
                  <span><small>Destination mint</small><b>Needs destination gas</b></span>
                </div>
              )}
              {tab === "bridge" && toChain === ARC.id && (
                <p className="bridge-faucet-hint">
                  <b>First time on Arc?</b> USDC is the gas token here, so the claim (mint) needs a little
                  USDC already on Arc. Grab test USDC from the{" "}
                  <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Circle faucet</a>{" "}
                  (Arc Testnet · chain 5042002) first — it covers the mint gas and gives you a balance to trade.
                </p>
              )}
              {tab === "bridge" && toChain !== ARC.id && (
                <p className="bridge-faucet-hint">
                  <b>Bridging out of Arc?</b> The mint happens on{" "}
                  <b>{CHAIN_NAMES[toChain] || "the destination chain"}</b>, so you need a little{" "}
                  <b>{CHAINS.find((c) => c.id === toChain)?.gasSymbol || "gas"}</b> there to claim. Get it from
                  that network's testnet faucet first — otherwise the confirm step stays locked until destination gas is detected.
                </p>
              )}
              {bridgeEstimate && (
                <div className="quote bridge-estimate">
                  <span>You receive</span>
                  <strong>{bridgeEstimate.amount} USDC</strong>
                  <small>{bridgeEstimate.source} → {bridgeEstimate.destination}</small>
                  <small className={bridgeEstimate.destinationGas.ready ? "gas-ready" : "gas-missing"}>{bridgeEstimate.destinationGas.ready ? "Ready to bridge" : `Before continuing, add a little ${bridgeEstimate.destinationGas.symbol} on ${bridgeEstimate.destination}. This pays the final network fee.`}</small>
                  <details className="bridge-technical-details"><summary>Fee details</summary><small>{bridgeEstimate.fees.length ? bridgeEstimate.fees.map((fee) => `${fee.type}: ${fee.amount ?? "included"} ${sdkTokenLabel(fee.token, "USDC")}`).join(" · ") : "Circle fee included"}</small></details>
                </div>
              )}
              {tab === "bridge" && arcNetworkMode === "mainnet" && bridgeFromArc && (
                <p className="bridge-limit-note"><b>Circle's own network-side limit:</b> bridging out of Arc Mainnet is capped at 1 USDC per transaction right now. This is on Circle's side, not ours — bridge in 1 USDC steps until they raise it.</p>
              )}
              {bridgeRetryResult && <div className="bridge-recovery-state"><b>Bridge recovery</b>{((bridgeRetryResult as { steps?: Array<{ name?: string; state?: string; txHash?: string }> }).steps || []).map((step, index) => <span key={`${step.name}-${index}`} className={step.state || "pending"}><i>{step.state === "success" ? "✓" : step.state === "error" ? "!" : "…"}</i><small>{step.name || `Step ${index + 1}`}</small><em>{step.state || "pending"}</em>{step.txHash && <a href={`${ARC.explorer}/tx/${step.txHash}`} target="_blank" rel="noreferrer">{short(step.txHash)} ↗</a>}</span>)}</div>}
              {status && <p className="status">{status}</p>}
              {bridgeRetryResult && <button className="secondary" disabled={busy} onClick={retryCircleBridge}>{busy ? "Recovering…" : "Resume pending bridge"}</button>}
              {!account ? (
                <button className="primary" onClick={() => connect()}>
                  Connect wallet
                </button>
              ) : tab === "bridge" ? (
                <button className="primary" disabled={busy || !amount || fromChain === toChain} onClick={bridgeWithCircle}>
                  {busy ? "Working…" : `Bridge to ${CHAIN_NAMES[toChain] || "destination"}`}
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!canQuote || busy}
                  onClick={requestQuote}
                >
                  {busy ? "Estimating Circle route…" : "Review Circle estimate"}
                </button>
              )}
              <p className="fine">
                ARC never receives your keys. Route execution only happens after
                wallet confirmation.
              </p>
            </>
            )}
          </div>
        </section>
      )}
      </Suspense>

      <footer>
        <strong>ARCODIAN © 2026</strong>
        <span>Markets should show their workings.</span>
        <button onClick={() => chooseTab("how")}>Docs, FAQ & Legal</button>
        <button onClick={() => chooseTab("contracts")}>Trust Center</button>
        <a href={ARC.explorer} target="_blank" rel="noreferrer">
          Explorer ↗
        </a>
        <div className="footer-socials">
          <a href="https://x.com/Arcodiandotfun" target="_blank" rel="noreferrer" aria-label="Arcodian on X">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          </a>
          <a href="https://discord.gg/mUvcty8VAB" target="_blank" rel="noreferrer" aria-label="Arcodian on Discord">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127c-.598.35-1.22.645-1.873.892a.076.076 0 0 0-.04.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.028zM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.956 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.334-.946 2.419-2.157 2.419z"/></svg>
          </a>
        </div>
      </footer>
      <nav className="mobile-dock" aria-label="Primary">
        <button className={tab === "home" ? "active" : ""} onClick={() => chooseTab("home")}><i aria-hidden="true">◉</i><span>Home</span></button>
        <button onClick={() => { window.location.href = "https://wallet.arcodian.fun/"; }}><i aria-hidden="true">◈</i><span>Wallet</span></button>
        <button className={tab === "arcpay" ? "active" : ""} onClick={() => chooseTab("arcpay")}><i aria-hidden="true">⌗</i><span>Arc Pay</span></button>
        <button className={tab === "screener" ? "active" : ""} onClick={() => chooseTab("screener")}><i aria-hidden="true">◫</i><span>Markets</span></button>
        <button className={tab === "bridge" || tab === "swap" ? "active" : ""} onClick={() => chooseTab("bridge")}><i aria-hidden="true">⇄</i><span>Bridge</span></button>
        <button onClick={() => setMobileMoreOpen((value) => !value)}><i aria-hidden="true">•••</i><span>More</span></button>
      </nav>
      {mobileMoreOpen && <aside className="mobile-more-menu" aria-label="All products"><div className="mm-head"><img src="/arcodian-mark.svg" alt="" width="22" height="22" /><b>ARCODIAN</b><button className="mm-close" onClick={() => setMobileMoreOpen(false)}>Close ×</button></div>
        <p className="mm-group">Product</p>
        <a href="/swap">Swap</a><a href="/ausd">AUSD Rail</a><a href="/arcpay">Pay</a><a href="/fx">Stablecoin FX</a>
        <p className="mm-group">Market</p>
        <a href="/screener">Markets</a><a href="https://lend.arcodian.fun/">Lend</a>
        <p className="mm-group">Agent</p>
        <a href="/agentpay">Agent Pay</a><a href="/jobs">Jobs</a><a href="/agents">Agents</a>
        <p className="mm-group">Resources</p>
        <a href="/developers">Developers</a><a href="/contracts">Trust Center</a><a href="/analytics">Analytics</a><a href="/treasury">Treasury</a><a href="/docs">Docs, FAQ &amp; Legal</a>
        <button className="mm-create" onClick={() => { setMobileMoreOpen(false); openCreateStudio(); }}>Create token</button></aside>}
      {walletOpen && (
        <WalletModal
          wallets={wallets}
          close={() => setWalletOpen(false)}
          connect={connect}
          walletConnect={connectWalletConnect}
        />
      )}
      {!acknowledged && <RiskAcknowledgement accept={() => { localStorage.setItem("arcodian-risk-ack-v1", "accepted"); setAcknowledged(true); }} />}
    </main>
  );
}

function RiskAcknowledgement({ accept }: { accept: () => void }) {
  const [checked,setChecked]=useState(false); const [expanded,setExpanded]=useState(false);
  return <div className="ack-backdrop"><section className="ack-modal" role="dialog" aria-modal="true" aria-labelledby="ack-title"><div className="ack-mark"><BrandMark/></div><p className="kicker">Before you enter</p><h2 id="ack-title">Bridge, Market, and Swap move real USDC on Arc Mainnet. Lend and most agent-economy tools still run on Arc Testnet.</h2><div className="ack-points"><span><b>Two networks, one app</b><small>Bridge, the USDC-only Market, and Swap (including the trading terminal) carry real value on Arc Mainnet — check your wallet's active network before trading. Lend, FX, and most agent-economy tools stay on Arc Testnet, where test USDC has no financial value.</small></span><span><b>Permissionless tokens</b><small>Anyone can create one. Verify contracts and social links yourself.</small></span><span><b>Wallet-signed actions</b><small>Transactions are public, final, and initiated only after your confirmation — check the network your wallet shows before you sign.</small></span></div>{expanded&&<div className="ack-expanded">{FAQ_ITEMS.slice(0,4).map(([q,a])=><p key={q}><strong>{q}</strong><span>{a}</span></p>)}</div>}<button className="ack-more" onClick={()=>setExpanded(v=>!v)}>{expanded?"Hide quick FAQ":"Read quick FAQ"}</button><label className="ack-check"><input type="checkbox" checked={checked} onChange={event=>setChecked(event.target.checked)}/><span>I understand Bridge, Market, and Swap carry real value on Arc Mainnet, Lend and most agent-economy tools are Arc Testnet, tokens are permissionless, and I am responsible for reviewing every wallet transaction.</span></label><button className="primary ack-enter" disabled={!checked} onClick={accept}>Agree & enter Arcodian</button><small className="ack-local">Saved only in this browser. No personal acceptance record is sent to the server.</small></section></div>;
}

function WalletModal({
  wallets,
  close,
  connect,
  walletConnect,
}: {
  wallets: WalletOption[];
  close: () => void;
  connect: (wallet: WalletOption) => void;
  walletConnect: () => void;
}) {
  const installs = [
    ["MetaMask", "https://metamask.io/download/"],
    ["OKX", "https://www.okx.com/web3"],
    ["Zerion", "https://zerion.io/"],
    ["Bitget", "https://web3.bitget.com/"],
    ["Rabby", "https://rabby.io/"],
    ["Coinbase", "https://www.coinbase.com/wallet"],
  ];
  const unique = wallets.filter(
    (wallet, index) =>
      wallets.findIndex((item) => item.provider === wallet.provider) === index,
  );
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <section
        className="wallet-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <p className="kicker">Wallet discovery</p>
            <h3>Choose your wallet</h3>
          </div>
          <button onClick={close}>×</button>
        </div>
        {unique.length ? (
          <div className="wallet-list">
            {unique.map((wallet) => (
              <button key={wallet.info.uuid} onClick={() => connect(wallet)}>
                {wallet.info.icon ? (
                  <img src={wallet.info.icon} alt="" />
                ) : (
                  <b>{wallet.info.name[0]}</b>
                )}
                <span>
                  <strong>{wallet.info.name}</strong>
                  <small>Detected in this browser</small>
                </span>
                <i>→</i>
              </button>
            ))}
          </div>
        ) : (
          <p className="no-wallet">
            No injected wallet detected. Open this page inside a wallet browser
            or install one below.
          </p>
        )}
        {WALLETCONNECT_PROJECT_ID && <button className="walletconnect-button" onClick={walletConnect}>Scan with WalletConnect</button>}
        <div className="install-grid">
          {installs.map(([name, url]) => (
            <a href={url} target="_blank" rel="noreferrer" key={name}>
              {name} ↗
            </a>
          ))}
        </div>
        <p className="fine">
          EIP-6963 detection · ARC never receives seed phrases or private keys.
        </p>
      </section>
    </div>
  );
}
