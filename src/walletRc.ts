export type WalletNotice = {
  id: string;
  kind: "payment" | "refund" | "bridge" | "policy" | "failure" | "security";
  title: string;
  detail: string;
  createdAt: number;
  read: boolean;
  href?: string;
};

export type SystemAlert = {
  id: string;
  source: "lend" | "bridge" | "agentpay" | "treasury" | "indexer";
  severity: "critical" | "warning" | "notice";
  title: string;
  detail: string;
  createdAt: number;
  href?: string;
  accounts?: string[];
};

export const DEFAULT_AUTO_LOCK_MS = 2 * 60 * 1000;

export function shouldAutoLock(lastActiveAt: number, now = Date.now(), timeoutMs = DEFAULT_AUTO_LOCK_MS) {
  return lastActiveAt > 0 && now - lastActiveAt >= timeoutMs;
}

export function mergeWalletNotices(current: WalletNotice[], incoming: WalletNotice[], limit = 100) {
  const rows = new Map<string, WalletNotice>();
  for (const item of [...incoming, ...current]) if (!rows.has(item.id)) rows.set(item.id, item);
  return [...rows.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export function systemAlertsToWalletNotices(alerts: SystemAlert[], account = ""): WalletNotice[] {
  const normalized = account.toLowerCase();
  return alerts
    .filter((alert) => !alert.accounts?.length || alert.accounts.some((item) => item.toLowerCase() === normalized))
    .map((alert) => ({
      id: `system:${alert.id}`,
      kind: alert.source === "bridge" ? "bridge" : alert.source === "agentpay" ? "policy" : alert.severity === "critical" ? "failure" : "security",
      title: alert.title,
      detail: alert.detail,
      createdAt: alert.createdAt,
      read: false,
      href: alert.href,
    }));
}

export function parseWalletDeepLink(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "arcodian:") return null;
  if (url.hostname === "pay") return { view: "pay" as const, request: url.searchParams.get("request") || "" };
  if (url.hostname === "bridge") return { view: "bridge" as const, burn: url.searchParams.get("burn") || "" };
  if (url.hostname === "agentpay") return { view: "agentpay" as const, vault: url.searchParams.get("vault") || "" };
  return null;
}
