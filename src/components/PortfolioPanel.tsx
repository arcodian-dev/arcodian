import { useEffect, useState } from "react";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { ARC, ARC_EURC_ADDRESS } from "../config";
import { shortAddress } from "../dex";
import { ERC20_META_ABI, readToken, type TokenMeta } from "../dexReads";
import { fetchLpPositions, type LpPosition } from "../portfolioReads";
import { formatShare } from "../portfolio";

const read = new JsonRpcProvider(ARC.rpc, undefined, { batchMaxCount: 1 });

type Holding = { token: TokenMeta; balance: bigint };

function amount(value: bigint, decimals: number): string {
  return Number(formatUnits(value, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function PortfolioPanel({ account, onConnect, onManagePool }: {
  account: string;
  onConnect: () => void;
  onManagePool: (pair: string) => void;
}) {
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
          [ARC.nativeToken, ARC_EURC_ADDRESS].map(async (address) => ({
            token: await readToken(read, address),
            balance: (await new Contract(address, ERC20_META_ABI, read).balanceOf(account)) as bigint,
          })),
        );
        const lp = await fetchLpPositions(read, account);
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
  }, [account]);

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
