import { describe, expect, it } from "vitest";
import { positionValue, sharePpm, formatShare, type PositionInput } from "./portfolio";

function input(over: Partial<PositionInput> = {}): PositionInput {
  return {
    balance: 100n,
    totalSupply: 1000n,
    reserve0: 5_000n,
    reserve1: 20_000n,
    ...over,
  };
}

describe("positionValue", () => {
  it("returns the pro-rata share of both reserves", () => {
    const { amount0, amount1 } = positionValue(input());
    expect(amount0).toBe(500n);
    expect(amount1).toBe(2_000n);
  });

  it("returns zero for a holder with no shares", () => {
    const { amount0, amount1 } = positionValue(input({ balance: 0n }));
    expect(amount0).toBe(0n);
    expect(amount1).toBe(0n);
  });

  // A pair whose totalSupply is zero cannot be divided by. This is unreachable
  // on a live pair because MINIMUM_LIQUIDITY is permanently locked, but the UI
  // must not divide by zero if it ever reads a pair mid-deployment.
  it("does not divide by zero when the pool has no supply", () => {
    const { amount0, amount1 } = positionValue(input({ totalSupply: 0n, balance: 0n }));
    expect(amount0).toBe(0n);
    expect(amount1).toBe(0n);
  });

  it("rounds down, never up — the pool must never owe more than it holds", () => {
    // 1/3 of 10 wei is 3.33; paying 4 would over-pay the holder.
    const { amount0 } = positionValue(input({ balance: 1n, totalSupply: 3n, reserve0: 10n }));
    expect(amount0).toBe(3n);
  });

  it("handles a holder owning the entire supply", () => {
    const { amount0, amount1 } = positionValue(input({ balance: 1000n }));
    expect(amount0).toBe(5_000n);
    expect(amount1).toBe(20_000n);
  });
});

describe("sharePpm", () => {
  it("reports parts per million so small stakes stay visible", () => {
    expect(sharePpm(100n, 1000n)).toBe(100_000);
    expect(sharePpm(1n, 1_000_000n)).toBe(1);
  });

  it("returns zero rather than NaN on an empty pool", () => {
    expect(sharePpm(0n, 0n)).toBe(0);
  });
});

describe("formatShare", () => {
  it("shows normal stakes as a plain percentage", () => {
    expect(formatShare(100_000)).toBe("10%");
    expect(formatShare(12_340)).toBe("1.234%");
  });

  // A dust position reading "0%" looks like a bug or a loss. It must read as
  // small-but-present.
  it("never renders a non-empty position as 0%", () => {
    expect(formatShare(1)).toBe("<0.001%");
  });

  it("shows a genuinely empty position as 0%", () => {
    expect(formatShare(0)).toBe("0%");
  });
});
