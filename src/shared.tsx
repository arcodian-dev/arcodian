import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FallbackProvider, JsonRpcProvider, Network, formatUnits, parseEther } from "ethers";
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
  quoteDecimals?: number;
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
  topHolders?: Array<{ address: string; balance: string; kind?: "bonding_curve" | "liquidity_pool" | "creator" | "treasury" }>;
  trades?: Array<{ side: "BUY" | "SELL"; block: number; timestamp?: number; tx: string; user: string; native: string; tokens: string; price?: number }>;
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
// ipfs.io alone is a single point of failure for every native-launch coin
// image (the create flow requires an ipfs:// URI) — confirmed live
// 2026-09-10 that it was answering every request with 429 (rate-limited),
// with no in-code fallback: a broken-image icon, not the letter-avatar
// shown for a coin with no image at all. Public IPFS gateways rate-limit
// independently of each other and the Market grid requests many coin
// images in a burst on load (exactly the pattern that triggers it), so a
// single default is inherently fragile — resolveImageCandidates below
// gives CoinIcon a fallback chain instead of a single URL.
const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://nftstorage.link/ipfs/"];
export function imageUrl(uri: string) {
  if (uri.startsWith("ipfs://")) return `${IPFS_GATEWAYS[0]}${uri.slice(7)}`;
  try {
    const url = new URL(uri, window.location.origin);
    if (["arc.tensoriumlabs.com", "arcodian.fun", "www.arcodian.fun"].includes(url.hostname) && url.pathname.startsWith("/uploads/")) {
      return `${window.location.origin}${url.pathname}`;
    }
    return url.toString();
  } catch { return uri; }
}
export function resolveImageCandidates(uri: string): string[] {
  if (uri.startsWith("ipfs://")) return IPFS_GATEWAYS.map((gateway) => `${gateway}${uri.slice(7)}`);
  return [imageUrl(uri)];
}

/** A coin's image with an IPFS gateway fallback chain, then `fallback` (a letter avatar, normally) once every candidate has failed to load. */
export function CoinIcon({ image, alt = "", className, fallback }: { image?: string; alt?: string; className?: string; fallback: ReactNode }) {
  const candidates = useMemo(() => (image ? resolveImageCandidates(image) : []), [image]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [image]);
  if (!candidates.length || attempt >= candidates.length) return <>{fallback}</>;
  return <img className={className} src={candidates[attempt]} alt={alt} onError={() => setAttempt((value) => value + 1)} />;
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
/**
 * How many decimals a market row's quote amounts (reserve, volume, threshold,
 * a trade's `native`) are expressed in.
 *
 * Never guess this. A launch curve settles in Arc's native USDC at 18
 * decimals; an external V3 pool reports the ERC-20 USDC view at 6. Rendering
 * the second through formatEther is a factor of a trillion, and it does not
 * look like a bug — it looks like a market with no liquidity. That is exactly
 * what shipped: 1,014 of 1,114 rows showed 0.00 in the Market screener, among
 * them one holding 123,890 USDC.
 *
 * The index now states it per row. The fallbacks below only cover rows written
 * before it did: a globalPool row is 6, and an EURC row from the older
 * testnet index is 6 because that index did not normalize.
 */
export function quoteDecimalsOf(row: { quoteDecimals?: number; globalPool?: boolean; currency?: string }): number {
  if (typeof row.quoteDecimals === "number") return row.quoteDecimals;
  if (row.globalPool) return 6;
  if (row.currency === "EURC") return 6;
  return 18;
}

/** A market row's quote amount as a number, in whole units of its quote. */
export function quoteAmount(value: bigint | string | number | undefined, row: { quoteDecimals?: number; globalPool?: boolean; currency?: string }): number {
  return Number(formatUnits(BigInt(value ?? 0), quoteDecimalsOf(row)));
}

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
  ["Is Arcodian live on mainnet?", "Mostly. Bridge (Circle CCTP), the USDC-only Market/Launchpad, and Swap (Arcodian's own on-chain routing — an Arcodian-deployed AMM plus permissionless external Arc Mainnet pools) are all live on Arc Mainnet, chain 5042, moving real USDC — verify any address before signing. Bridging out of Arc works end to end. Bridging in started working on 2026-09-16, when Circle began attesting messages destined for Arc — inbound transfers now complete, and an earlier transfer whose burn already landed can be claimed from the bridge's recovery-by-hash flow. One exception remains outside our control: some burns made while Arc was still unattested were signed as fast transfers, and those attestations have since expired; Circle has to re-sign them before they can be claimed, so they revert if attempted. StableCoin FX and Arc Lend are live on mainnet as well. EURC launches and the agent-economy contracts (Passport, Jobs, Reputation, Agent Pay) remain Arc Testnet only, where test USDC and test tokens have no financial value — Circle published the Arc Mainnet EURC contract on 2026-09-16, but each of those surfaces also needs its own Arcodian contract deployed on mainnet before it can move there."],
  ["Can Arcodian access my wallet or funds?", "No. Arcodian is non-custodial. Your wallet signs each action, and the interface never receives your private key or seed phrase."],
  ["How is the token price determined?", "By the coin's own Uniswap V4 pool. Buys add USDC and move the price up, sells do the reverse. Every quote on arcodian.fun runs the real swap, so it matches what you receive."],
  ["What fees apply?", "1% on every buy and sell, in USDC, whichever router you use — half to the coin's creator, half to the treasury. The pool's own LP fee is 0%. When a coin reaches 12,000 USDC raised, a one-time 1% of its pool position goes to the treasury in USDC."],
  ["When does a coin graduate?", "When 12,000 USDC has been raised in its pool. The swap that crosses the line triggers it automatically; there is nothing to call and no move to another venue — the coin keeps trading in the same pool."],
  ["What happens to liquidity after graduation?", "It stays in the same pool, locked. At graduation 1% of the position is removed once — its USDC to the treasury, its tokens burned — and the factory has no other way to touch the rest. There is no LP token anyone could sell or withdraw."],
  ["Does a report automatically remove a coin?", "No. Reports are review signals only. They do not freeze contracts, move user funds, or automatically hide a permissionless market."],
  ["Are creator badges or Arena rankings paid?", "No. Reputation, missions, Arena standings, and badges are computed from indexed public activity and canonical onchain data."],
  ["Can I launch a coin priced in EURC?", "Not on mainnet right now. New coins launch on the current engine only, which opens a Uniswap V4 pool quoted in USDC. EURC launches ran on an older bonding-curve engine and are no longer offered."],
  ["What is the StableCoin FX desk?", "A USDC/EURC desk on Arc Mainnet. Every order is quoted exactly against Arcodian's own pool and the Uniswap V3 USDC/EURC pools, and fills where you receive the most. Anyone can add liquidity to Arcodian's pool and earn 0.08% of every swap it fills."],
  ["Is there only one Arcodian website?", "Yes — arcodian.fun. Every product (Market, Swap, Bridge, Docs, Wallet, Pay) is a page on that one domain. Older links to swap., bridge., market., docs., wallet., pay. or lend.arcodian.fun redirect permanently to the matching page here. Anything on another domain is not us."],
  ["Which wallets and networks are supported?", "Any EIP-1193 / EIP-6963 browser wallet, plus WalletConnect. Bridge, the USDC Market, Swap and StableCoin FX run on Arc Mainnet, chain 5042, with real value — connect and check the network shown before signing. StableCoin FX and Arc Lend run on Arc Mainnet too; EURC launches still run on Arc Testnet (chain 5042002); bridging additionally touches the supported Circle CCTP testnets/mainnets depending on which network you're on. Your keys never leave your wallet."],
];
