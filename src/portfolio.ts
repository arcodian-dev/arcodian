/**
 * Pure position math for the portfolio view. No chain access, so every rule
 * here is testable on its own.
 *
 * The one invariant that matters: a holder's claim is always rounded DOWN.
 * Rounding up would let the sum of all positions exceed what the pool actually
 * holds, which turns a display bug into an accounting lie.
 */

export type PositionInput = {
  balance: bigint;
  totalSupply: bigint;
  reserve0: bigint;
  reserve1: bigint;
};

export type PositionValue = { amount0: bigint; amount1: bigint };

export function positionValue({ balance, totalSupply, reserve0, reserve1 }: PositionInput): PositionValue {
  if (totalSupply <= 0n || balance <= 0n) return { amount0: 0n, amount1: 0n };
  return {
    amount0: (reserve0 * balance) / totalSupply,
    amount1: (reserve1 * balance) / totalSupply,
  };
}

/**
 * Ownership in parts per million. Percent alone loses small stakes to rounding,
 * and an early liquidity provider in a large pool is exactly the case that must
 * stay legible.
 */
export function sharePpm(balance: bigint, totalSupply: bigint): number {
  if (totalSupply <= 0n) return 0;
  return Number((balance * 1_000_000n) / totalSupply);
}

/** Render a ppm share as a percentage, never collapsing a real stake to "0%". */
export function formatShare(ppm: number): string {
  if (ppm <= 0) return "0%";
  const percent = ppm / 10_000;
  if (percent < 0.001) return "<0.001%";
  return `${Number(percent.toFixed(3))}%`;
}
