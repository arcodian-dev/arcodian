import { describe, expect, it } from "vitest";
import {
  MULTIHOP_MIN_GAIN_BPS, bestRoute, directRouteFrom, hopCount, routeGainBps, routeLabel,
  type DirectRoute, type MultiRoute,
} from "./routing";

const A = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const M = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function direct(out: bigint, tier: 10 | 30 = 10): DirectRoute {
  return { kind: "direct", out, path: [A, B], tier, pair: "0xpair", reserveIn: 1000n, reserveOut: 1000n };
}

function multi(out: bigint, path: string[] = [A, M, B]): MultiRoute {
  return { kind: "multi", out, path, pairs: path.slice(1).map((_, i) => `0xp${i}`), tier: 30 };
}

describe("route selection", () => {
  it("takes the direct route when nothing else exists", () => {
    expect(bestRoute(direct(100n), [])).toMatchObject({ kind: "direct", out: 100n });
  });

  it("takes a multi-hop route when there is no direct pair", () => {
    expect(bestRoute(null, [multi(100n)])).toMatchObject({ kind: "multi", out: 100n });
  });

  it("returns nothing when neither route exists", () => {
    expect(bestRoute(null, [])).toBeNull();
  });

  // The failure this whole module exists to prevent: routing a user through a
  // shallow 30 bps path when a deep 10 bps pair sits right there.
  it("keeps the direct route when it pays more", () => {
    const chosen = bestRoute(direct(1_000n), [multi(900n)]);
    expect(chosen).toMatchObject({ kind: "direct", out: 1_000n });
  });

  it("switches to multi-hop only when it wins by a real margin", () => {
    const base = 10_000n;
    const marginal = base + (base * MULTIHOP_MIN_GAIN_BPS) / 10_000n; // exactly at threshold
    expect(bestRoute(direct(base), [multi(marginal)])).toMatchObject({ kind: "direct" });
    expect(bestRoute(direct(base), [multi(marginal + 1n)])).toMatchObject({ kind: "multi" });
  });

  it("never prefers a multi-hop route that pays the same", () => {
    expect(bestRoute(direct(500n), [multi(500n)])).toMatchObject({ kind: "direct" });
  });

  it("ignores routes that produce nothing", () => {
    expect(bestRoute(null, [multi(0n), multi(-0n)])).toBeNull();
    expect(bestRoute(direct(0n), [multi(50n)])).toMatchObject({ kind: "multi" });
  });

  it("picks the highest-paying multi-hop candidate", () => {
    const chosen = bestRoute(null, [multi(100n), multi(300n), multi(200n)]);
    expect(chosen?.out).toBe(300n);
  });

  it("breaks an equal-output tie by taking fewer hops", () => {
    const long = multi(100n, [A, M, B, B]);
    const short = multi(100n, [A, M, B]);
    expect(hopCount(long)).toBe(3);
    expect(bestRoute(null, [long, short])).toBe(short);
  });
});

describe("route reporting", () => {
  it("reports no gain for a direct route", () => {
    const d = direct(100n);
    expect(routeGainBps(d, d)).toBe(0);
  });

  it("reports the improvement a multi-hop route delivers", () => {
    expect(routeGainBps(multi(1_100n), direct(1_000n))).toBe(1_000); // +10%
  });

  it("reports no gain when there was no direct route to beat", () => {
    expect(routeGainBps(multi(1_100n), null)).toBe(0);
  });

  it("names every token the money passes through", () => {
    const symbols: Record<string, string> = { [A]: "USDC", [M]: "ARCT", [B]: "EURC" };
    expect(routeLabel([A, M, B], (a) => symbols[a] ?? "?")).toBe("USDC → ARCT → EURC");
  });
});

describe("direct route construction", () => {
  it("carries the pair's tier and reserves through for impact reporting", () => {
    const route = directRouteFrom(
      { pair: "0xdeadbeef", tier: 30, out: 42n, reserveIn: 7n, reserveOut: 9n },
      A, B,
    );
    expect(route).toMatchObject({ kind: "direct", pair: "0xdeadbeef", tier: 30, out: 42n, reserveIn: 7n, reserveOut: 9n });
    expect(route.path).toEqual([A, B]);
  });
});
