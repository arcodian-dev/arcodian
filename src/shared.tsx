import { FallbackProvider, JsonRpcProvider, Network, parseEther } from "ethers";
import { ARC, ARC_MAINNET } from "./config";

export type WalletOption = { info: EIP6963ProviderInfo; provider: EthereumProvider };
export type LaunchAsset = {
  engineVersion?: number;
  quoteKind?: number; // 0 = native USDC (default), 1 = EURC (ERC-20 collateral)
  currency?: string; // "USDC" | "EURC" — display + trade routing
  symbol: string;
  name: string;
  type: string;
  risk: string;
  address: string;
  curve: string;
  pair?: string;
  pool?: string;
  globalPool?: boolean;
  dex?: string;
  venue?: string;
  feeTier?: number;
  liquidity?: string;
  marketCap?: string;
  volume5m?: string;
  volume10m?: string;
  priceChange5m?: number;
  priceChange10m?: number;
  priceChange1h?: number;
  lpSupply?: string;
  lpBurned?: string;
  image: string;
  creator?: string;
  volume?: string;
  tradeCount?: number;
  holderCount?: number;
  volume1h?: string;
  volume24h?: string;
  priceChange24h?: number;
  createdAt?: number;
  topHolders?: Array<{ address: string; balance: string; kind?: "bonding_curve" | "liquidity_pool" }>;
  trades?: Array<{ side: "BUY" | "SELL"; block: number; timestamp?: number; tx: string; user: string; native: string; tokens: string }>;
  progress: number;
  reserve: bigint;
  virtualReserve: bigint;
  threshold: bigint;
  inventory: bigint;
  graduated: boolean;
};

export type CommunityPost = {
  id: string;
  token: string;
  author: string;
  message: string;
  timestamp: number;
  signature: string;
};

export type SocialLinks = {
  token: string;
  creator: string;
  twitter: string;
  discord: string;
  timestamp: number;
  signature: string;
};
export type ArenaWinner = { roundId: string; finalizedAt: string; winner: { token: string; symbol: string; name: string; image?: string; score: number; volume24h: string; tradeCount: number } };

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "arcodian-symbol compact-symbol" : "arcodian-symbol"}>
      <img src="/arcodian-mark.svg" alt="" />
    </span>
  );
}

export function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
export function imageUrl(uri: string) {
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  try {
    const url = new URL(uri, window.location.origin);
    if (["arc.tensoriumlabs.com", "arcodian.fun", "www.arcodian.fun"].includes(url.hostname) && url.pathname.startsWith("/uploads/")) {
      return `${window.location.origin}${url.pathname}`;
    }
    return url.toString();
  } catch { return uri; }
}
export function safeEther(value: string) {
  try {
    return /^\d+(\.\d{0,18})?$/.test(value) ? parseEther(value) : 0n;
  } catch {
    return 0n;
  }
}

