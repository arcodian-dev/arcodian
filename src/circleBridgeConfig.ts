export const CIRCLE_BRIDGE_EXECUTION = {
  batchTransactions: false,
  // Standard finality (SLOW) — always valid regardless of amount, so the burn
  // never reverts on a fee/amount edge case. maxFee 0 is only allowed for
  // Standard transfers. The in-wallet bridge offers per-amount Fast Transfer
  // with a Standard fallback; this SDK path stays on the always-safe Standard.
  transferSpeed: "SLOW",
  maxFee: "0",
} as const;
