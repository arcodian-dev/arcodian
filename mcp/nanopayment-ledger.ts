import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type NanopaymentIntent = {
  idempotencyKey: string;
  createdAt: string;
  authorizationDigest: string;
  boundWallet: string;
  agentId: string;
  vault: string;
  serviceId: string;
  requestHash: string;
  amount: string;
  payTo: string;
  asset: string;
  network: string;
  typedData: Record<string, unknown>;
  status: "pending" | "settled";
  receipt?: Record<string, unknown>;
};

type LedgerData = { version: 1; intents: Record<string, NanopaymentIntent> };
export interface NanopaymentLedger {
  get(key: string): Promise<NanopaymentIntent | null>;
  put(intent: NanopaymentIntent): Promise<{ intent: NanopaymentIntent; reused: boolean }>;
  settle(key: string, receipt: Record<string, unknown>): Promise<NanopaymentIntent>;
}

export class FileNanopaymentLedger implements NanopaymentLedger {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;
  constructor(path = process.env.MCP_NANOPAYMENT_LEDGER || "/var/lib/arcodian-mcp/nanopayments.json") {
    this.path = path;
  }

  private async load(): Promise<LedgerData> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed?.version !== 1 || typeof parsed?.intents !== "object") throw new Error("invalid nanopayment ledger");
      return parsed;
    } catch (error: any) {
      if (error?.code === "ENOENT") return { version: 1, intents: {} };
      throw error;
    }
  }

  private async save(data: LedgerData) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
  }

  async get(key: string) {
    const data = await this.load();
    return data.intents[key] ?? null;
  }

  async put(intent: NanopaymentIntent): Promise<{ intent: NanopaymentIntent; reused: boolean }> {
    let result!: { intent: NanopaymentIntent; reused: boolean };
    this.queue = this.queue.then(async () => {
      const data = await this.load();
      const existing = data.intents[intent.idempotencyKey];
      if (existing) {
        const immutable = ["authorizationDigest", "boundWallet", "agentId", "vault", "serviceId", "requestHash", "amount", "payTo", "asset", "network"] as const;
        if (immutable.some((key) => existing[key] !== intent[key])) throw new Error("idempotency conflict");
        result = { intent: existing, reused: true };
        return;
      }
      data.intents[intent.idempotencyKey] = intent;
      await this.save(data);
      result = { intent, reused: false };
    });
    await this.queue;
    return result;
  }

  async settle(key: string, receipt: Record<string, unknown>) {
    let result!: NanopaymentIntent;
    this.queue = this.queue.then(async () => {
      const data = await this.load();
      const existing = data.intents[key];
      if (!existing) throw new Error("unknown idempotency key");
      if (existing.status === "settled") {
        if (JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) throw new Error("settled receipt conflict");
        result = existing;
        return;
      }
      result = { ...existing, status: "settled", receipt };
      data.intents[key] = result;
      await this.save(data);
    });
    await this.queue;
    return result;
  }
}
