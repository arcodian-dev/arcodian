import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import {
  BrowserProvider,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  formatEther,
  parseUnits,
} from "ethers";
import {
  ARC,
  BRIDGE_FEE_BPS,
  CHAINS,
  FEE_TREASURY,
  MAINNET_DEPLOY,
  SWAP_FEE_BPS,
  TOKENS,
  WALLETCONNECT_PROJECT_ID,
  V5_TESTNET_DEPLOY,
  navHref,
  subdomainTab,
} from "./config";
import { ARC_PUMP_SUITE_ABI } from "./generated/arcPumpSuite";
import { displayAmount, getQuote, type Quote } from "./lifi";
import { mainnetReadiness } from "./readiness";
import { isArcBridgeRoute } from "./bridgeRoute";
import { CIRCLE_BRIDGE_EXECUTION } from "./circleBridgeConfig";
import { BrandMark, FAQ_ITEMS, short, type WalletOption } from "./shared";

const Screener = lazy(() => import("./pages/Market"));
const FxWidget = lazy(() => import("./components/FxWidget"));
const LiquidityPanel = lazy(() => import("./components/LiquidityPanel"));
const Profile = lazy(() => import("./pages/Profile"));
const LandingExperience = lazy(() => import("./pages/Landing"));
const loadTrustCenter = () => import("./pages/TrustCenter");
const ContractsPage = lazy(() => loadTrustCenter().then((m) => ({ default: m.ContractsPage })));
const FaqPage = lazy(() => loadTrustCenter().then((m) => ({ default: m.FaqPage })));
const HowItWorks = lazy(() => loadTrustCenter().then((m) => ({ default: m.HowItWorks })));
const CanaryConsole = lazy(() => loadTrustCenter().then((m) => ({ default: m.CanaryConsole })));

type Tab = "home" | "screener" | "bridge" | "swap" | "fx" | "profile" | "how" | "faq" | "contracts" | "canary";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  11155111: "Ethereum Sepolia",
  42161: "Arbitrum",
  421614: "Arbitrum Sepolia",
  8453: "Base",
  84532: "Base Sepolia",
  43113: "Avalanche Fuji",
  11155420: "OP Sepolia",
  80002: "Polygon Amoy",
  [ARC.id]: ARC.name,
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

const ROUTE_TABS = ["screener", "bridge", "swap", "fx", "profile", "how", "faq", "contracts", "canary"] as const;
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
  if (segment === "market" || segment === "explore" || segment === "launch" || segment === "coin")
    return "screener";
  if (segment === "docs") return "how";
  if (segment === "profil") return "profile";
  return (ROUTE_TABS as readonly string[]).includes(segment)
    ? (segment as Tab)
    : hostTab || "screener";
}

