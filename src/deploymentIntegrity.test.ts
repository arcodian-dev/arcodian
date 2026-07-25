import { describe, expect, it } from "vitest";
import {
  ARC_GRADUATION_HUB_ADDRESS,
  ARC_PAIR_FACTORY_ADDRESS, ARC_ROUTER_ADDRESS, ENGINE_VERSION,
  EURC_PUMP_FACTORY_ADDRESS, LEGACY_PUMP_FACTORY_ADDRESSES,
  PUMP_FACTORY_ADDRESS, RETIRED_DEPLOYMENTS,
} from "./config";

/**
 * Guards against shipping a mismatched stack — the failure mode that matters
 * at mainnet, where a stale address is not a display bug but real money sent
 * to a dead contract.
 *
 * Every rule here exists because it is easy to get wrong by hand: bumping an
 * address but forgetting to retire the old one, or retiring the new one.
 */

function addressesIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) found.push(value.toLowerCase());
  } else if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) addressesIn(nested, found);
  }
  return found;
}

const CANONICAL = {
  PUMP_FACTORY_ADDRESS,
  ARC_PAIR_FACTORY_ADDRESS,
  ARC_ROUTER_ADDRESS,
  EURC_PUMP_FACTORY_ADDRESS,
  ARC_GRADUATION_HUB_ADDRESS,
};

describe("canonical stack integrity", () => {
  it("declares the engine version the rest of the app reports", () => {
    expect(ENGINE_VERSION).toBe(9);
  });

  it("has no canonical address that is also marked retired", () => {
    const retired = new Set(addressesIn(RETIRED_DEPLOYMENTS));
    for (const [name, address] of Object.entries(CANONICAL)) {
      expect(retired.has(address.toLowerCase()), `${name} is listed in RETIRED_DEPLOYMENTS`).toBe(false);
    }
  });

  // Indexing walks [canonical, ...legacy]. If the canonical factory also
  // appears in the legacy list every launch is read and rendered twice.
  it("does not index the canonical pump factory as legacy", () => {
    const legacy = LEGACY_PUMP_FACTORY_ADDRESSES.map((a) => a.toLowerCase());
    expect(legacy).not.toContain(PUMP_FACTORY_ADDRESS.toLowerCase());
    expect(legacy).not.toContain(EURC_PUMP_FACTORY_ADDRESS.toLowerCase());
  });

  // LEGACY_PUMP_FACTORY_ADDRESSES is read with an ABI that assumes a native
  // USDC quote (realNativeReserve / VIRTUAL_NATIVE). An EURC factory listed
  // there would not fail loudly — it would render EURC reserves as USDC, at
  // 1e12 the wrong scale. EURC factories belong only in the quote-kind-aware
  // indexer, scripts/index-market.mjs.
  it("never indexes an EURC pump factory through the native-quote path", () => {
    const legacy = LEGACY_PUMP_FACTORY_ADDRESSES.map((a) => a.toLowerCase());
    expect(legacy).not.toContain(RETIRED_DEPLOYMENTS.eurc.pumpFactory.toLowerCase());
    expect(legacy).not.toContain(EURC_PUMP_FACTORY_ADDRESS.toLowerCase());
  });

  // Both launchpads must graduate into ONE registry, or liquidity and routing
  // split in two. They can only do that through the hub.
  it("points both pump factories at the same pair registry via the hub", () => {
    expect(ARC_GRADUATION_HUB_ADDRESS.toLowerCase())
      .not.toBe(RETIRED_DEPLOYMENTS.v8PreHub.pumpFactory.toLowerCase());
    expect(ARC_PAIR_FACTORY_ADDRESS.toLowerCase())
      .not.toBe(RETIRED_DEPLOYMENTS.v8PreHub.pairFactory.toLowerCase());
    expect(ARC_ROUTER_ADDRESS.toLowerCase())
      .not.toBe(RETIRED_DEPLOYMENTS.v8PreHub.router.toLowerCase());
  });

  it("keeps retired testnet factories out of canonical market surfaces", () => {
    expect(LEGACY_PUMP_FACTORY_ADDRESSES).toHaveLength(0);
  });

  it("lists no legacy factory twice", () => {
    const legacy = LEGACY_PUMP_FACTORY_ADDRESSES.map((a) => a.toLowerCase());
    expect(new Set(legacy).size).toBe(legacy.length);
  });

  it("holds only well-formed addresses everywhere", () => {
    for (const [name, address] of Object.entries(CANONICAL)) {
      expect(address, name).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    for (const address of LEGACY_PUMP_FACTORY_ADDRESSES) {
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  // The pair factory and the router must agree: the router hardcodes a factory
  // at construction, so a factory change without a router change routes trades
  // through the wrong registry.
  it("pairs the router with the current factory, not a previous one", () => {
    expect(ARC_ROUTER_ADDRESS.toLowerCase()).not.toBe(RETIRED_DEPLOYMENTS.routerV1.toLowerCase());
    expect(ARC_PAIR_FACTORY_ADDRESS.toLowerCase()).not.toBe(RETIRED_DEPLOYMENTS.pairFactoryV1.toLowerCase());
  });
});
