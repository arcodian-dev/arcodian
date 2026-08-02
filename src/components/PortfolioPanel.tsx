import { useEffect, useMemo, useState } from "react";
import { Contract, formatUnits } from "ethers";
import { ARC, ARC_EURC_ADDRESS, ARC_MAINNET, ARC_MAINNET_CONTRACTS, ARC_PAIR_FACTORY_ADDRESS } from "../config";
import { arcProvider } from "../shared";
import { shortAddress } from "../dex";
import { ERC20_META_ABI, readToken, type TokenMeta } from "../dexReads";
import { fetchLpPositions, type LpPosition } from "../portfolioReads";
import { formatShare } from "../portfolio";

type Holding = { token: TokenMeta; balance: bigint };

function amount(value: bigint, decimals: number): string {
  return Number(formatUnits(value, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function PortfolioPanel({ account, onConnect, onManagePool, chainId }: {
  account: string;
  onConnect: () => void;
  onManagePool: (pair: string) => void;
  chainId?: number | null;
}) {
  const isMainnet = chainId == null || chainId === ARC_MAINNET.id;
  const activeArc = isMainnet ? ARC_MAINNET : ARC;
  const activeFactory = isMainnet ? ARC_MAINNET_CONTRACTS.marketPairFactory : ARC_PAIR_FACTORY_ADDRESS;
  // Native USDC lives at the same fixed address on both networks; EURC only
  // exists on testnet, so mainnet's holdings row is USDC-only.
  const watchedTokens = isMainnet ? [ARC.nativeToken] : [ARC.nativeToken, ARC_EURC_ADDRESS];
  const read = useMemo(() => arcProvider(activeArc), [activeArc]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [positions, setPositions] = useState<LpPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!account) { setHoldings([]); setPositions([]); setFailed(false); return; }
    setLoading(true);
    setFailed(false);
    (async () => {
      try {
        const balances = await Promise.all(
          watchedTokens.map(async (address) => ({
            token: await readToken(read, address),
            balance: (await new Contract(address, ERC20_META_ABI, read).balanceOf(account)) as bigint,
          })),
        );
        const lp = await fetchLpPositions(read, account, activeFactory);
        if (!alive) return;
        setHoldings(balances);
        setPositions(lp);
      } catch {
        // Distinguish "nothing to show" from "could not read the chain" — the
        // first is a real empty portfolio, the second is a lie if shown as one.
        if (alive) setFailed(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [account, read, activeFactory]);

  if (!account) {
    return (
      <div className="dex-panel">
        <p className="dex-note">Connect a wallet to see your balances and liquidity positions.</p>
        <button type="button" className="dex-cta" onClick={onConnect}>Connect wallet</button>
      </div>
    );
  }

  return (
    <div className="dex-panel">
      <div className="dex-summary">
        {holdings.map(({ token, balance }) => (
          <span key={token.address}>
            <small>{token.symbol}</small>
            <b>{amount(balance, token.decimals)}</b>
          </span>
        ))}
        {holdings.length === 0 && <span><small>Balances</small><b>{loading ? "Loading…" : "—"}</b></span>}
      </div>

      <label className="dex-label">Liquidity positions</label>

      {failed ? (
        <p className="dex-warning">
          Could not read the chain just now, so this list may be incomplete.
          Reload before concluding a position is missing.
        </p>
      ) : loading ? (
        <p className="dex-note">Reading positions…</p>
      ) : positions.length === 0 ? (
        <p className="dex-note">
          No liquidity positions yet. Add liquidity from the Pools tab and it
          will appear here.
        </p>
      ) : (
        <ul className="portfolio-positions">
          {positions.map((position) => (
            <li key={position.pair}>
              <div>
                <b>{position.token0.symbol} / {position.token1.symbol}</b>
                <small>{position.tier / 100}% tier · {shortAddress(position.pair)}</small>
              </div>
              <div>
                <b>
                  {amount(position.amount0, position.token0.decimals)} {position.token0.symbol}
                  {" + "}
                  {amount(position.amount1, position.token1.decimals)} {position.token1.symbol}
                </b>
                <small>{formatShare(position.sharePpm)} of the pool</small>
              </div>
              <button type="button" className="dex-secondary" onClick={() => onManagePool(position.pair)}>
                Manage
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="dex-note">
        Position values include the trading fees earned so far — fees compound
        into the pool rather than accruing separately, so there is nothing to
        claim. Withdrawing returns your principal and your share of fees
        together.
      </p>
    </div>
  );
}
