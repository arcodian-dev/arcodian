import { Contract, type ContractRunner } from "ethers";
import { ARC_FX_POOL_ADDRESS } from "./config";
import type { FxRate } from "./fx";

/** One whole USDC in the pool's 6-decimal interface. */
const ONE_UNIT_6 = 1_000000n;

export const FX_POOL_ABI = ["function quote(bool usdcToEurc, uint256 amountIn) view returns (uint256)"];

/**
 * Convert the pool's 6-decimal "EURC out for 1 USDC in" quote into a rate.
 * An empty pool quotes 0; fall back to parity so the UI shows numbers rather
 * than NaN, and so a missing pool never blocks a direct-route buy.
 */
export function rateFromQuote(eurcOutFor1Usdc: bigint): FxRate {
  if (eurcOutFor1Usdc <= 0n) return { eurcPerUsdc: 1, usdcPerEurc: 1 };
  const eurcPerUsdc = Number(eurcOutFor1Usdc) / Number(ONE_UNIT_6);
  return { eurcPerUsdc, usdcPerEurc: 1 / eurcPerUsdc };
}

/** Read the live rate. Callers should treat a thrown error as "use parity". */
export async function fetchFxRate(runner: ContractRunner): Promise<FxRate> {
  const pool = new Contract(ARC_FX_POOL_ADDRESS, FX_POOL_ABI, runner);
  const out = (await pool.quote(true, ONE_UNIT_6)) as bigint;
  return rateFromQuote(out);
}
