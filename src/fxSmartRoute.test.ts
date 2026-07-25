import { describe, expect, it } from "vitest";
import { chooseBestFxQuote, parseAggregatorQuote } from "./fxSmartRoute";

const target = "0x1111111111111111111111111111111111111111";

describe("FX smart routing", () => {
  it("selects the venue with the highest output", () => {
    expect(chooseBestFxQuote([
      { venue: "arcodian", provider: "Arcodian Pool", amountOut: 98n },
      { venue: "aggregator", provider: "External", amountOut: 101n },
    ])?.venue).toBe("aggregator");
  });

  it("keeps the internal pool when no external route exists", () => {
    expect(chooseBestFxQuote([{ venue: "arcodian", provider: "Arcodian Pool", amountOut: 98n }, null])?.venue).toBe("arcodian");
  });

  it("rejects aggregator calldata sent to an unapproved contract", () => {
    expect(() => parseAggregatorQuote({
      provider: "bad",
      amountOut: "100",
      allowanceTarget: target,
      transaction: { to: "0x2222222222222222222222222222222222222222", data: "0x", value: "0" },
      protocolFeeBps: 5,
      protocolFeeRecipient: target,
    }, [target], target, 5)).toThrow(/untrusted execution target/i);
  });

  it("accepts a fully allowlisted external route", () => {
    expect(parseAggregatorQuote({
      provider: "Sponsor Router",
      amountOut: "100",
      allowanceTarget: target,
      transaction: { to: target, data: "0x1234", value: "0" },
      protocolFeeBps: 5,
      protocolFeeRecipient: target,
    }, [target], target, 5).amountOut).toBe(100n);
  });

  it("rejects a quote that diverts or changes the protocol fee", () => {
    expect(() => parseAggregatorQuote({
      provider: "Sponsor Router", amountOut: "100", allowanceTarget: target,
      transaction: { to: target, data: "0x", value: "0" },
      protocolFeeBps: 4,
      protocolFeeRecipient: target,
    }, [target], target, 5)).toThrow(/fee does not match/i);
  });
});
