import { Contract, type ContractRunner } from "ethers";
import { ARC_PAIR_FACTORY_ADDRESS } from "./config";
import { PAIR_ABI, readToken, type TokenMeta } from "./dexReads";
import { positionValue, sharePpm } from "./portfolio";

const FACTORY_ENUMERATION_ABI = [
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
];

export type LpPosition = {
  pair: string;
  tier: number;
  token0: TokenMeta;
  token1: TokenMeta;
  balance: bigint;
  totalSupply: bigint;
  amount0: bigint;
  amount1: bigint;
  sharePpm: number;
};

/**
 * Every pair the account holds LP shares in.
 *
 * This walks the whole registry and reads a balance per pair. That is O(pairs)
 * calls and is honest only while the registry is small — which it is today. If
 * the registry grows past a few hundred pairs this needs an indexer or a
 * Transfer-log scan instead; it is not a design that scales quietly.
 *
 * A pair that fails to read is skipped rather than failing the whole view: one
 * broken token should not hide a user's other positions.
 */
export async function fetchLpPositions(runner: ContractRunner, account: string, factoryAddress: string = ARC_PAIR_FACTORY_ADDRESS): Promise<LpPosition[]> {
  const factory = new Contract(factoryAddress, FACTORY_ENUMERATION_ABI, runner);
  const length = Number((await factory.allPairsLength()) as bigint);
  const positions: LpPosition[] = [];

  for (let index = 0; index < length; index += 1) {
    try {
      const pairAddress = (await factory.allPairs(index)) as string;
      const pair = new Contract(pairAddress, PAIR_ABI, runner);

      const balance = (await pair.balanceOf(account)) as bigint;
      if (balance <= 0n) continue; // not a provider here; skip the extra reads

      const [token0Address, token1Address, reserve0, reserve1, totalSupply, feeBps] = await Promise.all([
        pair.token0(), pair.token1(), pair.reserve0(), pair.reserve1(), pair.totalSupply(), pair.feeBps(),
      ]);
      const [token0, token1] = await Promise.all([
        readToken(runner, token0Address as string),
        readToken(runner, token1Address as string),
      ]);

      const { amount0, amount1 } = positionValue({
        balance,
        totalSupply: totalSupply as bigint,
        reserve0: reserve0 as bigint,
        reserve1: reserve1 as bigint,
      });

      positions.push({
        pair: pairAddress,
        tier: Number(feeBps),
        token0, token1, balance,
        totalSupply: totalSupply as bigint,
        amount0, amount1,
        sharePpm: sharePpm(balance, totalSupply as bigint),
      });
    } catch {
      // Unreadable pair — omitted rather than allowed to break the view.
    }
  }

  return positions;
}
