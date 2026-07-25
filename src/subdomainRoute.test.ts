import { describe, expect, it } from "vitest";
import { navHref, subdomainTab, currentSubdomain } from "./config";

describe("subdomain routing", () => {
  it("maps hostnames to default tabs", () => {
    expect(subdomainTab("arcodian.fun")).toBeNull();
    expect(subdomainTab("www.arcodian.fun")).toBeNull();
    expect(subdomainTab("market.arcodian.fun")).toBe("screener");
    expect(subdomainTab("swap.arcodian.fun")).toBe("swap");
    expect(subdomainTab("bridge.arcodian.fun")).toBe("bridge");
    expect(subdomainTab("docs.arcodian.fun")).toBe("how");
    expect(subdomainTab("wallet.arcodian.fun")).toBe("wallet");
    expect(subdomainTab("pay.arcodian.fun")).toBeNull();
    expect(subdomainTab("lend.arcodian.fun")).toBe("wallet");
    expect(subdomainTab("localhost")).toBeNull();
  });

  it("extracts the leading subdomain label", () => {
    expect(currentSubdomain("swap.arcodian.fun")).toBe("swap");
    expect(currentSubdomain("arcodian.fun")).toBe("");
    expect(currentSubdomain("www.arcodian.fun")).toBe("");
    expect(currentSubdomain("localhost")).toBe("");
  });

  it("links cross-subdomain tabs to their subdomain, in-SPA otherwise (when live)", () => {
    const live = true;
    // From the apex: subdomain tabs open their subdomain, fx/home stay in-SPA.
    expect(navHref("swap", "arcodian.fun", live)).toBe("https://swap.arcodian.fun/");
    expect(navHref("wallet", "arcodian.fun", live)).toBe("https://wallet.arcodian.fun/");
    expect(navHref("screener", "arcodian.fun", live)).toBe("https://market.arcodian.fun/");
    expect(navHref("how", "arcodian.fun", live)).toBe("https://docs.arcodian.fun/");
    expect(navHref("fx", "arcodian.fun", live)).toBeNull();
    // On a subdomain: the current tab is in-SPA, others cross-link.
    expect(navHref("swap", "swap.arcodian.fun", live)).toBeNull();
    expect(navHref("bridge", "swap.arcodian.fun", live)).toBe("https://bridge.arcodian.fun/");
    expect(navHref("fx", "swap.arcodian.fun", live)).toBe("https://arcodian.fun/fx");
    // Dev / preview hosts always stay in-SPA.
    expect(navHref("swap", "localhost", live)).toBeNull();
    expect(navHref("bridge", "arc.tensoriumlabs.com", live)).toBeNull();
  });

  it("keeps every link in-SPA while subdomains are not live (default gate)", () => {
    expect(navHref("swap", "arcodian.fun", false)).toBeNull();
    expect(navHref("screener", "arcodian.fun", false)).toBeNull();
    // Default arg (VITE_SUBDOMAINS_LIVE unset in tests) also stays in-SPA.
    expect(navHref("swap", "arcodian.fun")).toBeNull();
  });
});
