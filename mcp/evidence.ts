import { STALE_THRESHOLD } from "./sources.ts";

export const CHAIN_ID = 5042002;
export const EXPLORER = "https://testnet.arcscan.app";

export type Evidence = {
  chainId: number;
  contract?: string;
  source: "index" | "rpc";
  block: number;
  indexedBlock?: number;
  stale?: boolean;
  lag?: number;
  links: Record<string, string>;
};

export function rpcEvidence(block: number, contract?: string, links: Record<string, string> = {}): Evidence {
  return { chainId: CHAIN_ID, contract, source: "rpc", block, links };
}

export function indexEvidence(tip: number, indexedBlock: number, contract?: string, links: Record<string, string> = {}): Evidence {
  const lag = Math.max(0, tip - indexedBlock);
  const stale = lag > STALE_THRESHOLD;
  return { chainId: CHAIN_ID, contract, source: "index", block: tip, indexedBlock, stale, ...(stale ? { lag } : {}), links };
}

export const txLink = (h: string) => `${EXPLORER}/tx/${h}`;
export const addrLink = (a: string) => `${EXPLORER}/address/${a}`;
