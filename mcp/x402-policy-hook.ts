import { Contract, getAddress } from "ethers";
import type { NanopaymentLedger } from "./nanopayment-ledger.ts";
import { AGENT_PASSPORT_ABI, AGENT_PASSPORT_ADDRESS } from "./tools/_config.ts";

type PaymentPayload = { payload?: { authorization?: { from?: string; nonce?: string } } };
type PassportReader = (agentId: string) => Promise<string>;

/**
 * Seller-side pre-settlement guard. Gateway authorizations are valid for at
 * least seven days, so policy must be rechecked immediately before settlement.
 * The deterministic nonce is the Arcodian idempotency key.
 */
export async function assertCurrentPassportBinding(
  paymentPayload: PaymentPayload,
  ledger: NanopaymentLedger,
  readWallet: PassportReader,
) {
  const authorization = paymentPayload?.payload?.authorization;
  const nonce = String(authorization?.nonce ?? "");
  const from = getAddress(String(authorization?.from ?? ""));
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("authorization nonce is not an Arcodian idempotency key");
  const intent = await ledger.get(nonce);
  if (!intent) throw new Error("unknown nanopayment intent");
  if (intent.status !== "pending") throw new Error("nanopayment intent already settled");
  const currentWallet = getAddress(await readWallet(intent.agentId));
  if (currentWallet !== getAddress(intent.boundWallet) || currentWallet !== from) {
    throw new Error("Passport binding changed after authorization");
  }
  const validBefore = Number((intent.typedData as any)?.message?.validBefore ?? 0);
  if (validBefore <= Math.floor(Date.now() / 1000)) throw new Error("nanopayment authorization expired");
  return intent;
}

export function createPassportBeforeSettleHook(
  ledger: NanopaymentLedger,
  provider: any,
) {
  const passport = new Contract(AGENT_PASSPORT_ADDRESS, AGENT_PASSPORT_ABI, provider);
  return async (context: { paymentPayload: PaymentPayload }) => {
    try {
      await assertCurrentPassportBinding(
        context.paymentPayload,
        ledger,
        async (agentId) => passport.walletOf(BigInt(agentId)),
      );
    } catch (error: any) {
      return { abort: true as const, reason: error?.message || "Passport policy rejected" };
    }
  };
}
