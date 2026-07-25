import { getAddress, isAddress, parseEther } from "ethers";

export const ARC_PAY_MERCHANT_FEE_BPS = 30;

export type ArcPayRequest = {
  recipient: string;
  amount: string;
  memo: string;
  invoiceId: string;
  expiresAt: number;
  chainId: number;
  contract: string;
};

export type WalletContact = { name: string; address: string; favorite?: boolean; lastUsedAt?: number };

export function recipientFingerprint(value: string): string {
  const address = normalizeRecipient(value);
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export function recipientSafety(value: string, known: WalletContact[] = [], ownAddress = "") {
  const address = normalizeRecipient(value);
  if (ownAddress && address.toLowerCase() === normalizeRecipient(ownAddress).toLowerCase()) {
    return { level: "warning" as const, code: "self", message: "This is your own wallet address." };
  }
  const exact = known.find((item) => normalizeRecipient(item.address).toLowerCase() === address.toLowerCase());
  if (exact) return { level: "trusted" as const, code: "known", message: `Saved contact: ${exact.name}` };
  const lookalike = known.find((item) => {
    const saved = normalizeRecipient(item.address).toLowerCase();
    const candidate = address.toLowerCase();
    return saved !== candidate && (saved.slice(0, 8) === candidate.slice(0, 8) || saved.slice(-6) === candidate.slice(-6));
  });
  if (lookalike) return { level: "danger" as const, code: "lookalike", message: `Possible address poisoning: resembles ${lookalike.name}, but is not identical.` };
  return { level: "warning" as const, code: "new", message: "New recipient. Verify the full address before signing." };
}

export function walletTransferFee(): bigint {
  return 0n;
}

export function arcPayFee(amountMinor: bigint, feeBps = ARC_PAY_MERCHANT_FEE_BPS): bigint {
  if (amountMinor < 0n) throw new Error("Amount cannot be negative");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new Error("Invalid fee rate");
  return (amountMinor * BigInt(feeBps) + 9_999n) / 10_000n;
}

export function parseArcNativeAmount(value: string): bigint {
  const clean = value.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(clean) || Number(clean) <= 0) throw new Error("Enter a valid amount");
  return parseEther(clean);
}

export function normalizeRecipient(value: string): string {
  const clean = value.trim();
  if (!isAddress(clean)) throw new Error("Enter a valid 0x wallet address");
  return getAddress(clean);
}

export function arcPayUri(
  recipient: string,
  amount?: string,
  memo?: string,
  settlement?: { invoiceId: string; expiresAt: number; chainId: number; contract: string },
): string {
  const address = normalizeRecipient(recipient);
  const params = new URLSearchParams();
  if (amount?.trim()) params.set("amount", amount.trim());
  if (memo?.trim()) params.set("memo", memo.trim().slice(0, 120));
  if (settlement) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(settlement.invoiceId)) throw new Error("Invalid invoice ID");
    if (!Number.isSafeInteger(settlement.expiresAt) || settlement.expiresAt <= 0) throw new Error("Invalid expiry");
    params.set("invoice", settlement.invoiceId.toLowerCase());
    params.set("expires", String(settlement.expiresAt));
    params.set("chainId", String(settlement.chainId));
    params.set("contract", normalizeRecipient(settlement.contract));
  }
  const query = params.toString();
  return `arcodian:pay/${address}${query ? `?${query}` : ""}`;
}

export function parseArcPayUri(value: string): ArcPayRequest {
  const clean = value.trim();
  if (!clean.startsWith("arcodian:pay/")) throw new Error("Not an Arc Pay request");
  const parsed = new URL(clean.replace("arcodian:", "https://arcodian.local/"));
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "pay" || !parts[1]) throw new Error("Missing merchant address");
  const amount = parsed.searchParams.get("amount") || "";
  parseArcNativeAmount(amount);
  const invoiceId = parsed.searchParams.get("invoice") || "";
  if (!/^0x[a-fA-F0-9]{64}$/.test(invoiceId)) throw new Error("Invalid invoice ID");
  const expiresAt = Number(parsed.searchParams.get("expires"));
  const chainId = Number(parsed.searchParams.get("chainId"));
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(chainId)) throw new Error("Invalid request metadata");
  return {
    recipient: normalizeRecipient(parts[1]),
    amount,
    memo: (parsed.searchParams.get("memo") || "").slice(0, 120),
    invoiceId: invoiceId.toLowerCase(),
    expiresAt,
    chainId,
    contract: normalizeRecipient(parsed.searchParams.get("contract") || ""),
  };
}
