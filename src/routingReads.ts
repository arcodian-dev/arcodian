import { Contract, type ContractRunner } from "ethers";
import { ARC_EURC_ADDRESS, ARC_PAIR_FACTORY_ADDRESS, ARC_USDC_ERC20 } from "./config";
import { bestQuote } from "./dex";
import { FACTORY_ABI, PAIR_ABI, quoteAllTiers } from "./dexReads";
import { ROUTE_TIER, bestRoute, directRouteFrom, type DirectRoute, type MultiRoute, type Route } from "./routing";

export const ROUTER_ABI = [
  "function swapExactTokensForTokens(address[],uint256,uint256,uint64) returns (uint256)",
];

/**
 * Tokens a route may pass through.
 *
 * USDC and EURC only, and deliberately so: they are where depth actually is.
 * Every graduated launch opens a pair against its quote currency, so a launched
 * coin is reachable from USDC or EURC, while coin-to-coin pairs are rare and
 * thin. Routing through an arbitrary third coin would mostly find worse prices
 * at more gas, and would grow the quote cost quadratically.
 */
export const ROUTE_HUBS = [ARC_USDC_ERC20, ARC_EURC_ADDRESS];

const ZERO = /^0x0+$/;

/** One hop, at the only tier ArcRouter traverses. Null if it cannot be routed. */
async function quoteHop(
  runner: ContractRunner,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<{ pair: string; out: bigint } | null> {
  if (amountIn <= 0n) return null;
  try {
    const factory = new Contract(ARC_PAIR_FACTORY_ADDRESS, FACTORY_ABI, runner);
    const pairAddress = (await factory.getPair(tokenIn, tokenOut, ROUTE_TIER)) as string;
    if (!pairAddress || ZERO.test(pairAddress)) return null;

    const pair = new Contract(pairAddress, PAIR_ABI, runner);
    const token0 = (await pair.token0()) as string;
    const out = (await pair.quote(token0.toLowerCase() === tokenIn.toLowerCase(), amountIn)) as bigint;
    return out > 0n ? { pair: pairAddress, out } : null;
  } catch {
    // An unreadable pair is simply not offered as a route.
    return null;
  }
}

/**
 * Quote every route worth considering and return both the winner and the direct
 * route it was measured against.
 *
 * The direct route is returned even when it loses, so the UI can show what the
 * multi-hop path is actually buying the user rather than asking them to trust
 * that it is better.
 */
export async function findBestRoute(
  runner: ContractRunner,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<{ chosen: Route | null; direct: DirectRoute | null }> {
  if (amountIn <= 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return { chosen: null, direct: null };
  }

  const directQuote = bestQuote(await quoteAllTiers(runner, tokenIn, tokenOut, amountIn));
  const direct = directQuote ? directRouteFrom(directQuote, tokenIn, tokenOut) : null;

  const ends = [tokenIn.toLowerCase(), tokenOut.toLowerCase()];
  const hubs = ROUTE_HUBS.filter((hub) => !ends.includes(hub.toLowerCase()));

  const multi: MultiRoute[] = [];
  for (const hub of hubs) {
    const first = await quoteHop(runner, tokenIn, hub, amountIn);
    if (!first) continue;
    const second = await quoteHop(runner, hub, tokenOut, first.out);
    if (!second) continue;
    multi.push({
      kind: "multi",
      out: second.out,
      path: [tokenIn, hub, tokenOut],
      pairs: [first.pair, second.pair],
      tier: ROUTE_TIER,
    });
  }

  return { chosen: bestRoute(direct, multi), direct };
}
