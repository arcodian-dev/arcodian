import { useMemo, useState } from "react";
import type { LaunchAsset } from "../shared";
import { CoinIcon, quoteAmount } from "../shared";

/**
 * A dense, sortable screener table.
 *
 * The market surface rendered every token as a card, which is fine for a
 * handful of launches and unusable for the 1,100+ markets the index now
 * carries — comparing two tokens meant scrolling past everything between
 * them. A table puts market cap, liquidity, volume and the change columns on
 * one line each, which is the whole reason a trader opens a screener.
 *
 * All of it reads fields the index already produces. Nothing here fetches.
 */

export type ScreenerFilters = {
  minLiquidity: number;
  minVolume24h: number;
  maxAgeDays: number | null;
  venue: string;
};

export const DEFAULT_SCREENER_FILTERS: ScreenerFilters = { minLiquidity: 0, minVolume24h: 0, maxAgeDays: null, venue: "All" };

type SortKey = "marketCap" | "liquidity" | "volume24h" | "price" | "change5m" | "change1h" | "change24h" | "txns" | "holders" | "age";

const compact = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
};

const pct = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const pctClass = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? "flat" : value > 0 ? "up" : value < 0 ? "down" : "flat";

/** Seconds since a row was first seen, or null when the index has no date. */
function ageSeconds(item: LaunchAsset): number | null {
  const created = Number((item as { createdAt?: number }).createdAt || 0);
  // Guards the same bad data the coin terminal had to guard: external pool
  // rows briefly carried a block height here, which reads as 1970.
  if (!created || created < 1_600_000_000) return null;
  return Math.max(0, Math.floor(Date.now() / 1000) - created);
}

