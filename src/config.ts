export const ARC = {
  id: 5042002,
  hexId: "0x4cef52",
  name: "Arc Testnet",
  rpc: "https://rpc.testnet.arc.network/",
  rpcs: [
    "https://rpc.testnet.arc.network/",
    "https://rpc.blockdaemon.testnet.arc.io",
    "https://rpc.drpc.testnet.arc.io",
    "https://rpc.quicknode.testnet.arc.io",
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
  { id: 11155111, name: "Ethereum Sepolia", appKit: "Ethereum_Sepolia", symbol: "USDC", gasSymbol: "ETH", rpc: "https://rpc.sepolia.org", token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  { id: 421614, name: "Arbitrum Sepolia", appKit: "Arbitrum_Sepolia", symbol: "USDC", gasSymbol: "ETH", rpc: "https://sepolia-rollup.arbitrum.io/rpc", token: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  { id: 84532, name: "Base Sepolia", appKit: "Base_Sepolia", symbol: "USDC", gasSymbol: "ETH", rpc: "https://sepolia.base.org", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  { id: 43113, name: "Avalanche Fuji", appKit: "Avalanche_Fuji", symbol: "USDC", gasSymbol: "AVAX", rpc: "https://api.avax-test.network/ext/bc/C/rpc", token: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  { id: 11155420, name: "OP Sepolia", appKit: "Optimism_Sepolia", symbol: "USDC", gasSymbol: "ETH", rpc: "https://sepolia.optimism.io", token: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  { id: 80002, name: "Polygon Amoy", appKit: "Polygon_Amoy_Testnet", symbol: "USDC", gasSymbol: "POL", rpc: "https://rpc-amoy.polygon.technology", token: "0x41E94Eb019C0762f9BfcF9Fb1E58725BfB0e7582" },
  { id: ARC.id, name: ARC.name, appKit: "Arc_Testnet", symbol: "USDC", gasSymbol: "USDC", rpc: ARC.rpc, token: ARC.nativeToken },
] as const;

export const LIFI_API = "https://li.quest/v1";
export const INTEGRATOR = import.meta.env.VITE_LIFI_INTEGRATOR || "arc-markets";
export const PUBLIC_ORIGIN = import.meta.env.VITE_PUBLIC_ORIGIN || (typeof window !== "undefined" ? window.location.origin : "");
export const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";
export const FACTORY_ADDRESS = "0x40147884E6992cee1f7030d1263C692a4Cbae942";
// Canonical engine: ArcPumpSuiteV7 (V6 pull-fee vault + symmetric 30 bps
// buy/sell DEX fee — fixes the V6 25 bps sell asymmetry).
// Deployed 2026-07-18, tx 0xc856b982f9919434c33a40ff04ac6ac7f73974fa81348e305b5ecd854effba42.
export const PUMP_SUITE_ADDRESS = "0x59D8eDf019053c7D8fE48f906258960c092893AD";
export const PUMP_FACTORY_ADDRESS = "0x4D768da57277C1Ea6f74a4309cAFaFd21Bfc5774";
export const ARC_DEX_FACTORY_ADDRESS = "0xbA3Fa6d96D9bD1564B68cbf15A6EaCB90d0aEFE7";
export const ENGINE_VERSION = 7;
// V6 suite 0x8F4FAF89f3d6f2f4Ad535df7faF3B5787BA35020 / DEX 0xC933eCeb3Ca62f31E7DD1D2538e6cfE879c5bDdA
// and V5 suite 0x6601aD6C8a32cB5e1217d1304457e2C9F8778094 stay live for their
// historical markets; their pump factories index below.
export const LEGACY_PUMP_FACTORY_ADDRESSES = [
  "0x454529204A0B0846Cc0dF37CFdFf3De8541B36e4",
  "0xA26eD2d51264246f7dDF8EB33626e999E592c309",
  "0x450883D80e46D866c81dd64CAbE216071b2DB651",
  "0x4925Cd48Cae870730286e058a3c9020f2892eb6A",
  "0x7D0b32E57D0e52da3aac5E18c761029E7b179113",
] as const;
// USDC<->EURC FX pool (constant-product AMM over the 6-dec USDC ERC-20 interface
// and EURC). Powers the in-app FX widget. Deployed 2026-07-18.
// Permissionless USDC<->EURC AMM (ArcFxPoolV2). ERC-20 LP shares, 10 bps fee
// split 8 LP / 2 protocol, no owner and no privileged withdrawal — a provider's
// only exit is removeLiquidity, in proportion to their shares. Deployed
// 2026-07-18, replacing the owner-only v1 pool
// (0x09c2A629834a0fb0c559659214Cc1802bCE910FD, drained to zero on migration).
export const ARC_FX_POOL_ADDRESS = "0x982D61ddCAb6169d82B3e37A4E4158f1982E5447";
export const ARC_USDC_ERC20 = ARC.nativeToken; // USDC dual-interface ERC-20, 6 decimals
// Atomic USDC -> EURC-curve buy router. Deployed 2026-07-18. Immutable and
// ownerless: no owner, withdraw, pause or upgrade path, so the USDC allowance
// users grant it cannot be used by anyone to move their funds. A failing leg
// reverts the whole route, so a buyer is never stranded holding EURC.
// Redeployed 2026-07-18 against ArcFxPoolV2 — the router is immutable and
// hardcodes the pool address, so a new pool requires a new router. The prior
// deployment (0x218786BC01E6c401A5A7A514103a582D53C4a9C7) pointed at the v1 pool.
export const CROSS_BUY_ROUTER_ADDRESS = "0xF51DF463bb2Db8Fe1CfC5CCfB87D1b34B5AD9ef9";
export const ARC_EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
// EURC-collateral pump suite (QUOTE_KIND=1). Launches priced/settled in EURC
// (6 dec) instead of native USDC. Deployed 2026-07-18. Frontend create/trade
// wiring is quote-kind-aware; USDC (native) remains the default engine (V7).
export const EURC_PUMP_SUITE_ADDRESS = "0x4C08f5bB5ea7c20A150C8D515Fb5F53F47636C9d";
export const EURC_PUMP_FACTORY_ADDRESS = "0x73471B058a26b62CD0f77d5409d83de5c5A502AC";
export const EURC_DEX_FACTORY_ADDRESS = "0x70083bd737CF204fD5378CBF6c7fDf007383d289";
export const EURC_GRADUATION_THRESHOLD_6 = "4500000000"; // 4500 EURC, 6 decimals
// Permissionless AMM. Anyone may create a pair for any two ERC-20s at 10 bps
// (stable) or 30 bps (volatile); fees split 80% LP / 20% protocol. Pairs derive
// reserves from measured balances, so fee-on-transfer and rebasing tokens cannot
// corrupt their accounting. Deployed 2026-07-18. Not yet consumed by the UI —
// swap.arcodian.fun wiring is a separate plan.
export const ARC_PAIR_FACTORY_ADDRESS = "0x886694Bc4c5aCc545669E60a6694BA6a0B22d3bd";
export const ARC_ROUTER_ADDRESS = "0xF0EeeE998470Dd277eB5E9eEc1116b10C407f166";
export const FEE_TREASURY = "0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF";
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
export const SUBDOMAIN_FOR_TAB = {
  screener: "market",
  swap: "swap",
  bridge: "bridge",
  how: "docs",
} as const;
const TAB_FOR_SUBDOMAIN: Record<string, string> = {
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
