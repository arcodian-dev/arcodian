// Every product lives on arcodian.fun itself since 2026-09-18. The old
// product subdomains (wallet., lend., market., …) 301 to paths here at the
// web server; nothing in the app redirects between hosts any more.
export function canonicalRedirect(_hostname: string, _pathname: string): string | null {
  return null;
}

/** The wallet app, which used to live at wallet.arcodian.fun/app. */
export function isWalletAppRoute(_hostname: string, pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

/** Lend (and its admin console), which used to live at lend.arcodian.fun. */
export function isLendRoute(pathname: string): boolean {
  return pathname === "/lend" || pathname.startsWith("/lend/");
}