export type ActivityStatus = "submitted" | "pending" | "completed" | "failed";
export type WalletActivity = {
  id: string;
  account: string;
  kind: "BUY" | "SELL";
  status: ActivityStatus;
  title: string;
  detail: string;
  txHash?: string;
  chainIn?: string;
  chainOut?: string;
  rail?: "arc";
  createdAt: number;
  updatedAt: number;
};
const ACTIVITY_KEY = "arcodian-activity-v1";
export function readActivities(): WalletActivity[] {
  try {
    const value = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || "[]");
    return Array.isArray(value) ? value.slice(0, 100) : [];
  } catch { return []; }
}
export function writeActivity(activity: WalletActivity) {
  const current = readActivities();
  const next = [activity, ...current.filter((item) => item.id !== activity.id)].slice(0, 100);
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("arcodian:activity"));
}
export function patchActivity(id: string, patch: Partial<WalletActivity>) {
  const current = readActivities();
  const index = current.findIndex((item) => item.id === id);
  if (index < 0) return;
  current[index] = { ...current[index], ...patch, updatedAt: Date.now() };
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(current));
  window.dispatchEvent(new CustomEvent("arcodian:activity"));
}
export function communitySigningMessage(token: string, message: string, timestamp: number) {
  return `Arcodian community post\nToken: ${token.toLowerCase()}\nTimestamp: ${timestamp}\nMessage: ${message}`;
}
export function socialSigningMessage(token: string, twitter: string, discord: string, timestamp: number) {
  return `Arcodian coin links\nToken: ${token.toLowerCase()}\nTimestamp: ${timestamp}\nX: ${twitter}\nDiscord: ${discord}`;
}
export function normalizeSocial(value: string, type: "twitter" | "discord") {
  const raw = value.trim();
  if (!raw) return "";
  const candidate = type === "twitter" && /^@?[A-Za-z0-9_]{1,15}$/.test(raw)
    ? `https://x.com/${raw.replace(/^@/, "")}`
    : type === "discord" && !raw.includes("/")
      ? `https://discord.gg/${raw}`
      : /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (type === "twitter" && !["x.com", "twitter.com"].includes(host)) return "";
    if (type === "discord" && !["discord.gg", "discord.com"].includes(host)) return "";
    return url.toString();
  } catch { return ""; }
}
// Deliberately just chain.rpc, NOT chain.rpcs. First tried offering wallets
// the full 2-3 endpoint fallback list our own app uses internally (this
// function used to return all of them) — reasoning that redundancy could
// only help. Turned out backwards: OKX (confirmed 2026-08-03, exact error
// captured) runs its own bare reachability probe against every rpcUrls
// entry — a plain GET/HEAD at the bare host, no JSON-RPC body — before
// trusting the chain config. Our own same-origin proxy (chain.rpc) can be
// made to answer that cleanly (see rpc-mainnet.php), but the two third-party
// Railway endpoints in chain.rpcs 404 on a bare root request even though
// their real POST /rpc path works fine — and the wallet doesn't fall back
// to whichever URL is actually healthy, it rejects the network entirely
// over the one that failed its probe. One URL we fully control beats three
// where we only control one.
export function rpcUrlsFor(chain: { rpc: string; rpcs?: readonly string[]; walletRpc?: string }): string[] {
  return [chain.walletRpc || chain.rpc];
}

/**
 * Ensure an injected wallet is actually usable on the requested Arc chain.
 *
 * Some wallets return an error other than 4902 when a saved chain has a stale
 * RPC. Treat every failed switch as a chance to re-submit the canonical chain
 * definition, then switch and verify the provider after the wallet finishes
 * rotating. The wallet may still refuse to overwrite an existing RPC; in that
 * case the final error is intentionally explicit instead of looking like an
 * RPC or contract revert.
 */
export async function ensureWalletChain(
  provider: EthereumProvider,
  target: typeof ARC | typeof ARC_MAINNET,
): Promise<void> {
  const expected = target.hexId.toLowerCase();
  const readChain = async () => String(await provider.request({ method: "eth_chainId" })).toLowerCase();
  const waitForChain = async () => {
    let observed = "";
    for (let attempt = 0; attempt < 12; attempt += 1) {
      observed = await readChain();
      if (observed === expected) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return observed === expected;
  };
  const addCanonicalChain = async () => {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: target.hexId,
        chainName: target.name,
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: rpcUrlsFor(target),
        blockExplorerUrls: [target.explorer],
      }],
    });
  };

  let current = await readChain();
  if (current === expected) {
    // A matching chain ID does not prove the wallet's saved RPC is healthy.
    // Probe once; on failure ask the wallet to refresh the canonical config.
    try {
      await Promise.race([
        provider.request({ method: "eth_blockNumber" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("RPC_TIMEOUT")), 5_000)),
      ]);
      return;
    } catch {
      await addCanonicalChain();
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target.hexId }] });
      if (!(await waitForChain())) throw new Error(`Wallet RPC for ${target.name} is still unavailable. Re-add the network in OKX using ${rpcUrlsFor(target)[0]}.`);
      return;
    }
  }

  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target.hexId }] });
  } catch (switchError) {
    try {
      // Do this for every switch failure, not only 4902. OKX can report a
      // stale/busy saved RPC with a generic provider error.
      await addCanonicalChain();
    } catch (addError) {
      const code = Number((addError as { code?: unknown })?.code || (switchError as { code?: unknown })?.code || 0);
      if (code === 4001) throw new Error("Network setup was rejected in the wallet.");
      // Continue to the retry: some wallets say the chain already exists
      // while still accepting a subsequent switch.
    }
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target.hexId }] });
  }
  current = await readChain();
  if (current !== expected && !(await waitForChain())) {
    throw new Error(`Wallet did not switch to ${target.name}. If the network already exists in OKX, remove it and reconnect so the site can add it with RPC ${rpcUrlsFor(target)[0]}.`);
  }
}
export function arcProvider(chain: { rpc: string; rpcs?: readonly string[]; id?: number } = ARC) {
  const urls = chain.rpcs && chain.rpcs.length ? chain.rpcs : [chain.rpc];
  // staticNetwork skips ethers' own eth_chainId "network detection" probe on
  // every provider instantiation — with it unset, a single transient RPC
  // blip (like Arc Mainnet's shared third-party gateway having a moment,
  // 2026-07-31) throws an uncaught "could not detect network" straight out
  // of whatever called arcProvider(), bypassing describeTxError entirely and
  // showing the user a raw ethers error dump instead of a real message. We
  // already know the chain id from config, so there's nothing to detect.
  const network = chain.id ? Network.from(chain.id) : undefined;
  // batchMaxCount: 1 — found 2026-08-03: route quoting fires several
  // eth_call reads close together (findBestRoute + findBestV3Route +
  // findBestExternalV3Route, each looping fee tiers via Promise.all), and
  // ethers' default auto-batching folds simultaneous calls into one JSON-RPC
  // batch. At least one upstream gateway (Alchemy-style) hard-rejects
  // batches with "batch disabled for this project" — whichever fee-tier
  // check happened to land in that batch silently came back as "no pool"
  // (the caller's try/catch treats any throw as "unsupported tier, skip"),
  // so real, liquid pools intermittently vanished from routing depending on
  // which calls got bundled together that render. This is exactly why the
  // backend indexer scripts already force batchMaxCount: 1 — that guard was
  // never carried over to this, the actual swap-quoting provider.
  const providers = [...new Set(urls)].map((url) => new JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 }));
  return providers.length === 1 ? providers[0] : new FallbackProvider(providers, undefined, { quorum: 1 });
}

