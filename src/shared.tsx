import { FallbackProvider, JsonRpcProvider, parseEther } from "ethers";
import { ARC } from "./config";

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
  uniswapPool?: string;
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
  topHolders?: Array<{ address: string; balance: string }>;
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
export function arcProvider() {
  const providers = [...new Set(ARC.rpcs)].map((url) => new JsonRpcProvider(url));
  return providers.length === 1 ? providers[0] : new FallbackProvider(providers, undefined, { quorum: 1 });
}

export const FAQ_ITEMS = [
  ["Is Arcodian live on mainnet?", "No. Arcodian currently runs on Arc Testnet, chain 5042002. Test USDC and launched test tokens have no financial value."],
  ["Can Arcodian access my wallet or funds?", "No. Arcodian is non-custodial. Your wallet signs each action, and the interface never receives your private key or seed phrase."],
  ["How is the token price determined?", "Before graduation, price comes from the v6 bonding curve using its onchain virtual reserve and real reserve. It is not typed into an admin dashboard."],
  ["What fees apply?", "Bonding-curve buys and sells charge 1%. After graduation, ARC DEX charges a 0.30% total swap fee, including a 0.05% protocol share."],
  ["When does a coin graduate?", "A v5 coin graduates when its real net reserve reaches 4,500 USDC. The final transaction can cross slightly above the threshold."],
  ["What happens to liquidity after graduation?", "The remaining tokens and real USDC move into the canonical ARC DEX pair. All LP ownership tokens are minted to the burn address, so the creator and deployer cannot withdraw that liquidity."],
  ["Does a report automatically remove a coin?", "No. Reports are review signals only. They do not freeze contracts, move user funds, or automatically hide a permissionless market."],
  ["Are creator badges or Arena rankings paid?", "No. Reputation, missions, Arena standings, and badges are computed from indexed public activity and canonical onchain data."],
  ["Can I launch a coin priced in EURC?", "Yes. Toggle the collateral to EURC when you create. The coin then trades against EURC on its own bonding curve (same 1% fee, same graduation logic), and the interface auto-detects EURC for every buy and sell. Prices display in € instead of $."],
  ["What is the StableCoin FX desk?", "A smart-routed USDC/EURC desk. It compares Arcodian's permissionless on-chain pool with configured, allowlisted external liquidity and executes the best valid quote. If no external route is available, the Arcodian pool remains the transparent fallback."],
  ["Why do Swap, Bridge, Market and Docs open new tabs?", "Each runs on its own subdomain (swap./bridge./market./docs.arcodian.fun) so you can keep several workspaces open at once. It is the same non-custodial app on every subdomain—only the default view changes."],
  ["Which wallets and networks are supported?", "Any EIP-1193 / EIP-6963 browser wallet, plus WalletConnect. Trading and FX run on Arc Testnet (chain 5042002); bridging additionally touches the supported Circle CCTP testnets. Your keys never leave your wallet."],
];
