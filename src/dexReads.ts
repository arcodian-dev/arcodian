import { Contract, type ContractRunner } from "ethers";
import { ARC_PAIR_FACTORY_ADDRESS } from "./config";
import { TIERS, type PairQuote, type Tier } from "./dex";

export const ERC20_META_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

export const FACTORY_ABI = [
  "function getPair(address,address,uint16) view returns (address)",
  "function createPair(address,address,uint16) returns (address)",
];

export const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function reserve0() view returns (uint256)",
  "function reserve1() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function quote(bool,uint256) view returns (uint256)",
  "function swap(bool,uint256,uint256,uint64) returns (uint256)",
  "function addLiquidity(uint256,uint256,uint256,uint64) returns (uint256)",
  "function removeLiquidity(uint256,uint256,uint256,uint64) returns (uint256,uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

export type TokenMeta = { address: string; symbol: string; name: string; decimals: number; pair?: string };

/** Read a token's identity from the chain. Never trust a symbol supplied elsewhere. */
export async function readToken(runner: ContractRunner, address: string): Promise<TokenMeta> {
  const token = new Contract(address, ERC20_META_ABI, runner);
  const [symbol, name, decimals] = await Promise.all([token.symbol(), token.name(), token.decimals()]);
  return { address, symbol: String(symbol), name: String(name), decimals: Number(decimals) };
}

/**
 * Quote a swap at every tier that has a pair. Returns one entry per existing
 * pair; `bestQuote` picks between them.
 */
export async function quoteAllTiers(
  runner: ContractRunner,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  factoryAddress: string = ARC_PAIR_FACTORY_ADDRESS,
): Promise<PairQuote[]> {
  const factory = new Contract(factoryAddress, FACTORY_ABI, runner);
  const results: PairQuote[] = [];

  for (const tier of TIERS) {
    let pairAddress: string;
    try {
      pairAddress = (await factory.getPair(tokenIn, tokenOut, tier)) as string;
    } catch {
      continue;
    }
    if (!pairAddress || /^0x0+$/.test(pairAddress)) continue;

    try {
      const pair = new Contract(pairAddress, PAIR_ABI, runner);
      const [token0, reserve0, reserve1] = await Promise.all([
        pair.token0(), pair.reserve0(), pair.reserve1(),
      ]);
      const zeroForOne = (token0 as string).toLowerCase() === tokenIn.toLowerCase();
      const out = (await pair.quote(zeroForOne, amountIn)) as bigint;
      const [reserveIn, reserveOut] = zeroForOne
        ? [reserve0 as bigint, reserve1 as bigint]
        : [reserve1 as bigint, reserve0 as bigint];
      results.push({ pair: pairAddress, tier: tier as Tier, out, reserveIn, reserveOut });
    } catch {
      // A pair that cannot be read is simply not offered as a route.
    }
  }
  return results;
}

/** Whether tokenIn is token0 of the given pair — needed for the swap direction flag. */
export async function isZeroForOne(runner: ContractRunner, pair: string, tokenIn: string): Promise<boolean> {
  const token0 = (await new Contract(pair, PAIR_ABI, runner).token0()) as string;
  return token0.toLowerCase() === tokenIn.toLowerCase();
}
