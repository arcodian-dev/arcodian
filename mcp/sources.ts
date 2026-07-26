import { JsonRpcProvider } from "ethers";

export const ARC_RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network/";
export const FEED_BASE = process.env.ARC_FEED_BASE || "https://arcodian.fun/developers";
export const STALE_THRESHOLD = Number(process.env.MCP_STALE_THRESHOLD || 50);
const INDEX_TTL_MS = 15_000;
const TIP_TTL_MS = 5_000;

export type Ctx = {
  loadIndex(name: string): Promise<any>;
  provider(): JsonRpcProvider;
  tipBlock(): Promise<number>;
};

export function makeCtx(): Ctx {
  const cache = new Map<string, { t: number; v: any }>();
  let prov: JsonRpcProvider | null = null;
  let tip = { t: 0, v: 0 };

  const self: Ctx = {
    async loadIndex(name) {
      const hit = cache.get(name);
      if (hit && Date.now() - hit.t < INDEX_TTL_MS) return hit.v;
      const res = await fetch(`${FEED_BASE}/${name}.json`, { cache: "no-store" } as any);
      if (!res.ok) throw new Error(`index ${name} unavailable (${res.status})`);
      const v = await res.json();
      cache.set(name, { t: Date.now(), v });
      return v;
    },
    provider() {
      return (prov ??= new JsonRpcProvider(ARC_RPC, undefined, { batchMaxCount: 1 }));
    },
    async tipBlock() {
      if (Date.now() - tip.t < TIP_TTL_MS && tip.v) return tip.v;
      tip = { t: Date.now(), v: await self.provider().getBlockNumber() };
      return tip.v;
    },
  };
  return self;
}
