import { DurableJsonState } from "./durable-json-state.ts";

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
  private readonly state: DurableJsonState<LedgerData>;
  constructor(path = process.env.MCP_NANOPAYMENT_LEDGER || "/var/lib/arcodian-mcp/nanopayments.json") {
    this.path = path;
    this.state = new DurableJsonState("nanopayments", path, { version: 1, intents: {} },
      process.env.MCP_STATE_DB || (path === "/var/lib/arcodian-mcp/nanopayments.json" ? undefined : `${path}.db`));
  }

  private async load(): Promise<LedgerData> {
    const parsed = this.state.read();
    if (parsed?.version !== 1 || typeof parsed?.intents !== "object") throw new Error("invalid nanopayment ledger");
    return parsed;
  }

  private async save(data: LedgerData) {
    this.state.write(data);
  }

  async get(key: string) {
    const data = await this.load();
    return data.intents[key] ?? null;
  }

  async put(intent: NanopaymentIntent): Promise<{ intent: NanopaymentIntent; reused: boolean }> {
    let result!: { intent: NanopaymentIntent; reused: boolean };
    const op = this.queue.then(async () => {
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
    this.queue = op.catch(() => undefined);
    await op;
    return result;
  }

  async settle(key: string, receipt: Record<string, unknown>) {
    let result!: NanopaymentIntent;
    const op = this.queue.then(async () => {
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
    this.queue = op.catch(() => undefined);
    await op;
    return result;
  }
}
