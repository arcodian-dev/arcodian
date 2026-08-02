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

// Arc Mainnet's native-USDC ERC-20 view precompile lives at the exact same
// fixed address as testnet (0x3600...0000, confirmed by direct probe
// 2026-07-30) — no separate mainnet USDC constant needed. EURC has no
// published mainnet address yet, so it's the only pinned mainnet token.
export const MAINNET_TOKENS = [
  { symbol: "USDC", name: "USD Coin", address: ARC.nativeToken, decimals: 6 },
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
// ArcLendV2 — Compound/Aave-style utilization interest curve (1% base, +10%
// to an 80% kink, then a steep +200% jump slope above it) on a real
// ArcPythOracle EUR/USD feed. What looked like a stale/broken Pyth feed
// (~2026-07-24) was actually the feed's normal behavior: EUR/USD is a
// traditional-FX instrument that only publishes during NY market hours and
// goes fully quiet the whole weekend (confirmed against Hermes' own schedule
// metadata and by watching it resume seconds after the Sunday reopen). The
// real bug was ArcLendV2's own 1-hour MAX_ORACLE_AGE constant, incompatible
// with any feed that has a multi-hour scheduled gap — every weekend would
// have reverted OracleStale() on every new borrow and collateral-sensitive
// check. Fixed by making the staleness window a per-market immutable
// (`maxOracleAge`, this deployment: 90 hours — covers the ~48h weekend plus
// holiday/downtime buffer) instead of a shared constant. Caps raised to
// 50,000/25,000 USDC (from the "0xAe24C7..." canary deploy's overly tight
// 100/50 — RETIRED_DEPLOYMENTS.arcLendManualOracleV1). Was also never
// actually wired here before this session — VITE_ARC_LEND_ADDRESS was never
// set in any env file, so the interactive /lend page had no live contract.
export const ARC_LEND_ADDRESS = "0x571493d389862c2AF13985357b11916E5E54365d";
export const ARC_LEND_COLLATERAL_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"; // EURC
export const ARC_LEND_ORACLE_ADDRESS = "0xBbCE55016E46b97d3a44ff3a3ac557A42Ea30E4C"; // ArcPythOracle, real feed
export const AGENT_PAY_ADDRESS = "0xBEB0D78FD10474eb9Ef27D24600bACe9A1F13026";
export const AGENT_PAY_FACTORY_ADDRESS = import.meta.env.VITE_AGENT_PAY_FACTORY_ADDRESS || "";
// ERC-8004 Agent Passport (Phase A) — Arc Testnet 5042002, verified on-chain 2026-07-24.
export const IDENTITY_REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const AGENT_PASSPORT_ADDRESS = "0xDaCEF31ca7C5B1cebB5516f541cfF05E17eC2cCf";
// V4 factory/vault template (2026-07-27): V3 only checked the passport's
// CURRENT wallet binding for an agentId at payment time, which stays valid
// even after the agentId's real Identity Registry ownership has moved on —
// nobody's forced to call bindWallet/unbind on a sale. V4 additionally
// requires the vault owner to still be the agentId's current registry owner
// (checked at both setPolicy and payInvoice), so a sold agentId's policies
// go inert on their own instead of silently keeping a stale wallet's spend
// authority alive. Old V3 vaults keep working as before (immutable, no
// forced migration) — this is the template for new ones only.
export const AGENT_PAY_V3_FACTORY_ADDRESS = "0x8F4Ba684C7c294DF3Af50AC023975F6695CA4299";
export const AGENT_METADATA_ENDPOINT = "https://arcodian.fun/api/agent-metadata.php";
export const IDENTITY_REGISTRY_ABI = ["function register(string metadataURI) returns(uint256)","function ownerOf(uint256) view returns(address)","function tokenURI(uint256) view returns(string)","event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"];
export const AGENT_PASSPORT_ABI = ["function walletOf(uint256) view returns(address)","function agentIdOf(address) view returns(uint256)","function ownerOfAgent(uint256) view returns(address)","function bindWallet(uint256,address)","function unbind(uint256)","event WalletBound(uint256 indexed agentId,address indexed oldWallet,address indexed newWallet,address owner)"];
export const AGENT_PAY_V3_VAULT_ABI = ["function owner() view returns(address)","function policies(uint256) view returns(uint128 perPayment,uint128 dailyLimit,uint128 spentToday,uint64 validUntil,uint32 spendDay,bool enabled)","function merchantAllowed(uint256,address) view returns(bool)","function setPolicy(uint256,uint128,uint128,uint64,bool)","function setMerchant(uint256,address,bool)","function payInvoice(bytes32,address,uint256,uint64,bytes32)","function withdraw(address,uint256)"];
export const AGENT_PAY_V3_FACTORY_ABI = ["function arcPay() view returns(address)","function passport() view returns(address)","function vaultOf(address) view returns(address)","function vaultCount() view returns(uint256)","function createVault() payable returns(address)"];
// Phase B — Agent Jobs (outcome-based USDC escrow, shared multi-tenant registry).
// Redeployed 2026-07-27: the prior version let a client name themselves (or
// the provider) as evaluator, defeating the whole point of a neutral
// evaluator — a client could unilaterally reject legitimate work, or a
// provider could self-approve. createJob now reverts SelfDealing() for
// either case. Old contract (RETIRED_DEPLOYMENTS.agentJobsV2SelfDealing) had
// exactly 2 jobs ever created on testnet; not migrated, still readable
// directly on-chain, just not reachable through this app's /job/:id route.
export const AGENT_JOBS_ADDRESS = "0xfFdb3EC041DC1Cad062F0F80FF1a6F8292f21Df2";
export const JOB_METADATA_ENDPOINT = "https://arcodian.fun/api/job-metadata.php";
export const AGENT_JOBS_ABI = ["function createJob(address provider,address evaluator,uint64 expiry,bytes32 descHash,uint256 providerAgentId) payable returns(uint256)","function submit(uint256 jobId,bytes32 deliverableHash)","function evaluate(uint256 jobId,bool approve,bytes32 evidenceHash)","function reclaimExpired(uint256 jobId)","function jobs(uint256) view returns(address client,address provider,address evaluator,uint128 budget,uint64 expiry,uint8 status,bytes32 descHash,bytes32 deliverableHash,uint256 providerAgentId)","function jobCount() view returns(uint256)","function arcPay() view returns(address)","event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 budget,uint64 expiry,bytes32 descHash,uint256 providerAgentId)","event JobSubmitted(uint256 indexed jobId,bytes32 deliverableHash)","event JobCompleted(uint256 indexed jobId,address indexed provider,uint256 budget,uint256 providerAgentId,bytes32 evidenceHash)","event JobRejected(uint256 indexed jobId,address indexed client,uint256 budget,bytes32 evidenceHash)","event JobExpired(uint256 indexed jobId,address indexed client,uint256 budget)"];
// Phase C — official ERC-8004 Reputation + Validation registries (both wired to the Identity Registry).
// Read paths are view-by-agentId (getClients -> getLastIndex -> readFeedback), confirmed on-chain 2026-07-25.
export const REPUTATION_REGISTRY_ADDRESS = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const VALIDATION_REGISTRY_ADDRESS = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";
export const REPUTATION_ENDPOINT = "https://arcodian.fun/developers/reputation.json";
// Phase F4/F5 operational-hardening spikes (Arc Testnet). Enforced scoped delegation
// at execution time, and governed timelock administration. Not audited / not mainnet.
export const SESSION_KEY_ACCOUNT_ADDRESS = "0x06e26288AeC908c926A8e2466d9543e997f59d7C";
// Redeployed 2026-07-27: transferAdmin() was a single unchecked step with no
// zero-address guard (unlike its sibling setProposer/setExecutor) — a typo'd
// or unreachable new-admin address permanently bricked admin control. Now a
// two-step propose/accept (transferAdmin sets pendingAdmin, only that address
// can call acceptAdmin), plus a separate explicit renounceAdmin() so giving
// up control is never a side effect of a mistake. Live-proven both halves:
// proposed to a burn address (admin unaffected, unacceptable by anyone),
// then a real propose->accept round-trip.
export const ADMIN_TIMELOCK_ADDRESS = "0x8baC8017081134f02065fFefa340837278C03052";
export const ARCODIAN_MCP_ENDPOINT = "https://arcodian.fun/mcp";
// Signatures verified on-chain 2026-07-25 by decoding a live giveFeedback tx + raw readFeedback returns:
// giveFeedback takes (int128 score, uint8 decimals) then 4 strings + filehash; readFeedback surfaces
// only (int128 score, uint8 decimals, tag1, tag2, isRevoked) — endpoint/fileuri/filehash are write-only.
export const REPUTATION_REGISTRY_ABI = ["function getIdentityRegistry() view returns(address)","function getClients(uint256 agentId) view returns(address[])","function getLastIndex(uint256 agentId,address client) view returns(uint64)","function readFeedback(uint256 agentId,address client,uint64 index) view returns(int128 score,uint8 decimals,string tag1,string tag2,bool isRevoked)","function giveFeedback(uint256 agentId,int128 score,uint8 decimals,string tag1,string tag2,string endpoint,string fileuri,bytes32 filehash)"];
// validationRequest is authorized to the AGENT OWNER only (verified on-chain: client got "Not authorized",
// agent owner succeeded). validationResponse is called by the requested validator. Signatures confirmed by
// resolving the proxy implementation's selectors 2026-07-25.
export const VALIDATION_REGISTRY_ABI = ["function getIdentityRegistry() view returns(address)","function getAgentValidations(uint256 agentId) view returns(bytes32[])","function getValidationStatus(bytes32 dataHash) view returns(address validator,uint256 agentId,uint8 response,uint256 lastUpdate)","function validationRequest(address validatorAddress,uint256 agentId,string requestUri,bytes32 dataHash)","function validationResponse(bytes32 dataHash,uint8 response,string responseUri,bytes32 responseHash,string tag)"];
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
// Engine v10 is a graduation-threshold migration, not an economics change:
// same ArcPumpV8 curve math, same 1% (100 bps) curve fee, same ArcPair 0.30%
// post-graduation swap fee. Only the net collateral raise required to
// graduate moved from 4,500 to 12,000 (USDC and EURC alike). The threshold is
// immutable per suite, and the graduation authority is a hub sealed with
// exactly two members at deploy time (see ARC_GRADUATION_HUB_ADDRESS below),
// so raising it can only be done by standing up a new hub + pair registry +
// both pump factories together — never by mutating the live ones.
export const ENGINE_VERSION = 10;
export const PUMP_FACTORY_ADDRESS = "0x453a38aB960137e0294665d7C5A1BC0B1C41b9cc";
export const GRADUATION_THRESHOLD_18 = "12000000000000000000000"; // 12,000 USDC, 18 decimals

/// Superseded deployments. Recorded so history stays readable and so nothing
/// here can be mistaken for the live stack. Do not export these individually;
/// if one is needed again, promote it deliberately.
export const RETIRED_DEPLOYMENTS = {
  v9: {
    pumpFactory: "0x0604f54450565B393e8F52078a28F260845e3064",
    pairFactory: "0x4B71169F63A36d819421F10C0436A6A7d3C7253f",
    hub: "0x39e146c99a774d7213Cc95F51C8Db7c2a3Ff7c43",
    router: "0xa0da11008439829A37e01d0B9973F9199bB59DC2",
    eurcPumpFactory: "0xcEBdF68043b73cff75c4ea5872A24a4998B51774",
    retired: "2026-07-26",
    note: "4,500 threshold. Graduated pairs here stay tradable forever (LP burned); only new launches moved to the v10 hub. Source predates this checkout and was reconstructed as ArcPumpV8 for the v10 migration — the exact v9 bytecode (a graduation-price-preserving tweak over v8) could not be recovered, so v10 intentionally reuses the audited, in-repo v8 curve rather than guess at unverified math.",
  },
  v9MistakenDeploy: {
    suite: "0x02Cc1A1a94f0733C747ff48110faa05751f44106",
    note: "Deployed against the wrong (self-contained ArcPump.sol) engine while diagnosing the threshold migration — its ArcDexPair uses buy()/sell(), incompatible with the frontend's post-graduation swap()/token0()/reserve0/1() calls. Never wired into any config; zero launches created on it.",
  },
  arcLendPythV1: {
    market: "0x2f2cC1a11C75B493ea7c8f44e34a88FB5C121637",
    oracle: "0xBbCE55016E46b97d3a44ff3a3ac557A42Ea30E4C",
    retired: "2026-07-26",
    note: "Fixed-APR market (immutable ratePerSecond, no utilization response). Held zero deposits and zero borrows at migration time — nothing to wind down. Superseded by ArcLendV2's utilization curve. Its ArcPythOracle (same address, reused by the current ArcLendV2) was always correctly wired; the market itself was just never deployed with a rate that responded to demand.",
  },
  arcLendManualOracleV1: {
    market: "0xAe24C79632f7B83811102EdFB1f0710AeCBC7B03",
    oracle: "0x63951B73cD71Fbad20a68656a75bbb5dea68ccF3",
    retired: "2026-07-27",
    note: "First ArcLendV2 deploy, ~4 hours live. Two problems, both fixed in the current deployment rather than papered over: (1) supply/borrow caps of 100/50 USDC were too tight to test realistically; (2) it ran on ArcManualOracle believing Pyth's EUR/USD feed was broken — it wasn't. EUR/USD is a traditional-FX instrument that only publishes during NY market hours and goes fully quiet the whole weekend; the feed was fine, it was ArcLendV2's fixed 1-hour MAX_ORACLE_AGE constant that couldn't tolerate a multi-hour scheduled gap. Withdrawn to zero deposits/zero debt before retiring; nothing needed winding down for anyone else.",
  },
  agentJobsV2SelfDealing: {
    contract: "0x33f54C516107A8c67d9Dc245f00E253132a6D15A",
    retired: "2026-07-27",
    note: "createJob() allowed evaluator == client or evaluator == provider — a client could unilaterally reject legitimate work, or a provider could self-approve their own delivery. Fixed by rejecting both at creation (SelfDealing()). Exactly 2 jobs were ever created; not migrated, still directly readable on-chain, just not reachable through /job/:id anymore.",
  },
  adminTimelockOneStepTransfer: {
    contract: "0xefd956531dc0585d412d6fa4afcb8d940aa2b4ac",
    retired: "2026-07-27",
    note: "transferAdmin() changed the admin in one unchecked step, with no zero-address guard (its sibling setProposer/setExecutor both have one) — a typo'd or unreachable address permanently bricked admin control. Fixed with a two-step propose/accept pattern plus a separate explicit renounceAdmin(). This was always an F5 'spike' (deployer as admin/proposer/executor, not audited, not mainnet) — no real governance handoff had happened on it.",
  },
  agentPayFactoryV3Staleness: {
    factory: "0xE39bae31254C45151ABd9dC53dA3C0c92B529Ad5",
    note: "V3 vaults only check the passport's current wallet binding at payment time, which stays valid even after the agentId's real Identity Registry ownership has moved on (nobody's forced to call bindWallet/unbind on a sale) — a stale binding can keep spend authority alive against the PREVIOUS owner's vault indefinitely. V4 additionally requires the vault owner to still be the agentId's current registry owner, checked at both setPolicy and payInvoice, so a sold agentId's old policies go inert on their own. Not retired — existing V3 vaults keep working exactly as before (immutable, no forced migration); V4 is only the template for new vaults going forward.",
  },
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
export const EURC_PUMP_FACTORY_ADDRESS = "0x171033cA9A61C71A73e0f68FfA3BEEFFEA44f2ef";
export const EURC_GRADUATION_THRESHOLD_6 = "12000000000"; // 12,000 EURC, 6 decimals
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
// Third V2 instance. The second (0x4B71169F63A36d819421F10C0436A6A7d3C7253f)
// is superseded by the v10 threshold migration below — its hub was sealed to
// the two 4,500-threshold factories, and a sealed hub's membership can never
// change, so raising the threshold required a new hub + registry rather than
// a parameter change. Old pairs stay put and stay tradable; nothing there was
// migrated. Deployed 2026-07-26.
export const ARC_PAIR_FACTORY_ADDRESS = "0x0540915768713dFd4436D0D2669129BA6809d1A5";
// One graduation authority standing in front of both pump factories, so USDC
// and EURC launches land in the same pool registry instead of two. Sealed at
// deployment with exactly two members; membership can never change. This is
// the v10 hub (0x39e146c99a774d7213Cc95F51C8Db7c2a3Ff7c43 was v9's, retired
// alongside its two 4,500-threshold factories).
export const ARC_GRADUATION_HUB_ADDRESS = "0x8a6d61a12D31BBBf5c011fa70c2f4802377D60c9";
// Router bound to the current factory. Each router hardcodes its factory, so a
// factory change forces a new router; the prior ones were
// 0xF0EeeE998470Dd277eB5E9eEc1116b10C407f166, 0x3681d045a79A3290F3228575D99f26cB057b39d2,
// and 0xa0da11008439829A37e01d0B9973F9199bB59DC2.
export const ARC_ROUTER_ADDRESS = "0x84bC0825c1A7FC72AbD07967B9F910E8ff5bC650";
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

// Arc Mainnet, chain 5042. Phase 1 (2026-07-30): USDC-only contracts —
// EURC, Pyth, and the ERC-8004 identity registries have no official mainnet
// address published yet (confirmed by probing chain 5042 directly: the
// testnet EURC/Pyth/Identity Registry addresses return no code there, while
// the native USDC ERC-20 view precompile at 0x3600...0000 IS live at the
// same fixed address as testnet). Full inventory, deferred-contract list,
// and governance caveats: public/developers/contracts.mainnet.json.
// No UI network switcher exists yet — these constants are not wired into any
// page. Wiring them in is the next step, tracked separately from this file.
//
// rpc.blockdaemon.mainnet.arc.io (used for every deploy above) started
// returning 401 Unauthorized on every request 2026-07-31 with no prior
// warning — confirmed by direct repeated curl, every path, every retry.
// thirdweb's edge recognizes chain 5042 (eth_chainId -> 0x13b2, verified
// live) but the client-ID auth path we tested still can't actually reach a
// working node behind it (eth_blockNumber/eth_gasPrice error out server
// side even once authed) — not usable either.
//
// 2026-07-31: found a working unofficial (third-party) node —
// arc-rpc.stakeme.pro / explorer arc.exploreme.pro. NOT Circle's own
// endpoint (no official mainnet RPC is publicly documented at all yet) —
// this is some other operator's infra, reachable over plain HTTPS with no
// auth. Verified independently and directly from this server (not just
// taking the frontend's word for it): eth_chainId/net_version -> 5042,
// eth_getCode on the native USDC precompile (0x3600...0000) returns real
// proxy bytecode, eth_getCode on our own deployed ArcPumpFactoryV8
// (marketUsdcFactory below) returns real bytecode, and
// eth_getTransactionByHash/eth_getBalance for our own deployer address
// (0x7D9b...F40C2) returned a real signed tx + a real 39+ USDC balance that
// matches what the explorer's own page independently rendered. Since it's
// unofficial, keep this swappable via env and don't treat it as permanent —
// swap to a real Circle/partner endpoint the moment one is public.
//
// 2026-07-31: arc-rpc.stakeme.pro sends back an Access-Control-Allow-Origin
// header hardcoded to https://www.alchemy.com on every response, which
// fails CORS preflight for any direct browser fetch to it — silently broke
// every client-side read (Market's live mainnet launches, the Landing
// radar, Wallet balance checks) while server-side script/cast calls against
// the same endpoint looked completely fine, since CORS is a browser-only
// mechanism. Routed through our own same-origin proxy instead (mirrors the
// existing Arc Testnet rpc.php); the proxy itself still talks to
// arc-rpc.stakeme.pro server-side, where CORS doesn't apply.
const THIRDWEB_CLIENT_ID = import.meta.env.VITE_THIRDWEB_CLIENT_ID || "";
const ARC_MAINNET_RPC =
  import.meta.env.VITE_ARC_MAINNET_RPC ||
  (THIRDWEB_CLIENT_ID ? `https://5042.rpc.thirdweb.com/${THIRDWEB_CLIENT_ID}` : "https://arcodian.fun/api/rpc-mainnet.php");

export const ARC_MAINNET = {
  id: 5042,
  hexId: "0x13b2",
  name: "Arc Mainnet",
  rpc: ARC_MAINNET_RPC,
  rpcs: [
    ARC_MAINNET_RPC,
    "https://arc-mainnet-rpc.baracat.meme/",
    "https://warp-arc-production.up.railway.app/rpc",
    "https://radar-api-rpc.up.railway.app",
  ],
  explorer: import.meta.env.VITE_ARC_MAINNET_EXPLORER || "https://arc.exploreme.pro",
  nativeToken: "0x3600000000000000000000000000000000000000",
  nativeSymbol: "USDC",
  nativeDecimals: 18,
  erc20Decimals: 6,
} as const;

export const ARC_MAINNET_CONTRACTS = {
  usdc: ARC_MAINNET.nativeToken,
  arcPay: "0x1dE9822D79aFdd53f9270503d16080F9ecbFdB7C",
  agentPayFactory: "0x4E3fDc7ddA063e8d629C7140e1D7ace574275c69",
  adminTimelock: "0xba953bc1282d0bffe22b4f769822d20900625594",
  sessionKeyAccount: "0x1602ee1fb997c75a7cf199f3adeba5b990edd06b",
  marketGraduationHub: "0xe98FF8c9825517eaC8A1CE2d00590D322AC4303F",
  marketPairFactory: "0xadb7d3d229F78198c4dE827607c89F95E9cE7722",
  marketUsdcFactory: "0x508FDa9F366E734a45fE7bc3a98F2909754633B7",
  marketRouter: "0x4A5eF82818F674452690539D75517b4604981Bed",
  // V9: graduates into a real, permissionless Uniswap V3 pool (Factory/NPM
  // below) instead of ArcPairFactoryV2 — the venue Telegram bots and
  // third-party routers already know how to read. New launches go here;
  // marketUsdcFactory above stays live read-only for pre-V9 coins (ARCD).
  marketUsdcFactoryV9: "0x071f978A9e7b8Ea0Ad914cba0d4C2c097f327066",
  v3Factory: "0x886694Bc4c5aCc545669E60a6694BA6a0B22d3bd",
  v3SwapRouter: "0xF0EeeE998470Dd277eB5E9eEc1116b10C407f166",
  v3Quoter: "0x79Af0A43Edc9d56ce44c770215066fbBA3B02D39",
  v3PositionManager: "0x332733D05a942da29087Ee4AF3497DE1911bA620",
  // External permissionless Uniswap V3 venue on Arc Mainnet. The factory and
  // router are called directly; the app does not depend on a website frontend.
  externalV3Factory: "0xf0db7b58379503491d857dB50AC9ece64c653918",
  externalV3Router: "0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77",
  externalV3FeeRouter: "0xe4664b28Cb0624860aAeE28E573697473f2Bf46e",
  // Agent economy — 2026-08-01. identityRegistry/reputationRegistry/
  // validationRegistry are the official ERC-8004 mainnet vanity proxies
  // (same addresses on 40+ other chains), self-deployed via the project's
  // public VANITY_DEPLOYMENT_GUIDE.md since Arc mainnet wasn't yet on their
  // supported-chain list. They currently point at a MinimalUUPS placeholder
  // — the official ERC-8004 owner (0x547289...) still needs to broadcast the
  // upgrade to the real implementation before identity registration actually
  // works on mainnet. agentPassport/agentJobs/agentPayFactoryV3 are ours.
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  validationRegistry: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58",
  agentPassport: "0x1709E8986B0b30B7FBaAd05971e6f8530742070A",
  agentJobs: "0xc1e7c3B9ADc079628A231636CB9c0d51478B0e87",
  agentPayFactoryV3: "0xfB23899361D6FcC44cc75f9b07C9f66AE8A6F0Ae",
} as const;

export const BRIDGE_TESTNETS = [
  "Arc Testnet", "Ethereum Sepolia", "Arbitrum Sepolia", "Base Sepolia",
  "Avalanche Fuji", "OP Sepolia", "Polygon Amoy", "Solana Devnet",
] as const;

// Real mainnets, wired for the CCTP bridge only (Phase 1 — see ARC_MAINNET
// above). Every USDC token address and every CCTP contract address here was
// verified 2026-07-30 by direct on-chain probing of each chain's public RPC
// (symbol()/decimals() on the token, localMessageTransmitter()/localDomain()
// on the CCTP contracts) — not copied from memory or a search result.
export const MAINNET_CHAINS = [
  { id: 1, name: "Ethereum", appKit: "Ethereum", symbol: "USDC", gasSymbol: "ETH", rpc: "https://ethereum-rpc.publicnode.com", token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { id: 42161, name: "Arbitrum One", appKit: "Arbitrum", symbol: "USDC", gasSymbol: "ETH", rpc: "https://arb1.arbitrum.io/rpc", token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  { id: 10, name: "Optimism", appKit: "Optimism", symbol: "USDC", gasSymbol: "ETH", rpc: "https://mainnet.optimism.io", token: "0x0b2c639c533813f4aa9d7837caf62653d097ff85" },
  { id: 8453, name: "Base", appKit: "Base", symbol: "USDC", gasSymbol: "ETH", rpc: "https://mainnet.base.org", token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { id: ARC_MAINNET.id, name: ARC_MAINNET.name, appKit: "Arc", symbol: "USDC", gasSymbol: "USDC", rpc: ARC_MAINNET.rpc, token: ARC_MAINNET.nativeToken },
] as const;

// CCTP v2 is deployed at these exact addresses on every mainnet chain above,
// including Arc — confirmed live 2026-07-30 (localMessageTransmitter() on
// the messenger returns this transmitter address on all five chains).
export const CCTP_MAINNET_TOKEN_MESSENGER_V2 = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d";
export const CCTP_MAINNET_MESSAGE_TRANSMITTER_V2 = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";
// Immutable, ownerless Arcodian fee routers. Each instance sends 150 bps
// directly to FEE_TREASURY and burns only the net amount through CCTP.
//
// Redeployed 2026-07-31 — the first version at 0xa3c5cef9... (same address
// on all 4 chains) declared depositForBurn as returning a uint64 nonce, but
// the real deployed TokenMessengerV2 returns nothing (confirmed against its
// verified implementation ABI on every chain). Solidity's ABI decoder
// reverted on the empty return data every single time, right after the burn
// had already executed — the router was unusable on all 4 chains from the
// moment it was deployed; nobody, including us, ever completed a bridge()
// call through it (zero BridgeStarted events anywhere). Fixed in
// ArcBridgeRouter.sol (depositForBurn now declared void) and live-verified
// end to end on Base: real tx burning 0.137985 USDC split cleanly into a
// 2070-unit (1.5%) fee landed in the treasury and a 135915-unit CCTP burn —
// https://basescan.org/tx/0xbec77bea7b211f553dbc065f05e81bcf82099649467a6f7e406636c284ddc026
export const CCTP_MAINNET_FEE_ROUTER: Readonly<Record<number, string>> = {
  1: "0x9fc12b77ae41181c98563e5ae5645ae8a0f6eddd",
  10: "0x66cc4767ec52ff09d8bda7abfccdea6ab9b70967",
  42161: "0x66cc4767ec52ff09d8bda7abfccdea6ab9b70967",
  8453: "0x274454aa0413b96651983c5efd6817cb30968e71",
  // Deployed 2026-07-31 once arc-rpc.stakeme.pro proved Arc Mainnet was
  // actually reachable — same USDC/TokenMessengerV2/treasury constructor
  // args as the other 4 chains. Verified live via eth_getCode.
  5042: "0xc35deb937f5056a0e034f10e21094878485caee7",
};
export const CCTP_MAINNET_DOMAIN: Record<number, number> = {
  1: 0, // Ethereum
  10: 2, // Optimism
  42161: 3, // Arbitrum One
  8453: 6, // Base
  [ARC_MAINNET.id]: 26, // Arc Mainnet
};

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