export default function App() {
  const readiness = mainnetReadiness(MAINNET_DEPLOY);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [account, setAccount] = useState("");
  const [fromChain, setFromChain] = useState<number>(11155111);
  const [toChain, setToChain] = useState<number>(ARC.id);
  const [fromToken, setFromToken] = useState<string>(TOKENS[0].address);
  const [toToken, setToToken] = useState<string>(TOKENS[1].address);
  const [amount, setAmount] = useState("100");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [circleSwapEstimate, setCircleSwapEstimate] = useState<CircleSwapEstimateView | null>(null);
  const [swapRail, setSwapRail] = useState<"circle" | "fallback" | null>(null);
  const [bridgeEstimate, setBridgeEstimate] = useState<BridgeEstimateView | null>(null);
  const [bridgeRetryResult, setBridgeRetryResult] = useState<unknown>(null);
  const [bridgeRecoveryHash, setBridgeRecoveryHash] = useState("");
  const [bridgeRecoveryStatus, setBridgeRecoveryStatus] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [walletOpen, setWalletOpen] = useState(false);
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
    if (window.ethereum) {
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
    activeProvider
      .request({ method: "eth_chainId" })
      .then(updateChain)
      .catch(() => setChainId(null));
    activeProvider.on?.("chainChanged", updateChain);
    activeProvider.on?.("accountsChanged", updateAccounts);
    return () => {
      activeProvider.removeListener?.("chainChanged", updateChain);
      activeProvider.removeListener?.("accountsChanged", updateAccounts);
    };
  }, [activeProvider]);

  const isSwap = tab === "swap";
  const host = typeof window !== "undefined" ? window.location.hostname : "";
  const selectedFrom = TOKENS.find((t) => t.address === fromToken) || TOKENS[0];
  const selectedTo = TOKENS.find((t) => t.address === toToken) || TOKENS[1];
  const bridgeFrom =
    CHAINS.find((chain) => chain.id === fromChain) || CHAINS[0];
  const bridgeTo = CHAINS.find((chain) => chain.id === toChain) || CHAINS[3];
  const bridgePeers = CHAINS.filter((chain) => chain.id !== ARC.id);
  const bridgeFromArc = fromChain === ARC.id;
  const canQuote = Boolean(account && Number(amount) > 0 && (!isSwap || fromToken.toLowerCase() !== toToken.toLowerCase()));
  const receive = useMemo(
    () =>
      quote
        ? displayAmount(quote.estimate.toAmount, quote.action.toToken.decimals)
        : "—",
    [quote],
  );

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
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Wallet connection rejected",
      );
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
    setQuote(null);
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
    } catch (error) { setStatus(error instanceof Error ? error.message : "WalletConnect failed"); }
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
    if (!isSwap) {
      await estimateCircleBridge();
      return;
    }
    setBusy(true);
    setStatus("");
    setQuote(null);
    setCircleSwapEstimate(null);
    setSwapRail(null);
    try {
      const { kit, params } = await circleSwapContext();
      const estimate = await kit.estimateSwap(params as never);
      setCircleSwapEstimate({
        output: estimate.estimatedOutput.amount,
        outputToken: sdkTokenLabel(estimate.estimatedOutput.token, selectedTo.symbol),
        minimum: estimate.stopLimit.amount,
        fees: (estimate.fees || []).map((fee) => ({ type: fee.type, token: sdkTokenLabel(fee.token, selectedFrom.symbol), amount: fee.amount })),
      });
      setSwapRail("circle");
      setStatus("Circle Swap estimate ready. Review minimum output and fees before signing.");
      return;
    } catch (circleError) {
      setStatus("Circle route is unavailable right now. Checking the fallback aggregator…");
      try {
      const next = await getQuote({
        fromChain: isSwap ? ARC.id : fromChain,
        toChain: isSwap ? ARC.id : toChain,
        fromToken: isSwap ? fromToken : bridgeFrom.token,
        toToken: isSwap ? toToken : bridgeTo.token,
        fromAmount: parseUnits(
          amount,
          isSwap ? selectedFrom.decimals : ARC.erc20Decimals,
        ).toString(),
        fromAddress: account,
      });
      if (next.action.fromChainId !== ARC.id || next.transactionRequest?.chainId !== ARC.id)
        throw new Error("Rejected a quote that does not execute on Arc Testnet.");
      if (next.action.fromToken.address.toLowerCase() !== fromToken.toLowerCase() || next.action.toToken.address.toLowerCase() !== toToken.toLowerCase())
        throw new Error("Rejected a quote with unexpected token addresses.");
      setQuote(next);
      setSwapRail("fallback");
      setStatus("Fallback route ready. Circle Swap was unavailable for this pair.");
      } catch (fallbackError) {
        const circleMessage = friendlySdkError(circleError);
        const fallbackMessage = friendlySdkError(fallbackError);
        setStatus(`No safe swap route is available. Circle: ${circleMessage}. Fallback: ${fallbackMessage}.`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function circleSwapContext() {
    if (!activeProvider || !account) throw new Error("Connect a wallet first.");
    if (fromToken.toLowerCase() === toToken.toLowerCase()) throw new Error("Choose two different assets.");
    const [{ AppKit }, { createViemAdapterFromProvider }] = await Promise.all(
      [import("@circle-fin/app-kit"), import("@circle-fin/adapter-viem-v2")],
    );
    const adapter = await createViemAdapterFromProvider({ provider: activeProvider as never });
    return {
      kit: new AppKit(),
      params: {
        from: { adapter, chain: "Arc_Testnet" },
        tokenIn: selectedFrom.symbol,
        tokenOut: selectedTo.symbol,
        amountIn: amount,
        config: {
          allowanceStrategy: "approve",
          slippageBps: 50,
          customFee: { percentageBps: SWAP_FEE_BPS, recipientAddress: FEE_TREASURY },
        },
      },
    };
  }

  async function executeCircleSwap() {
    if (!circleSwapEstimate) return;
    setBusy(true);
    setStatus("Opening Circle Swap. Approve the exact amount, then confirm execution in your wallet.");
    try {
      const { kit, params } = await circleSwapContext();
      const result = await kit.swap({
        ...params,
        config: { ...params.config, stopLimit: circleSwapEstimate.minimum },
      } as never);
      setStatus(result.progress.status === "DONE" ? `Circle Swap confirmed: ${result.txHash}` : `Circle Swap submitted: ${result.txHash}. Confirmation is still pending.`);
      setCircleSwapEstimate(null);
      setSwapRail(null);
    } catch (error) {
      setStatus(friendlySdkError(error));
    } finally {
      setBusy(false);
    }
  }

  async function circleBridgeContext() {
    if (!activeProvider || fromChain === toChain) throw new Error(fromChain === toChain ? "Choose two different networks." : "Connect a wallet first.");
    const [{ AppKit }, { createViemAdapterFromProvider }] = await Promise.all(
      [import("@circle-fin/app-kit"), import("@circle-fin/adapter-viem-v2")],
    );
    const adapter = await createViemAdapterFromProvider({ provider: activeProvider as never });
    const from = CHAINS.find((chain) => chain.id === fromChain);
    const to = CHAINS.find((chain) => chain.id === toChain);
    if (!from || !to) throw new Error("Unsupported Circle bridge network");
    if (!isArcBridgeRoute(from.id, to.id, ARC.id)) throw new Error("Every Arcodian bridge route must start or end on Arc Testnet.");
    const customFee = ((Number(amount) * BRIDGE_FEE_BPS) / 10_000).toFixed(6).replace(/\.?0+$/, "");
    return {
      kit: new AppKit(), adapter, from, to,
      params: {
        from: { adapter, chain: from.appKit },
        to: { adapter, chain: to.appKit },
        amount,
        config: { ...CIRCLE_BRIDGE_EXECUTION, customFee: { value: customFee, recipientAddress: FEE_TREASURY } },
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

  async function bridgeWithCircle() {
    if (!activeProvider || fromChain === toChain) {
      setStatus(
        fromChain === toChain
          ? "Choose two different networks."
          : "Connect a wallet first.",
      );
      return;
    }
    if (!bridgeEstimate?.destinationGas.ready) {
      setStatus(`Bridge blocked before burn: add destination ${bridgeEstimate?.destinationGas.symbol || "gas token"}, then review the estimate again.`);
      return;
    }
    setBusy(true);
    setStatus(
      "Preparing official Circle CCTP bridge. Your wallet may request network switches and approvals.",
    );
    try {
      const { kit, params } = await circleBridgeContext();
      const result = await kit.bridge(params);
      if (result.state === "error") {
        setBridgeRetryResult(result);
        localStorage.setItem(`arcodian-bridge-recovery:${account.toLowerCase()}`, JSON.stringify(result));
        throw new Error(circleBridgeFailure(result));
      }
      if (result.state === "pending") {
        setBridgeRetryResult(result);
        localStorage.setItem(`arcodian-bridge-recovery:${account.toLowerCase()}`, JSON.stringify(result));
        setStatus("Source transaction is confirmed. Circle attestation or relayed mint is still pending; do not submit another bridge.");
      } else {
        setBridgeRetryResult(null);
        localStorage.removeItem(`arcodian-bridge-recovery:${account.toLowerCase()}`);
        setStatus("Bridge completed through Circle CCTP. Destination USDC is ready.");
      }
    } catch (error) {
      setStatus(
        friendlySdkError(error),
      );
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

  async function recoverCircleBurn() {
    const hash = bridgeRecoveryHash.trim();
    if (!activeProvider || !account) { setBridgeRecoveryStatus("Connect the original bridge wallet first."); return; }
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) { setBridgeRecoveryStatus("Enter the Arc source burn transaction hash."); return; }
    setBusy(true); setBridgeRecoveryStatus("Verifying the source burn and fetching Circle attestation…");
    try {
      const source = CHAINS.find((chain) => chain.id === fromChain), destination = CHAINS.find((chain) => chain.id === toChain);
      if (!source || !destination || source.id !== ARC.id) throw new Error("Recovery currently accepts an Arc source burn and an EVM testnet destination.");
      const sourceProvider = new JsonRpcProvider(source.rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
      try {
        const tx = await sourceProvider.getTransaction(hash), receipt = await sourceProvider.getTransactionReceipt(hash);
        if (!receipt || receipt.status !== 1) throw new Error("The source burn is not confirmed on Arc.");
        if (!tx || tx.from.toLowerCase() !== account.toLowerCase()) throw new Error("This burn was not submitted by the connected wallet.");
      } finally { sourceProvider.destroy(); }
      const [{ CCTPV2BridgingProvider }, { createViemAdapterFromProvider }] = await Promise.all([import("@circle-fin/provider-cctp-v2"), import("@circle-fin/adapter-viem-v2")]);
      const adapter = await createViemAdapterFromProvider({ provider: activeProvider as never });
      const cctp = new CCTPV2BridgingProvider();
      const supported = (cctp as unknown as { supportedChains: Array<{ chainId?: number }> }).supportedChains;
      const sourceDefinition = supported.find((chain) => chain.chainId === source.id), destinationDefinition = supported.find((chain) => chain.chainId === destination.id);
      if (!sourceDefinition || !destinationDefinition) throw new Error("Circle does not expose this recovery route.");
      const sourceContext = { adapter, address: account, chain: sourceDefinition };
      const destinationContext = { adapter, address: account, chain: destinationDefinition };
      const attestation = await cctp.fetchAttestation(sourceContext as never, hash);
      setBridgeRecoveryStatus(`Bridge found. Confirm one final transaction on ${destination.name}. No USDC will be burned again.`);
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${destination.id.toString(16)}` }] });
      const prepared = await cctp.mint(sourceContext as never, destinationContext as never, attestation);
      const mintHash = await prepared.execute();
      const destinationProvider = new BrowserProvider(activeProvider as never);
      await destinationProvider.waitForTransaction(mintHash);
      setBridgeRecoveryStatus(`Bridge completed. Your USDC is now available on ${destination.name}. Transaction: ${mintHash}`);
      setBridgeRetryResult(null); localStorage.removeItem(`arcodian-bridge-recovery:${account.toLowerCase()}`);
    } catch (error) { setBridgeRecoveryStatus(friendlySdkError(error)); }
    finally { setBusy(false); }
  }

  async function execute() {
    if (!activeProvider || !quote?.transactionRequest) return;
    setBusy(true);
    setStatus("Check the transaction carefully in your wallet.");
    try {
      const chainHex = `0x${quote.action.fromChainId.toString(16)}`;
      try {
        await activeProvider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chainHex }],
        });
      } catch (switchError) {
        const code = (switchError as { code?: number }).code;
        if (code !== 4902 || quote.action.fromChainId !== ARC.id)
          throw switchError;
        await activeProvider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: ARC.hexId,
              chainName: ARC.name,
              nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
              rpcUrls: [ARC.rpc],
              blockExplorerUrls: [ARC.explorer],
            },
          ],
        });
      }
      const provider = new BrowserProvider(activeProvider as never);
      const signer = await provider.getSigner();
      const approvalAddress = quote.estimate.approvalAddress;
      const nativeLike = quote.action.fromToken.address.toLowerCase() ===
        "0x0000000000000000000000000000000000000000";
      if (approvalAddress && !nativeLike) {
        const token = new Contract(
          quote.action.fromToken.address,
          [
            "function allowance(address owner,address spender) view returns (uint256)",
            "function approve(address spender,uint256 amount) returns (bool)",
          ],
          signer,
        );
        const owner = await signer.getAddress();
        const allowance = (await token.allowance(
          owner,
          approvalAddress,
        )) as bigint;
        if (allowance < BigInt(quote.estimate.fromAmount)) {
          setStatus("Approve the exact route amount in your wallet.");
          const approval = await token.approve(
            approvalAddress,
            quote.estimate.fromAmount,
          );
          await approval.wait();
          setStatus("Approval confirmed. Now confirm the route transaction.");
        }
      }
      const tx = await signer.sendTransaction(quote.transactionRequest);
      setStatus(`Submitted: ${tx.hash}`);
      await tx.wait();
      setStatus(`Swap confirmed: ${tx.hash}`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Transaction rejected",
      );
    } finally {
      setBusy(false);
    }
  }

  function chooseTab(next: Tab) {
    setTab(next);
    setCoinAddress("");
    setProfileAddress("");
    setQuote(null);
    setCircleSwapEstimate(null);
    setSwapRail(null);
    setBridgeEstimate(null);
    setBridgeRetryResult(null);
    setStatus("");
    window.history.pushState({}, "", next === "home" ? "/" : next === "screener" ? "/market" : `/${next}`);
    if (next === "swap") {
      setFromChain(ARC.id);
      setToChain(ARC.id);
    } else if (next === "bridge" && fromChain === ARC.id && toChain === ARC.id) {
      setFromChain(CHAINS[0].id);
      setToChain(ARC.id);
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

  return (
    <main>
      <nav className="nav">
        <button className="brand" onClick={() => chooseTab("home")}>
          <BrandMark />
          <span className="brand-name">ARCODIAN<small>ARC MARKETS</small></span>
        </button>
        <div className="nav-links">
          {([
            ["screener", "market"],
            ["swap", "swap"],
            ["bridge", "bridge"],
            ["fx", "stablecoin FX"],
            ["how", "docs"],
          ] as Array<[Tab, string]>).map(([item, label]) => {
            const href = navHref(item, host);
            const active = tab === item || (item === "how" && (tab === "contracts" || tab === "faq" || tab === "canary"));
            return href ? (
              <a key={item} className={active ? "active" : ""} href={href} target="_blank" rel="noreferrer">
                {label}
              </a>
            ) : (
              <button key={item} className={active ? "active" : ""} onClick={() => chooseTab(item)}>
                {label}
              </button>
            );
          })}
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
            <p className="kicker">Made for Arc · Markets are live</p>
            <h1>
              Small coins.
              <br />
              <em>Open books.</em>
            </h1>
            <p className="hero-copy">
              Find an idea while it is still early—or put your own into motion.
              Every price, trade, and graduation is visible onchain. Your wallet
              stays yours.
            </p>
            <div className="hero-actions">
              <button className="primary hero-primary" onClick={() => chooseTab("screener")}>Explore coins</button>
              <button className="hero-secondary" onClick={() => chooseTab("screener")}>
                Create coin
              </button>
            </div>
            <div className="proof">
              <span>No custody</span>
              <span>Priced in USDC</span>
              <span>One visible curve</span>
              <span>Liquidity locked for good</span>
            </div>
          </div>
          <div className="orbit-stage" aria-hidden="true">
            <div className="orbit-glow" />
            <div className="orbit-ring ring-one"><i /></div>
            <div className="orbit-ring ring-two"><i /></div>
            <div className="brand-planet"><img src="/arcodian-mark.svg" alt="" /></div>
            <span className="orbit-chip chip-market">THE TAPE IS LIVE<small>EVERY TRADE ONCHAIN</small></span>
            <span className="orbit-chip chip-curve">NO BACK ROOM<small>ONE VISIBLE CURVE</small></span>
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
      ) : tab === "screener" ? (
        <Screener
          account={account}
          activeProvider={activeProvider}
          connect={() => connect()}
          coinAddress={coinAddress}
          chooseCoin={chooseCoin}
          closeCoin={() => chooseTab("screener")}
        />
      ) : tab === "profile" ? (
        <Profile
          account={profileAddress || account}
          connect={() => connect()}
          chooseCoin={chooseCoin}
        />
      ) : tab === "fx" ? (
        <section className="workspace workspace-fx">
          <div className="workspace-copy">
            <p className="kicker">StableCoin desk</p>
            <h2>USDC ⇄ EURC,<br /><em>one on-chain rate.</em></h2>
            <p>
              Convert between the two Arc stablecoins through the canonical Arc FX
              pool—a constant-product AMM you can read on-chain. No aggregator hop,
              no custody, wallet-signed. The rate you see is the rate the pool quotes.
            </p>
            <div className="fx-facts">
              <span><i>◎</i><small>Pool fee</small><b>0.10%</b></span>
              <span><i>✓</i><small>Custody</small><b>Wallet-signed</b></span>
              <span><i>⇄</i><small>Pair</small><b>USDC · EURC</b></span>
              <span><i>◈</i><small>Network</small><b>Arc Testnet</b></span>
            </div>
          </div>
          <div className="fx-stage">
            <Suspense fallback={<div className="loading-board">Loading FX…</div>}>
              <FxWidget account={account} activeProvider={activeProvider} onConnect={() => connect()} />
              <LiquidityPanel account={account} activeProvider={activeProvider} onConnect={() => connect()} />
            </Suspense>
          </div>
        </section>
      ) : (
        <section className={`workspace ${isSwap ? "workspace-swap" : "workspace-bridge"}`}>
          <div className="workspace-copy">
            <p className="kicker">Execution desk</p>
            <h2>
              {tab === "bridge"
                ? "Move USDC in—or back out."
                : "Trade the Arc economy."}
            </h2>
            <p>
              {tab === "bridge"
                ? "Bridge test USDC between Arc and supported testnets through official Circle rails. Every route starts or ends on Arc."
                : "Move between official Arc Testnet assets with every address visible before signing."}
            </p>
          </div>

          <div className="panel">
            <>
              <div className="panel-head">
                <span>{tab === "bridge" ? "Bridge" : "Swap"}</span>
                <small>
                  {tab === "bridge" ? "Circle CCTP" : "Testnet route preview"}
                </small>
              </div>
              <div className="execution-rail" aria-label={tab === "bridge" ? "Bridge execution stages" : "Swap execution stages"}>
                {(tab === "bridge" ? ["Burn on source", "Circle attestation", "Mint on destination"] : ["Review route", "Approve exact amount", "Execute swap"]).map((stage, index) => <span key={stage}><i>{String(index + 1).padStart(2, "0")}</i><b>{stage}</b></span>)}
              </div>
              {isSwap && (
                <div className="swap-pair-hero" aria-hidden="true">
                  <b>{selectedFrom.symbol}</b>
                  <i>→</i>
                  <b>{selectedTo.symbol}</b>
                  <small>Arc Testnet pair · Circle-first routing · 0.5% slippage guard</small>
                </div>
              )}
              {tab === "bridge" ? (
                <div className="chain-grid bridge-two-way">
                  <label>
                    From
                    {bridgeFromArc ? <div className="fixed-chain"><b>Arc Testnet</b><small>Chain 5042002 · USDC</small></div> : <select value={fromChain} onChange={(e) => { setFromChain(Number(e.target.value)); setQuote(null); setBridgeEstimate(null); setBridgeRetryResult(null); }}>{bridgePeers.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select>}
                  </label>
                  <button type="button" className="route-reverse" aria-label="Reverse bridge direction" onClick={() => {
                    if (bridgeFromArc) { setFromChain(toChain === ARC.id ? bridgePeers[0].id : toChain); setToChain(ARC.id); }
                    else { setToChain(fromChain); setFromChain(ARC.id); }
                    setQuote(null); setBridgeEstimate(null); setBridgeRetryResult(null); setStatus("");
                  }}>⇄<small>Reverse</small></button>
                  <label>
                    To
                    {bridgeFromArc ? <select value={toChain} onChange={(e) => { setToChain(Number(e.target.value)); setQuote(null); setBridgeEstimate(null); setBridgeRetryResult(null); }}>{bridgePeers.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select> : <div className="fixed-chain"><b>Arc Testnet</b><small>Chain 5042002 · USDC</small></div>}
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
                        setQuote(null);
                        setCircleSwapEstimate(null);
                        setSwapRail(null);
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
                        setQuote(null);
                        setCircleSwapEstimate(null);
                        setSwapRail(null);
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
                    setQuote(null);
                    setCircleSwapEstimate(null);
                    setSwapRail(null);
                    setBridgeEstimate(null);
                    setBridgeRetryResult(null);
                  }}
                />
                <strong>{isSwap ? selectedFrom.symbol : "USDC"}</strong>
              </label>
              <div className="fee-strip">
                <span>{tab === "bridge" ? "Protocol fee" : "Route fees"}</span>
                <b>{tab === "bridge" ? "1.5% USDC" : "Shown in quote"}</b>
                <small>
                  {tab === "bridge"
                    ? `Atomic split inside the Circle route · Treasury ${short(FEE_TREASURY)}`
                    : "Aggregator, liquidity, and gas costs are included in the reviewed quote."}
                </small>
              </div>
              <div className="workspace-assurance">
                <span><i>✓</i><small>Network</small><b>{tab === "bridge" ? "Arc endpoint enforced" : "Arc Testnet only"}</b></span>
                <span><i>✓</i><small>Custody</small><b>Wallet-signed only</b></span>
                <span><i>✓</i><small>Protection</small><b>{quote || circleSwapEstimate ? "Minimum output locked" : bridgeEstimate ? "Bridge estimate reviewed" : "Quote before execution"}</b></span>
              </div>
              {tab === "bridge" && (
                <div className="bridge-finality">
                  <span><small>Source finality</small><b>Single confirmation on Arc</b></span>
                  <span><small>Attestation</small><b>Circle CCTP · typically minutes</b></span>
                  <span><small>Destination mint</small><b>Needs destination gas</b></span>
                </div>
              )}
              {isSwap && <div className="fee-strip"><span>Execution rail</span><b>{swapRail === "circle" ? "Circle Swap · permissionless" : swapRail === "fallback" ? "Fallback aggregator" : "Circle-first routing"}</b><small>No Kit Key or secret is shipped to the browser. Fallback activates only when Circle has no safe route.</small></div>}
              {isSwap && (
                <a className="fx-crosslink" href={navHref("fx", host) || "/fx"} target={navHref("fx", host) ? "_blank" : undefined} rel="noreferrer" onClick={(e) => { if (!navHref("fx", host)) { e.preventDefault(); chooseTab("fx"); } }}>
                  <b>Need USDC ⇄ EURC?</b>
                  <small>Use the StableCoin FX desk — one on-chain rate, no aggregator hop.</small>
                  <i aria-hidden="true">→</i>
                </a>
              )}
              {circleSwapEstimate && (
                <div className="quote circle-swap-estimate">
                  <span>Circle Swap estimate</span>
                  <strong>{circleSwapEstimate.output} {circleSwapEstimate.outputToken}</strong>
                  <small>Minimum {circleSwapEstimate.minimum} {circleSwapEstimate.outputToken} · slippage 0.5%</small>
                  <small>{circleSwapEstimate.fees.length ? circleSwapEstimate.fees.map((fee) => `${fee.type}: ${fee.amount} ${fee.token}`).join(" · ") : "No additional fee returned by Circle"}</small>
                </div>
              )}
              {quote && (
                <div className="quote">
                  <span>Expected receive</span>
                  <strong>
                    {receive} {quote.action.toToken.symbol}
                  </strong>
                  <small>
                    Minimum{" "}
                    {displayAmount(
                      quote.estimate.toAmountMin,
                      quote.action.toToken.decimals,
                    )}{" "}
                    · ≈ {quote.estimate.executionDuration}s · Arc Testnet route
                  </small>
                </div>
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
              {bridgeRetryResult && <div className="bridge-recovery-state"><b>Bridge recovery</b>{((bridgeRetryResult as { steps?: Array<{ name?: string; state?: string; txHash?: string }> }).steps || []).map((step, index) => <span key={`${step.name}-${index}`} className={step.state || "pending"}><i>{step.state === "success" ? "✓" : step.state === "error" ? "!" : "…"}</i><small>{step.name || `Step ${index + 1}`}</small><em>{step.state || "pending"}</em>{step.txHash && <a href={`${ARC.explorer}/tx/${step.txHash}`} target="_blank" rel="noreferrer">{short(step.txHash)} ↗</a>}</span>)}</div>}
              {tab === "bridge" && bridgeFromArc && bridgeRecoveryHash && <section className="bridge-hash-recovery"><b>Complete your previous bridge</b><p>Your Arc transaction already succeeded. Continue the final destination step only—your USDC will not be burned again.</p><button className="secondary" disabled={busy} onClick={() => void recoverCircleBurn()}>{busy ? "Completing bridge…" : "Complete previous bridge"}</button>{bridgeRecoveryStatus && <small>{bridgeRecoveryStatus}</small>}<details><summary>Transaction details</summary><code>{bridgeRecoveryHash}</code></details></section>}
              {status && <p className="status">{status}</p>}
              {bridgeRetryResult && <button className="secondary" disabled={busy} onClick={retryCircleBridge}>{busy ? "Recovering…" : "Resume pending bridge"}</button>}
              {!account ? (
                <button className="primary" onClick={() => connect()}>
                  Connect wallet
                </button>
              ) : tab === "bridge" && bridgeEstimate ? (
                <button className="primary" disabled={busy || !bridgeEstimate.destinationGas.ready} onClick={bridgeWithCircle}>
                  {busy ? "Waiting for Circle…" : bridgeEstimate.destinationGas.ready ? "Confirm bridge in wallet" : `Destination ${bridgeEstimate.destinationGas.symbol} required`}
                </button>
              ) : tab === "swap" && circleSwapEstimate ? (
                <button className="primary" disabled={busy} onClick={executeCircleSwap}>
                  {busy ? "Waiting for Circle…" : "Confirm Circle Swap"}
                </button>
              ) : !quote ? (
                <button
                  className="primary"
                  disabled={!canQuote || busy}
                  onClick={requestQuote}
                >
                  {busy
                    ? isSwap
                      ? "Finding route…"
                      : "Estimating Circle route…"
                    : isSwap
                      ? "Review route"
                      : "Review Circle estimate"}
                </button>
              ) : (
                <button className="primary" disabled={busy} onClick={execute}>
                  {busy ? "Waiting…" : "Confirm in wallet"}
                </button>
              )}
              <p className="fine">
                ARC never receives your keys. Route execution only happens after
                wallet confirmation.
              </p>
            </>
          </div>
        </section>
      )}
      </Suspense>

      {tab === "home" && <section className="cards">
        <article>
          <span>01</span>
          <h3>Notice it early</h3>
          <p>
            Sort the noise. Read the creator, contract, holders, curve, and live
            tape before you touch the buy button.
          </p>
        </article>
        <article>
          <span>02</span>
          <h3>Know the price</h3>
          <p>
            Quotes come from the curve—not a number typed into a dashboard.
            Review the outcome, then sign it from your own wallet.
          </p>
        </article>
        <article>
          <span>03</span>
          <h3>Earn the orbit</h3>
          <p>
            Start with the same rules as everyone else. At graduation, liquidity
            moves to the DEX and its ownership is burned.
          </p>
        </article>
      </section>}
      <footer>
        <strong>ARCODIAN © 2026</strong>
        <span>Markets should show their workings.</span>
        <button onClick={() => chooseTab("how")}>How it works</button>
        <button onClick={() => chooseTab("contracts")}>Contracts</button>
        <button onClick={() => chooseTab("faq")}>FAQ</button>
        <a href={ARC.explorer} target="_blank" rel="noreferrer">
          Explorer ↗
        </a>
      </footer>
      <nav className="mobile-dock" aria-label="Primary">
        <button className={tab === "home" ? "active" : ""} onClick={() => chooseTab("home")}><i aria-hidden="true">◉</i><span>Home</span></button>
        <button className={tab === "screener" ? "active" : ""} onClick={() => chooseTab("screener")}><i aria-hidden="true">◫</i><span>Markets</span></button>
        <button className="dock-create" onClick={openCreateStudio}><i aria-hidden="true">＋</i><span>Create</span></button>
        <button className={tab === "bridge" || tab === "swap" ? "active" : ""} onClick={() => chooseTab("bridge")}><i aria-hidden="true">⇄</i><span>Bridge</span></button>
        <button className={tab === "profile" ? "active" : ""} onClick={() => (account ? chooseProfile(account) : connect())}><i aria-hidden="true">◐</i><span>Profile</span></button>
      </nav>
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
  return <div className="ack-backdrop"><section className="ack-modal" role="dialog" aria-modal="true" aria-labelledby="ack-title"><div className="ack-mark"><BrandMark/></div><p className="kicker">Before entering the orbit</p><h2 id="ack-title">Testnet markets carry real risk—even when the assets do not carry real value.</h2><div className="ack-points"><span><b>Arc Testnet only</b><small>Test USDC and test tokens have no financial value.</small></span><span><b>Permissionless tokens</b><small>Anyone can create one. Verify contracts and social links yourself.</small></span><span><b>Wallet-signed actions</b><small>Transactions are public, final, and initiated only after your confirmation.</small></span></div>{expanded&&<div className="ack-expanded">{FAQ_ITEMS.slice(0,4).map(([q,a])=><p key={q}><strong>{q}</strong><span>{a}</span></p>)}</div>}<button className="ack-more" onClick={()=>setExpanded(v=>!v)}>{expanded?"Hide quick FAQ":"Read quick FAQ"}</button><label className="ack-check"><input type="checkbox" checked={checked} onChange={event=>setChecked(event.target.checked)}/><span>I understand this is Arc Testnet, tokens are permissionless, and I am responsible for reviewing every wallet transaction.</span></label><button className="primary ack-enter" disabled={!checked} onClick={accept}>Agree & enter Arcodian</button><small className="ack-local">Saved only in this browser. No personal acceptance record is sent to the server.</small></section></div>;
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
