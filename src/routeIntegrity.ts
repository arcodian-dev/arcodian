export function canonicalRedirect(hostname: string, pathname: string): string | null {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const path = pathname.replace(/\/+$/, "") || "/";
  if (host !== "arcodian.fun") return null;
  if (path === "/app") return "https://wallet.arcodian.fun/app";
  if (path === "/lend") return "https://lend.arcodian.fun/";
  return null;
}

export function isWalletAppRoute(hostname: string, pathname: string): boolean {
  return hostname.toLowerCase() === "wallet.arcodian.fun" && (pathname === "/app" || pathname.startsWith("/app/"));
}
