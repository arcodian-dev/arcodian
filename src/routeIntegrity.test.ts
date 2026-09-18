import { describe, expect, it } from "vitest";
import { canonicalRedirect, isLendRoute, isWalletAppRoute } from "./routeIntegrity";

describe("product route integrity", () => {
  it("never redirects between hosts: everything lives on arcodian.fun", () => {
    expect(canonicalRedirect("arcodian.fun", "/app")).toBeNull();
    expect(canonicalRedirect("www.arcodian.fun", "/lend/")).toBeNull();
    expect(canonicalRedirect("arcodian.fun", "/market")).toBeNull();
  });
  it("serves the wallet app and lend as paths", () => {
    expect(isWalletAppRoute("arcodian.fun", "/app")).toBe(true);
    expect(isWalletAppRoute("arcodian.fun", "/")).toBe(false);
    expect(isLendRoute("/lend")).toBe(true);
    expect(isLendRoute("/lend/admin")).toBe(true);
    expect(isLendRoute("/lending")).toBe(false);
  });
});