function ageLabel(item: LaunchAsset): string {
  const seconds = ageSeconds(item);
  if (seconds == null) return "—";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Last traded price in quote units, derived the same way the terminal does. */
function lastPrice(item: LaunchAsset): number {
  const trades = (item as { trades?: Array<{ native: string; tokens: string }> }).trades;
  const last = trades?.filter((t) => BigInt(t.tokens || 0) > 0n).at(-1);
  if (!last) return 0;
  const decimals = typeof item.quoteDecimals === "number" ? item.quoteDecimals : item.globalPool ? 6 : 18;
  return (Number(last.native) / Number(last.tokens)) * 10 ** (18 - decimals);
}

const money = (item: LaunchAsset, field: "marketCap" | "liquidity" | "volume24h" | "volume"): number =>
  quoteAmount((item as unknown as Record<string, string | undefined>)[field] || "0", item);

function sparkline(item: LaunchAsset): string | null {
  const trades = (item as { trades?: Array<{ native: string; tokens: string }> }).trades;
  const points = (trades || [])
    .filter((t) => BigInt(t.tokens || 0) > 0n)
    .slice(-40)
    .map((t) => Number(t.native) / Number(t.tokens));
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  return points
    .map((value, index) => `${(index / (points.length - 1)) * 100},${28 - ((value - min) / span) * 26 - 1}`)
    .join(" ");
}

export function ScreenerTable({ rows, filters, onFilters, onOpen }: {
  rows: LaunchAsset[];
  filters: ScreenerFilters;
  onFilters: (next: ScreenerFilters) => void;
  onOpen: (item: LaunchAsset) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("volume24h");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  // Rendering 1,100 rows at once is what a screener must not do on every
  // poll; the list grows on demand instead.
  const [limit, setLimit] = useState(60);

  const venues = useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows) if (row.dex) seen.add(row.dex);
    return ["All", ...[...seen].sort()];
  }, [rows]);

  const value = (item: LaunchAsset, key: SortKey): number => {
    switch (key) {
      case "marketCap": return money(item, "marketCap");
      case "liquidity": return money(item, "liquidity");
      case "volume24h": return money(item, "volume24h") || money(item, "volume");
      case "price": return lastPrice(item);
      case "change5m": return item.priceChange5m ?? -Infinity;
      case "change1h": return item.priceChange1h ?? -Infinity;
      case "change24h": return (item as { priceChange24h?: number }).priceChange24h ?? -Infinity;
      case "txns": return item.tradeCount || 0;
      case "holders": return item.holderCount || 0;
      case "age": return ageSeconds(item) ?? Infinity;
    }
  };

  const visible = useMemo(() => {
    const filtered = rows.filter((item) => {
      if (filters.venue !== "All" && item.dex !== filters.venue) return false;
      if (filters.minLiquidity > 0 && money(item, "liquidity") < filters.minLiquidity) return false;
      if (filters.minVolume24h > 0 && (money(item, "volume24h") || money(item, "volume")) < filters.minVolume24h) return false;
      if (filters.maxAgeDays != null) {
        const seconds = ageSeconds(item);
        // An undated row is excluded from an age filter rather than assumed
        // new — guessing would put every external pool at the top of a
        // "launched today" list.
        if (seconds == null || seconds > filters.maxAgeDays * 86400) return false;
      }
      return true;
    });
    return filtered.sort((a, b) => (value(a, sortKey) - value(b, sortKey)) * sortDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, sortKey, sortDir]);

  const head = (key: SortKey, label: string, align: "left" | "right" = "right") => (
    <th
      className={`${align === "right" ? "num" : ""} ${sortKey === key ? "sorted" : ""}`}
      onClick={() => { if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1)); else { setSortKey(key); setSortDir(-1); } }}
    >
      {label}{sortKey === key ? <i>{sortDir === -1 ? "↓" : "↑"}</i> : null}
    </th>
  );

  return <div className="screener">
    <div className="screener-filters">
      <label>
        <span>Venue</span>
        <select value={filters.venue} onChange={(e) => onFilters({ ...filters, venue: e.target.value })}>
          {venues.map((venue) => <option key={venue} value={venue}>{venue}</option>)}
        </select>
      </label>
      <label>
        <span>Min liquidity</span>
        <input type="number" min={0} step={1000} value={filters.minLiquidity || ""} placeholder="0"
          onChange={(e) => onFilters({ ...filters, minLiquidity: Number(e.target.value) || 0 })} />
      </label>
      <label>
        <span>Min 24h volume</span>
        <input type="number" min={0} step={1000} value={filters.minVolume24h || ""} placeholder="0"
          onChange={(e) => onFilters({ ...filters, minVolume24h: Number(e.target.value) || 0 })} />
      </label>
      <label>
        <span>Max age</span>
        <select value={filters.maxAgeDays ?? ""} onChange={(e) => onFilters({ ...filters, maxAgeDays: e.target.value === "" ? null : Number(e.target.value) })}>
          <option value="">Any</option>
          <option value="1">≤ 1 day</option>
          <option value="7">≤ 7 days</option>
          <option value="30">≤ 30 days</option>
        </select>
      </label>
      <button type="button" className="screener-clear" onClick={() => onFilters(DEFAULT_SCREENER_FILTERS)}>Clear</button>
      <span className="screener-count">{visible.length.toLocaleString()} of {rows.length.toLocaleString()} markets</span>
    </div>

    <div className="screener-scroll">
      <table className="screener-table">
        <thead>
          <tr>
            <th className="rank">#</th>
            <th className="token">Token</th>
            <th className="trend">Trend</th>
            {head("price", "Price")}
            {head("change5m", "5m")}
            {head("change1h", "1h")}
            {head("change24h", "24h")}
            {head("marketCap", "Mcap")}
            {head("liquidity", "Liquidity")}
            {head("volume24h", "Volume 24h")}
            {head("txns", "Txns")}
            {head("holders", "Holders")}
            {head("age", "Age")}
            <th className="venue">Venue</th>
          </tr>
        </thead>
        <tbody>
          {visible.slice(0, limit).map((item, index) => {
            const points = sparkline(item);
            const change24h = (item as { priceChange24h?: number }).priceChange24h;
            const price = lastPrice(item);
            return <tr key={`${item.address}-${index}`} onClick={() => onOpen(item)}>
              <td className="rank">{index + 1}</td>
              <td className="token">
                <span className="screener-coin">
                  <CoinIcon image={item.image} fallback={item.symbol.slice(0, 2)} />
                  <span><b>{item.symbol}</b><small>{item.name}</small></span>
                </span>
              </td>
              <td className="trend">
                {points
                  ? <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={pctClass(change24h)}><polyline points={points} /></svg>
                  : <span className="trend-empty">—</span>}
              </td>
              <td className="num mono">{price > 0 ? (price < 1e-6 ? price.toExponential(2) : price.toFixed(8)) : "—"}</td>
              <td className={`num ${pctClass(item.priceChange5m)}`}>{pct(item.priceChange5m)}</td>
              <td className={`num ${pctClass(item.priceChange1h)}`}>{pct(item.priceChange1h)}</td>
              <td className={`num ${pctClass(change24h)}`}>{pct(change24h)}</td>
              <td className="num mono">{compact(money(item, "marketCap"))}</td>
              <td className="num mono">{compact(money(item, "liquidity"))}</td>
              <td className="num mono">{compact(money(item, "volume24h") || money(item, "volume"))}</td>
              <td className="num">{(item.tradeCount || 0).toLocaleString()}</td>
              <td className="num">{(item.holderCount || 0).toLocaleString()}</td>
              <td className="num">{ageLabel(item)}</td>
              <td className="venue"><span>{item.dex || (item.globalPool ? "External" : "Arcodian")}</span></td>
            </tr>;
          })}
        </tbody>
      </table>
      {!visible.length && <p className="screener-empty">No market matches these filters.</p>}
      {visible.length > limit && (
        <button type="button" className="screener-more" onClick={() => setLimit((n) => n + 120)}>
          Show more · {(visible.length - limit).toLocaleString()} remaining
        </button>
      )}
    </div>
  </div>;
}
