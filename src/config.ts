export const ARC = {
  id: 5042002,
  hexId: "0x4cef52",
  name: "Arc Testnet",
  // Reads go through a same-origin proxy: the public Arc RPCs 429 browsers under
  // load, but the VPS reaches them at 200 and the proxy rotates across all four.
  // Absolute URL so the web app, subdomains, and the native Android app all use it.
  rpc: "https://arcodian.fun/api/rpc.php",
  rpcs: [
    "https://arcodian.fun/api/rpc.php",
    ...(import.meta.env.VITE_ARC_RPC_FALLBACKS || "").split(",").map((url: string) => url.trim()).filter(Boolean),
  ],
  explorer: "https://testnet.arcscan.app",
  faucet: "https://faucet.circle.com",
  nativeToken: "0x3600000000000000000000000000000000000000",
  nativeSymbol: "USDC",
  nativeDecimals: 18,
  erc20Decimals: 6,
} as const;

export const TOKENS = [
  { symbol: "USDC", name: "USD Coin", address: ARC.nativeToken, decimals: 6 },
  { symbol: "EURC", name: "Euro Coin", address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", decimals: 6 },
] as const;

export const CHAINS = [
  { id: 11155111, name: "Ethereum Sepolia", appKit: "Ethereum_Sepolia", symbol: "USDC", gasSymbol: "ETH", rpc: "https://ethereum-sepolia-rpc.publicnode.com", token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  { id: 421614, name: "Arbitrum Sepolia", appKit: "Arbitrum_Sepolia", symbol: "USDC", gasSymbol: "ETH", rpc: "https://sepolia-rollup.arbitrum.io/rpc", token: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  { id: 84532, name: "Base Sepolia", appKit: "Base_Sepolia", symbol: "USDC", gasSymbol: "ETH", rpc: "https://sepolia.base.org", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  { id: 43113, name: "Avalanche Fuji", appKit: "Avalanche_Fuji", symbol: "USDC", gasSymbol: "AVAX", rpc: "https://api.avax-test.network/ext/bc/C/rpc", token: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  { id: 11155420, name: "OP Sepolia", appKit: "Optimism_Sepolia", symbol: "USDC", gasSymbol: "ETH", rpc: "https://sepolia.optimism.io", token: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  { id: 80002, name: "Polygon Amoy", appKit: "Polygon_Amoy_Testnet", symbol: "USDC", gasSymbol: "POL", rpc: "https://polygon-amoy-bor-rpc.publicnode.com", token: "0x41E94Eb019C0762f9BfcF9Fb1E58725BfB0e7582" },
  { id: ARC.id, name: ARC.name, appKit: "Arc_Testnet", symbol: "USDC", gasSymbol: "USDC", rpc: ARC.rpc, token: ARC.nativeToken },
] as const;

export const PUBLIC_ORIGIN = import.meta.env.VITE_PUBLIC_ORIGIN || (typeof window !== "undefined" ? window.location.origin : "");
export const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";
export const ARC_PAY_ADDRESS = import.meta.env.VITE_ARC_PAY_ADDRESS || "";
export const ARC_LEND_ADDRESS = import.meta.env.VITE_ARC_LEND_ADDRESS || "";
export const ARC_LEND_COLLATERAL_ADDRESS = import.meta.env.VITE_ARC_LEND_COLLATERAL_ADDRESS || "";
export const AGENT_PAY_ADDRESS = "0xBEB0D78FD10474eb9Ef27D24600bACe9A1F13026";
export const AGENT_PAY_FACTORY_ADDRESS = import.meta.env.VITE_AGENT_PAY_FACTORY_ADDRESS || "";
// ERC-8004 Agent Passport (Phase A) — Arc Testnet 5042002, verified on-chain 2026-07-24.
export const IDENTITY_REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const AGENT_PASSPORT_ADDRESS = "0xDaCEF31ca7C5B1cebB5516f541cfF05E17eC2cCf";
export const AGENT_PAY_V3_FACTORY_ADDRESS = "0xE39bae31254C45151ABd9dC53dA3C0c92B529Ad5";
export const AGENT_METADATA_ENDPOINT = "https://arcodian.fun/api/agent-metadata.php";
export const IDENTITY_REGISTRY_ABI = ["function register(string metadataURI) returns(uint256)","function ownerOf(uint256) view returns(address)","function tokenURI(uint256) view returns(string)","event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"];
export const AGENT_PASSPORT_ABI = ["function walletOf(uint256) view returns(address)","function agentIdOf(address) view returns(uint256)","function ownerOfAgent(uint256) view returns(address)","function bindWallet(uint256,address)","function unbind(uint256)","event WalletBound(uint256 indexed agentId,address indexed oldWallet,address indexed newWallet,address owner)"];
export const AGENT_PAY_V3_VAULT_ABI = ["function owner() view returns(address)","function policies(uint256) view returns(uint128 perPayment,uint128 dailyLimit,uint128 spentToday,uint64 validUntil,uint32 spendDay,bool enabled)","function merchantAllowed(uint256,address) view returns(bool)","function setPolicy(uint256,uint128,uint128,uint64,bool)","function setMerchant(uint256,address,bool)","function payInvoice(bytes32,address,uint256,uint64,bytes32)","function withdraw(address,uint256)"];
export const AGENT_PAY_V3_FACTORY_ABI = ["function arcPay() view returns(address)","function passport() view returns(address)","function vaultOf(address) view returns(address)","function vaultCount() view returns(uint256)","function createVault() payable returns(address)"];
// Phase B — Agent Jobs (outcome-based USDC escrow, shared multi-tenant registry).
export const AGENT_JOBS_ADDRESS = "0x3ceb2eb2fdf41396e20cc55b9096933d208ba8a6";
export const JOB_METADATA_ENDPOINT = "https://arcodian.fun/api/job-metadata.php";
export const AGENT_JOBS_ABI = ["function createJob(address provider,address evaluator,uint64 expiry,bytes32 descHash,uint256 providerAgentId) payable returns(uint256)","function submit(uint256 jobId,bytes32 deliverableHash)","function evaluate(uint256 jobId,bool approve,bytes32 evidenceHash)","function reclaimExpired(uint256 jobId)","function jobs(uint256) view returns(address client,address provider,address evaluator,uint128 budget,uint64 expiry,uint8 status,bytes32 descHash,bytes32 deliverableHash,uint256 providerAgentId)","function jobCount() view returns(uint256)","function arcPay() view returns(address)","event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 budget,uint64 expiry,bytes32 descHash,uint256 providerAgentId)","event JobSubmitted(uint256 indexed jobId,bytes32 deliverableHash)","event JobCompleted(uint256 indexed jobId,address indexed provider,uint256 budget,uint256 providerAgentId,bytes32 evidenceHash)","event JobRejected(uint256 indexed jobId,address indexed client,uint256 budget,bytes32 evidenceHash)","event JobExpired(uint256 indexed jobId,address indexed client,uint256 budget)"];
// Optional server-side aggregator bridge. The endpoint keeps provider credentials
// off the client and returns a normalized, executable quote. Execution and
// allowance targets are rejected unless explicitly allowlisted.
export const FX_AGGREGATOR_QUOTE_URL = import.meta.env.VITE_FX_AGGREGATOR_QUOTE_URL || "";
export const FX_AGGREGATOR_ALLOWED_TARGETS = (import.meta.env.VITE_FX_AGGREGATOR_ALLOWED_TARGETS || "")
  .split(",").map((value: string) => value.trim()).filter(Boolean);
// ---------------------------------------------------------------------------
// CANONICAL STACK — engine v9, Arc Testnet 5042002.
//
// Exactly one set of addresses is canonical at a time, and it is this one.
// Anything retired lives in RETIRED_DEPLOYMENTS below as data, never as an
// export, so a stale address cannot be imported by mistake at deploy time.
//
// Engine v9 preserves the curve price at graduation by burning excess unsold
// inventory before seeding ArcPair. The launch factory is the stack root.
// ---------------------------------------------------------------------------
export const ENGINE_VERSION = 9;
export const PUMP_FACTORY_ADDRESS = "0x0604f54450565B393e8F52078a28F260845e3064";

/// Superseded deployments. Recorded so history stays readable and so nothing
/// here can be mistaken for the live stack. Do not export these individually;
/// if one is needed again, promote it deliberately.
export const RETIRED_DEPLOYMENTS = {
  v7: {
    suite: "0x59D8eDf019053c7D8fE48f906258960c092893AD",
    pumpFactory: "0x4D768da57277C1Ea6f74a4309cAFaFd21Bfc5774",
    dexFactory: "0xbA3Fa6d96D9bD1564B68cbf15A6EaCB90d0aEFE7",
    retired: "2026-07-19",
    note: "Graduated into its own DEX. Superseded by v8 graduating into ArcPair.",
  },
  v6: {
    suite: "0x8F4FAF89f3d6f2f4Ad535df7faF3B5787BA35020",
    dexFactory: "0xC933eCeb3Ca62f31E7DD1D2538e6cfE879c5bDdA",
    retired: "2026-07-18",
    note: "Asymmetric 25 bps sell fee; fixed in v7.",
  },
  v5: { suite: "0x6601aD6C8a32cB5e1217d1304457e2C9F8778094", retired: "2026-07-18" },
  launchpad: { factory: "0x40147884E6992cee1f7030d1263C692a4Cbae942" },
  eurc: {
    suite: "0x4C08f5bB5ea7c20A150C8D515Fb5F53F47636C9d",
    pumpFactory: "0x73471B058a26b62CD0f77d5409d83de5c5A502AC",
    dexFactory: "0x70083bd737CF204fD5378CBF6c7fDf007383d289",
    retired: "2026-07-19",
    note: "Graduated into a private EURC DEX. Superseded by the EURC v8 factory graduating into ArcPair.",
  },
  // The first hub-less graduation stack, live for one day. Nothing graduated on
  // it and its pair registry stayed empty, so nothing needed migrating.
  v8PreHub: {
    pumpFactory: "0x978eB4e63f2Eabf23FB984BBdAB291f29862dB8d",
    pairFactory: "0x4067adb8499a2f4329B7eF285F9211cc882f4d37",
    router: "0x3681d045a79A3290F3228575D99f26cB057b39d2",
    retired: "2026-07-19",
    note: "Its one-time authority slot was spent on the USDC factory, locking EURC out.",
  },
  pairFactoryV1: "0x886694Bc4c5aCc545669E60a6694BA6a0B22d3bd",
  routerV1: "0xF0EeeE998470Dd277eB5E9eEc1116b10C407f166",
  fxPoolV1: "0x09c2A629834a0fb0c559659214Cc1802bCE910FD",
  crossBuyRouterV1: "0x218786BC01E6c401A5A7A514103a582D53C4a9C7",
} as const;
// Retired testnet factories remain documented above but are deliberately not
// rendered in canonical market/profile surfaces after the v9 reset.
export const LEGACY_PUMP_FACTORY_ADDRESSES: readonly string[] = [];
// Permissionless USDC<->EURC AMM (ArcFxPoolV2). Powers the FX widget. ERC-20 LP shares, 10 bps fee
// split 8 LP / 2 protocol, no owner and no privileged withdrawal — a provider's
// only exit is removeLiquidity, in proportion to their shares. Deployed
// 2026-07-18, replacing the owner-only v1 pool
// (0x09c2A629834a0fb0c559659214Cc1802bCE910FD, drained to zero on migration).
export const ARC_FX_POOL_ADDRESS = "0x982D61ddCAb6169d82B3e37A4E4158f1982E5447";
export const ARC_USDC_ERC20 = ARC.nativeToken; // USDC dual-interface ERC-20, 6 decimals
// Atomic USDC -> EURC-curve buy router. Immutable and ownerless: no owner,
// withdraw, pause or upgrade path, so the USDC allowance users grant it cannot
// be used by anyone to move their funds. A failing leg reverts the whole route,
// so a buyer is never stranded holding EURC.
// Deployed 2026-07-18 against ArcFxPoolV2 — the router is immutable and
// hardcodes the pool address, so a new pool requires a new router. The prior
// deployment (0x218786BC01E6c401A5A7A514103a582D53C4a9C7) pointed at the v1 pool.
export const CROSS_BUY_ROUTER_ADDRESS = "0xF51DF463bb2Db8Fe1CfC5CCfB87D1b34B5AD9ef9";
export const ARC_EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
// EURC-collateral pump factory (QUOTE_KIND=1). Launches priced and settled in
// EURC (6 dec) instead of native USDC. Deployed 2026-07-18. Create/trade wiring
// is quote-kind-aware; native USDC remains the default engine.
//
// Since 2026-07-19 EURC graduates into ArcPair, like USDC — the v7-era suite
// (0x73471B058a26b62CD0f77d5409d83de5c5A502AC) graduated into a private EURC
// DEX nothing else could route through, and is retired.
export const EURC_PUMP_FACTORY_ADDRESS = "0xcEBdF68043b73cff75c4ea5872A24a4998B51774";
export const EURC_GRADUATION_THRESHOLD_6 = "4500000000"; // 4500 EURC, 6 decimals
// Permissionless AMM. Anyone may create a pair for any two ERC-20s at 10 bps
// (stable) or 30 bps (volatile); fees split 80% LP / 20% protocol. Pairs derive
// reserves from measured balances, so fee-on-transfer and rebasing tokens cannot
// corrupt their accounting. Deployed 2026-07-18; powers swap.arcodian.fun.
// ArcPairFactoryV2 — as V1, plus one rule: while a launchpad token's curve is
// running, only that curve may open its pair. Without it graduation is
// stealable, since the pair address is fixed by (token, quote, tier) and could
// be seeded at a bad ratio in advance. V1 (0x886694Bc4c5aCc545669E60a6694BA6a0B22d3bd)
// is superseded; its registry was empty, so nothing was migrated.
//
// This is the second V2 instance. The first
// (0x4067adb8499a2f4329B7eF285F9211cc882f4d37) was sound but spent: its
// one-time authority slot went to the USDC pump factory, so the EURC launchpad
// could never register. Replaced while the registry still held zero pairs,
// which is the only cheap moment to do it. Deployed 2026-07-19.
export const ARC_PAIR_FACTORY_ADDRESS = "0x4B71169F63A36d819421F10C0436A6A7d3C7253f";
// One graduation authority standing in front of both pump factories, so USDC
// and EURC launches land in the same pool registry instead of two. Sealed at
// deployment with exactly two members; membership can never change.
export const ARC_GRADUATION_HUB_ADDRESS = "0x39e146c99a774d7213Cc95F51C8Db7c2a3Ff7c43";
// Router bound to the current factory. Each router hardcodes its factory, so a
// factory change forces a new router; the prior ones were
// 0xF0EeeE998470Dd277eB5E9eEc1116b10C407f166 and
// 0x3681d045a79A3290F3228575D99f26cB057b39d2.
export const ARC_ROUTER_ADDRESS = "0xa0da11008439829A37e01d0B9973F9199bB59DC2";
export const FEE_TREASURY = "0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF";
// External FX routes charge five basis points (0.05%) on the server/provider
// side. Quotes are compared after this fee. Revenue is reserved for paired,
// protocol-owned USDC/EURC liquidity rather than deposited one-sided.
export const FX_AGGREGATOR_FEE_BPS = 5;
export const BRIDGE_FEE_BPS = 150;
export const SWAP_FEE_BPS = 30;
export const CURVE_FEE_BPS = 100;

// Mainnet deployment stays absent from the DOM until every value is explicitly
// supplied at release time. Never give these defaults a live chain/address.
export const MAINNET_DEPLOY = {
  enabled: import.meta.env.VITE_ENABLE_MAINNET_DEPLOY === "true",
  chainId: Number(import.meta.env.VITE_MAINNET_CHAIN_ID || 0),
  rpcUrl: import.meta.env.VITE_MAINNET_RPC_URL || "",
  explorerUrl: import.meta.env.VITE_MAINNET_EXPLORER_URL || "",
  usdcAddress: import.meta.env.VITE_MAINNET_USDC_ADDRESS || "",
  deployer: (import.meta.env.VITE_MAINNET_DEPLOYER || "").toLowerCase(),
  treasury: import.meta.env.VITE_MAINNET_TREASURY || "",
  threshold: import.meta.env.VITE_MAINNET_GRADUATION_THRESHOLD || "4500",
  treasuryMultisig: import.meta.env.VITE_MAINNET_TREASURY_MULTISIG_VERIFIED === "true",
  auditSignedOff: import.meta.env.VITE_MAINNET_AUDIT_SIGNED_OFF === "true",
  canarySignedOff: import.meta.env.VITE_MAINNET_CANARY_SIGNED_OFF === "true",
} as const;
export const V5_TESTNET_DEPLOY = {
  enabled: import.meta.env.VITE_ENABLE_V5_TESTNET_DEPLOY === "true",
  deployer: (import.meta.env.VITE_V5_DEPLOYER || "").toLowerCase(),
  treasury: import.meta.env.VITE_V5_TREASURY || FEE_TREASURY,
  threshold: "4500",
} as const;

export const BRIDGE_TESTNETS = [
  "Arc Testnet", "Ethereum Sepolia", "Arbitrum Sepolia", "Base Sepolia",
  "Avalanche Fuji", "OP Sepolia", "Polygon Amoy", "Solana Devnet",
] as const;

// --- Subdomain routing ------------------------------------------------------
// One SPA is deployed to every docroot. The hostname decides the default view;
// nav links that point at a different subdomain render as real anchors so they
// open that subdomain (in a new tab). Localhost / preview hosts route in-SPA so
// development keeps working without DNS.
export const BASE_DOMAIN = "arcodian.fun";
// Flip to "true" (VITE_SUBDOMAINS_LIVE) only once the swap/bridge/market/docs
// aaPanel sites exist and receive the build. Until then nav links stay in-SPA so
// the single live arcodian.fun docroot never ships a dead cross-subdomain link.
export const SUBDOMAINS_LIVE = import.meta.env.VITE_SUBDOMAINS_LIVE === "true";
// tab -> subdomain label. Home + fx have no subdomain (they live on the base host).
const SUBDOMAIN_FOR_TAB = {
  wallet: "wallet",
  screener: "market",
  swap: "swap",
  bridge: "bridge",
  how: "docs",
} as const;
const TAB_FOR_SUBDOMAIN: Record<string, string> = {
  wallet: "wallet",
  lend: "wallet",
  market: "screener",
  swap: "swap",
  bridge: "bridge",
  docs: "how",
};
function isBaseHostFamily(hostname: string): boolean {
  return hostname === BASE_DOMAIN || hostname.endsWith(`.${BASE_DOMAIN}`);
}
// The leading label of the current host, or "" for the apex / non-arcodian hosts.
export function currentSubdomain(hostname: string): string {
  if (!isBaseHostFamily(hostname)) return "";
  const rest = hostname.slice(0, hostname.length - BASE_DOMAIN.length).replace(/\.$/, "");
  const label = rest.split(".").filter(Boolean).pop() || "";
  return label === "www" ? "" : label;
}
// Default tab implied by a hostname (null = fall through to path routing).
export function subdomainTab(hostname: string): string | null {
  const label = currentSubdomain(hostname);
  return label ? TAB_FOR_SUBDOMAIN[label] || null : null;
}
// Absolute URL for a nav tab when it lives on a *different* subdomain than the
// current host; null means the tab is reachable in-SPA on the current host.
export function navHref(tab: string, hostname: string, live: boolean = SUBDOMAINS_LIVE): string | null {
  if (!live) return null; // subdomains not deployed yet: keep everything in-SPA
  if (!isBaseHostFamily(hostname)) return null; // dev / preview: stay in-SPA
  const target = (SUBDOMAIN_FOR_TAB as Record<string, string>)[tab];
  const here = currentSubdomain(hostname);
  if (!target) return here ? `https://${BASE_DOMAIN}/${tab === "screener" ? "market" : tab}` : null;
  if (target === here) return null; // already on this subdomain
  return `https://${target}.${BASE_DOMAIN}/`;
}
