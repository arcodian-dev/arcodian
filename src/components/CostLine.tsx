import type { TrueCost } from "../fx";

/**
 * The single honest readout: what leaves the wallet, what arrives, total fee.
 * The cross-route premium is shown, never hidden — see the spec's Fees table.
 */
export function CostLine({ cost, holding, quoteCurrency, tokensOut, symbol }: {
  cost: TrueCost;
  holding: string;
  quoteCurrency: string;
  tokensOut: string;
  symbol: string;
}) {
  return (
    <p className="cost-line">
      <span>Pay <strong>{cost.pays.toFixed(2)} {holding}</strong></span>
      <span aria-hidden="true"> · </span>
      <span>get ~<strong>{tokensOut} {symbol}</strong></span>
      <span aria-hidden="true"> · </span>
      <span>fee <strong>{(cost.feeBps / 100).toFixed(2)}%</strong></span>
      {cost.route === "cross" && (
        <span className="cost-line-note"> (via FX {cost.quoteDelivered.toFixed(2)} {quoteCurrency})</span>
      )}
    </p>
  );
}
