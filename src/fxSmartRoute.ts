export type FxVenue = "arcodian" | "aggregator";

export type FxQuote = {
  venue: FxVenue;
  provider: string;
  amountOut: bigint;
  allowanceTarget?: string;
  transaction?: { to: string; data: string; value: bigint };
  protocolFeeBps?: number;
  protocolFeeRecipient?: string;
};

export function chooseBestFxQuote(quotes: Array<FxQuote | null | undefined>): FxQuote | null {
  const valid = quotes.filter((quote): quote is FxQuote => Boolean(quote && quote.amountOut > 0n));
  if (!valid.length) return null;
  return valid.reduce((best, quote) => quote.amountOut > best.amountOut ? quote : best);
}

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const dataPattern = /^0x(?:[a-fA-F0-9]{2})*$/;

export function parseAggregatorQuote(
  payload: unknown,
  allowedTargets: readonly string[],
  expectedFeeRecipient: string,
  expectedFeeBps: number,
): FxQuote {
  const value = payload as {
    provider?: unknown;
    amountOut?: unknown;
    allowanceTarget?: unknown;
    transaction?: { to?: unknown; data?: unknown; value?: unknown };
    protocolFeeBps?: unknown;
    protocolFeeRecipient?: unknown;
  };
  const amountOut = typeof value.amountOut === "string" && /^\d+$/.test(value.amountOut)
    ? BigInt(value.amountOut)
    : 0n;
  const to = value.transaction?.to;
  const data = value.transaction?.data;
  const allowanceTarget = value.allowanceTarget;
  const allow = new Set(allowedTargets.map((target) => target.toLowerCase()));
  if (!amountOut || typeof to !== "string" || !addressPattern.test(to) || !allow.has(to.toLowerCase())) {
    throw new Error("Aggregator returned an untrusted execution target.");
  }
  if (typeof data !== "string" || !dataPattern.test(data)) throw new Error("Aggregator returned invalid calldata.");
  if (typeof allowanceTarget !== "string" || !addressPattern.test(allowanceTarget) || !allow.has(allowanceTarget.toLowerCase())) {
    throw new Error("Aggregator returned an untrusted allowance target.");
  }
  if (value.protocolFeeBps !== expectedFeeBps) throw new Error("Aggregator fee does not match policy.");
  if (typeof value.protocolFeeRecipient !== "string"
    || value.protocolFeeRecipient.toLowerCase() !== expectedFeeRecipient.toLowerCase()) {
    throw new Error("Aggregator fee recipient does not match treasury policy.");
  }
  const rawValue = value.transaction?.value;
  const transactionValue = typeof rawValue === "string" && /^\d+$/.test(rawValue) ? BigInt(rawValue) : 0n;
  return {
    venue: "aggregator",
    provider: typeof value.provider === "string" ? value.provider.slice(0, 40) : "External aggregator",
    amountOut,
    allowanceTarget,
    transaction: { to, data, value: transactionValue },
    protocolFeeBps: expectedFeeBps,
    protocolFeeRecipient: expectedFeeRecipient,
  };
}