export const FAQ_ITEMS = [
  ["Is Arcodian live on mainnet?", "Mostly. Bridge (Circle CCTP), the USDC-only Market/Launchpad, and Swap (Arcodian's own on-chain routing — an Arcodian-deployed AMM plus permissionless external Arc Mainnet pools) are all live on Arc Mainnet, chain 5042, moving real USDC — verify any address before signing. StableCoin FX (no official Arc Mainnet EURC address exists yet), Arc Lend, EURC launches, and the agent-economy contracts (Passport, Jobs, Reputation, Agent Pay) remain Arc Testnet only, where test USDC and test tokens have no financial value."],
  ["Can Arcodian access my wallet or funds?", "No. Arcodian is non-custodial. Your wallet signs each action, and the interface never receives your private key or seed phrase."],
  ["How is the token price determined?", "Before graduation, price comes from the V10 bonding curve using its onchain virtual reserve and real reserve. It is not typed into an admin dashboard."],
  ["What fees apply?", "Bonding-curve buys and sells charge 1%. After graduation, the ARC DEX pool charges a 0.30% total swap fee."],
  ["When does a coin graduate?", "A V10 coin graduates when its real net reserve reaches 12,000 USDC. The final transaction can cross slightly above the threshold."],
  ["What happens to liquidity after graduation?", "The remaining tokens and real USDC move into the canonical ARC DEX pair. All LP ownership tokens are minted to the burn address, so the creator and deployer cannot withdraw that liquidity."],
  ["Does a report automatically remove a coin?", "No. Reports are review signals only. They do not freeze contracts, move user funds, or automatically hide a permissionless market."],
  ["Are creator badges or Arena rankings paid?", "No. Reputation, missions, Arena standings, and badges are computed from indexed public activity and canonical onchain data."],
  ["Can I launch a coin priced in EURC?", "Yes. Toggle the collateral to EURC when you create. The coin then trades against EURC on its own bonding curve (same 1% fee, same graduation logic), and the interface auto-detects EURC for every buy and sell. Prices display in € instead of $."],
  ["What is the StableCoin FX desk?", "A smart-routed USDC/EURC desk. It compares Arcodian's permissionless on-chain pool with configured, allowlisted external liquidity and executes the best valid quote. If no external route is available, the Arcodian pool remains the transparent fallback."],
  ["Why do Swap, Bridge, Market and Docs open new tabs?", "Each runs on its own subdomain (swap./bridge./market./docs.arcodian.fun) so you can keep several workspaces open at once. It is the same non-custodial app on every subdomain—only the default view changes."],
  ["Which wallets and networks are supported?", "Any EIP-1193 / EIP-6963 browser wallet, plus WalletConnect. Bridge, USDC-only Market, and Swap run on Arc Mainnet, chain 5042, with real value — connect and check the network shown before signing. FX and EURC launches still run on Arc Testnet (chain 5042002); bridging additionally touches the supported Circle CCTP testnets/mainnets depending on which network you're on. Your keys never leave your wallet."],
];
