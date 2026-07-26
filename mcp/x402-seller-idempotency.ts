import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CachedSellerResponse = {
  signatureHash: string;
  paymentResponse: string;
  status: number;
  body: unknown;
};
type CacheData = { version: 1; responses: Record<string, CachedSellerResponse> };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class SellerReplayCache {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(path = process.env.X402_SELLER_REPLAY_CACHE || "/var/lib/arcodian-x402/replays.json") {
    this.path = path;
  }
  private async load(): Promise<CacheData> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed?.version !== 1 || typeof parsed?.responses !== "object") throw new Error("invalid seller replay cache");
      return parsed;
    } catch (error: any) {
      if (error?.code === "ENOENT") return { version: 1, responses: {} };
      throw error;
    }
  }
  private async save(data: CacheData) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
  }
  async lookup(idempotencyKey: string, paymentSignature: string) {
    const item = (await this.load()).responses[idempotencyKey];
    if (!item) return null;
    if (item.signatureHash !== hash(paymentSignature)) throw new Error("idempotency conflict");
    return item;
  }
  async store(idempotencyKey: string, paymentSignature: string, response: Omit<CachedSellerResponse, "signatureHash">) {
    let result!: CachedSellerResponse;
    const op = this.queue.then(async () => {
      const data = await this.load();
      const signatureHash = hash(paymentSignature);
      const existing = data.responses[idempotencyKey];
      if (existing) {
        if (existing.signatureHash !== signatureHash || JSON.stringify(existing) !== JSON.stringify({ signatureHash, ...response })) {
          throw new Error("idempotency conflict");
        }
        result = existing;
        return;
      }
      result = { signatureHash, ...response };
      data.responses[idempotencyKey] = result;
      await this.save(data);
    });
    this.queue = op.catch(() => undefined);
    await op;
    return result;
  }
}

/** Express-compatible middleware placed before Circle's settlement middleware. */
export function createSellerReplayMiddleware(cache: SellerReplayCache) {
  return async (req: any, res: any, next: (error?: unknown) => void) => {
    const key = String(req.headers?.["x-arcodian-idempotency-key"] ?? "");
    const signature = String(req.headers?.["payment-signature"] ?? "");
    if (!key || !signature) return next();
    try {
      const hit = await cache.lookup(key, signature);
      if (!hit) return next();
      res.setHeader("PAYMENT-RESPONSE", hit.paymentResponse);
      res.setHeader("X-ARCODIAN-IDEMPOTENT-REPLAY", "true");
      return res.status(hit.status).json(hit.body);
    } catch (error) {
      return res.status(409).json({ error: "idempotency conflict" });
    }
  };
}
