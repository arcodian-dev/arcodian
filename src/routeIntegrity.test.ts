import { describe, expect, it } from "vitest";
import { canonicalRedirect, isWalletAppRoute } from "./routeIntegrity";

describe("product route integrity", () => {
  it("routes the apex app alias to the web wallet", () => expect(canonicalRedirect("arcodian.fun", "/app")).toBe("https://wallet.arcodian.fun/app"));
  it("routes the apex lend alias to the canonical dApp", () => expect(canonicalRedirect("www.arcodian.fun", "/lend/")).toBe("https://lend.arcodian.fun/"));
  it("does not redirect unrelated routes", () => expect(canonicalRedirect("arcodian.fun", "/market")).toBeNull());
  it("opens only the wallet app path", () => {
    expect(isWalletAppRoute("wallet.arcodian.fun", "/app")).toBe(true);
    expect(isWalletAppRoute("wallet.arcodian.fun", "/")).toBe(false);
    expect(isWalletAppRoute("lend.arcodian.fun", "/app")).toBe(false);
  });
});
