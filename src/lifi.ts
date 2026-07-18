import { LIFI_API, INTEGRATOR } from "./config";

export type Quote = {
  id: string;
  estimate: { fromAmount: string; toAmount: string; toAmountMin: string; executionDuration: number; approvalAddress?: string };
  action: { fromChainId: number; fromToken: { address: string; symbol: string; decimals: number }; toToken: { address: string; symbol: string; decimals: number } };
  transactionRequest?: { to: string; data: string; value?: string; gasLimit?: string; gasPrice?: string; chainId?: number };
};

export async function getQuote(input: {
  fromChain: number; toChain: number; fromToken: string; toToken: string;
  fromAmount: string; fromAddress: string;
}): Promise<Quote> {
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)])),
    integrator: INTEGRATOR,
    slippage: "0.005",
  });
  const response = await fetch(`${LIFI_API}/quote?${query}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.message || body?.errors?.[0]?.message || "Route unavailable");
  return body as Quote;
}

export function displayAmount(raw: string, decimals: number, precision = 6): string {
  const value = Number(raw) / 10 ** decimals;
  return value.toLocaleString(undefined, { maximumFractionDigits: precision });
}
