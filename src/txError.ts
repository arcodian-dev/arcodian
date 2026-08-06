/// Turns a thrown ethers/wallet error into one plain sentence, instead of the
/// raw `execution reverted (unknown custom error) (action="estimateGas",
/// data="0x...", ...)` blob every page used to hand the user verbatim.
///
/// Contracts across this app mix two revert styles: newer ones (ArcLend*,
/// AgentPay/Passport/Jobs, SessionKeyAccount, AdminTimelock) use 4-byte
/// custom-error selectors; older ones (the pump/pair/router/fx-pool stack)
/// use classic `require(cond, "STRING")` reasons. Both need decoding, plus
/// the handful of ethers/wallet-level codes (user rejection, no funds, no
/// network) that aren't reverts at all.

const CUSTOM_ERRORS: Record<string, string> = {
  "0xf21de7ff": "Only the agent wallet bound to this policy can do that.",
  "0xa85e6f1a": "This invoice was already refunded once — refunds can't be repeated.",
  "0x02041a1b": "A cap increase is already scheduled; cancel it before scheduling another.",
  "0x0137f4a0": "That delay is outside the allowed range.",
  "0x8523b62a": "This job isn't in the right state for that action.",
  "0x3204506f": "The underlying call failed.",
  "0xbbdf0a77": "The scheduled call reverted when executed.",
  "0xe9fef498": "This market's supply/borrow cap is currently full. Try a smaller amount, or wait for governance to raise the cap.",
  "0x889a6dc3": "The price feed's confidence interval is too wide to trust right now — try again shortly.",
  "0x203d82d8": "This has expired. Refresh and try again.",
  "0x625a40e6": "The call failed.",
  "0xbc6900bb": "This would put the position's health factor below the safe threshold. Reduce the amount or add more collateral.",
  "0xb2f0dc1f": "The provider agent ID doesn't match the current Passport wallet.",
  "0x6dac6a09": "One of the values you entered isn't valid for this action.",
  "0x2c5211c6": "That amount isn't valid.",
  "0xd36c8500": "That expiry isn't valid.",
  "0x00bfc921": "The oracle returned an invalid price.",
  "0x322be652": "This invoice was already paid — it can't be paid twice.",
  "0x4f057506": "That exceeds the allowed limit.",
  "0xf6a2c5e5": "There isn't enough liquidity in this market to complete that right now.",
  "0xec8b73d8": "This merchant isn't approved on your policy yet.",
  "0x35047374": "Only the merchant on this invoice can do that.",
  "0x7bfa4b9f": "Only the admin can do that.",
  "0x390772fc": "Only the agent's owner can do that.",
  "0xea8e4eb5": "Your wallet isn't authorized for that action.",
  "0x179435b3": "That agent ID isn't bound to a wallet yet.",
  "0x20dbc874": "Only the client on this job can do that.",
  "0xc91959ac": "Only the assigned evaluator can do that.",
  "0xc32d1d76": "Only the timelock's executor can do that.",
  "0x7d1b73b9": "Only the timelock's proposer can do that.",
  "0x3480e2b2": "Only the provider on this job can do that.",
  "0x9488aaa6": "This action is scheduled but its delay hasn't passed yet.",
  "0x49e67afd": "No cap increase is currently scheduled.",
  "0x29c3b7ee": "This can only be called by the contract itself (a self-governed change).",
  "0x59912c06": "This hasn't expired yet.",
  "0x3fb4e43f": "This isn't valid yet — its start time is in the future.",
  "0xf7cfa42c": "The oracle price moved more than the allowed deviation since the last sync — sync it again before retrying.",
  "0x04578698": "The price feed hasn't updated recently enough for this action to proceed safely. Try again shortly.",
  "0x596dcdb8": "Only the owner can do that.",
  "0xeced32bc": "This market is currently paused.",
  "0x3a748a99": "A prerequisite action hasn't completed yet.",
  "0xab143c06": "Please wait for your previous transaction to finish before starting another.",
  "0x1d3bf435": "That function isn't allowed under this scoped key's permissions.",
  "0x9aff6408": "That target isn't allowed under this scoped key's permissions.",
  "0x90b8ec18": "A token or native transfer failed.",
  "0x5353c48f": "Only the treasury can do that.",
  "0x82b42900": "Your wallet isn't authorized for that action.",
  "0x4239717c": "A vault already exists for this owner.",
  "0x510eea88": "That wallet is already bound to a different agent.",
  "0x9e7194c3": "The payer doesn't match what's expected here.",
  "0xd92e233d": "A required address is missing.",
  "0x46c2cca1": "A required target address is missing.",
  "0x2033e238": "A required wallet address is missing.",
  "0x74ca9bd8": "The evaluator can't be the client or the provider — an escrow needs a neutral third party to release or refund it.",
  "0x4867df74": "This wallet's owner is no longer the current holder of that agent identity in the registry, so this policy is inert until re-set by whoever holds it now.",
  "0x058d9a1b": "Only the address that was proposed as the new admin can accept that role.",
  "0x624d4236": "That price update is larger than this oracle's allowed single-update move. Wait and update again in smaller steps, or use a real price feed.",
};

const REASON_STRINGS: Record<string, string> = {
  SLIPPAGE: "The price moved more than your slippage tolerance allowed. Try increasing slippage or refreshing the quote.",
  EXPIRED: "This quote expired before it confirmed. Refresh and try again.",
  CURVE_CLOSED: "This coin has already graduated — trade it on the DEX pair instead of the bonding curve.",
  NOT_A_CURVE: "Only the coin's own bonding curve can do that.",
  PAIR_EXISTS: "A trading pair already exists for this pair of tokens.",
  PAIR_ALREADY_SEEDED: "This pair already has liquidity seeded.",
  NO_LIQUIDITY: "There isn't enough liquidity to complete that trade.",
  NO_FX_OUT: "The FX route couldn't produce a quote right now.",
  RESERVED_UNTIL_GRADUATION: "This pair is reserved for its bonding curve until that coin graduates.",
  MIN_LIQUIDITY: "That amount is below the minimum liquidity this pool requires.",
  BAD_SWAP: "That swap isn't valid — check the amount and deadline.",
  BAD_PATH: "That isn't a valid swap route.",
  BAD_FEE_TIER: "That isn't a supported fee tier.",
  ZERO_AMOUNT: "Enter an amount greater than zero.",
  ZERO_IN: "Enter an amount greater than zero.",
  ZERO_OUT: "That amount rounds down to zero after fees — try a larger amount.",
  ZERO_NET: "That amount rounds down to zero after fees — try a larger amount.",
  ZERO_LP: "That amount is too small to mint any liquidity shares.",
  ZERO_SEED: "That amount is too small to seed this pair.",
  ZERO_MEMBER: "A required address is missing.",
  ZERO_ADDRESS: "A required address is missing.",
  ZERO_TREASURY: "A required treasury address is missing.",
  ZERO_AUTHORITY: "A required authority address is missing.",
  ZERO_FACTORY: "A required factory address is missing.",
  ZERO_TO: "A required recipient address is missing.",
  IDENTICAL: "Choose two different tokens.",
  UNORDERED: "Something about this pair's token order is wrong — this is an internal error, please report it.",
  INSUFFICIENT: "That amount is more than what's available.",
  BAD_INIT: "This can't be initialized with those values.",
  BAD_METADATA: "The name, symbol, or image doesn't meet this launchpad's requirements.",
  BAD_CONFIG: "This can't be configured with those values.",
  NO_AUTHORITY: "No graduation authority is set yet.",
  NO_MEMBERS: "This registry has no members yet.",
  NO_MIN: "A minimum output must be set to protect against slippage.",
  NO_PAIR: "No trading pair exists for this token yet.",
  ALREADY_MEMBER: "That address is already registered.",
  ALREADY_SEEDED: "This pair already has liquidity.",
  ALREADY_SET: "That's already been set and can't be changed.",
  SEALED: "This registry is sealed — its membership can no longer change.",
  NOT_DEPLOYER: "Only the original deployer can do that.",
  NOT_AUTHORIZED: "Your wallet isn't authorized for that action.",
  OWNER_ONLY: "Only the owner can do that.",
  TREASURY_ONLY: "Only the treasury can do that.",
  REENTRANCY: "Please wait for your previous transaction to finish before starting another.",
  NO_FEES: "There are no fees to claim right now.",
  FEE_OUT: "Sending the fee failed.",
  NATIVE_OUT: "Sending the proceeds failed.",
  WITHDRAW_FAILED: "The withdrawal failed to send.",
  NOTHING_RECEIVED: "That route would return nothing — check the amount and route.",
};

function selectorFromError(error: unknown): string | null {
  const withData = error as { data?: unknown; info?: { error?: { data?: unknown } } };
  const raw = typeof withData?.data === "string" ? withData.data : typeof withData?.info?.error?.data === "string" ? withData.info.error.data : null;
  if (raw && /^0x[0-9a-fA-F]{8,}$/.test(raw)) return raw.slice(0, 10).toLowerCase();
  return null;
}

function reasonStringFromError(error: unknown): string | null {
  const withReason = error as { reason?: unknown; shortMessage?: unknown; message?: unknown };
  const candidates = [withReason?.reason, withReason?.shortMessage, withReason?.message].filter((value): value is string => typeof value === "string");
  for (const candidate of candidates) {
    const match = candidate.match(/\b([A-Z][A-Z0-9_]{2,40})\b/);
    if (match && REASON_STRINGS[match[1]]) return match[1];
  }
  return null;
}

/// One plain sentence explaining what happened, safe to show directly in the
/// UI. Never returns the raw ethers exception text.
export function describeTxError(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  const rawMessage = String((error as { message?: unknown })?.message || "").toLowerCase();
  if (code === "ACTION_REJECTED" || rawMessage.includes("user rejected") || rawMessage.includes("user denied")) {
    return "You canceled the request in your wallet.";
  }
  if (code === "INSUFFICIENT_FUNDS" || rawMessage.includes("insufficient funds")) {
    return "Your wallet doesn't have enough balance to cover this amount plus gas.";
  }
  if (rawMessage.includes("request limit")) {
    return "Arc RPC is busy right now. No funds were sent — wait a few seconds and try again.";
  }
  if (rawMessage.includes("invalid prefix") || rawMessage.includes("invalid bech32")) {
    return "Your wallet is using an invalid address format for this EVM transaction. Reopen Arc Mainnet in the wallet and retry; the recipient must start with 0x.";
  }
  if (rawMessage.includes("missing revert data") || rawMessage.includes("could not coalesce")) {
    return "Wallet preflight failed before signing. No funds were sent — reopen Arc Mainnet in OKX and retry.";
  }
  if (code === "NETWORK_ERROR" || code === "SERVER_ERROR" || code === "TIMEOUT") return "Couldn't reach the network. Check your connection and try again.";
  if (code === "UNSUPPORTED_OPERATION" && rawMessage.includes("network")) {
    return "Your wallet needs to be on Arc Testnet for this. Switch networks and try again.";
  }

  const selector = selectorFromError(error);
  if (selector && CUSTOM_ERRORS[selector]) return CUSTOM_ERRORS[selector];

  const reasonKey = reasonStringFromError(error);
  if (reasonKey) return REASON_STRINGS[reasonKey];

  if (code === "CALL_EXCEPTION") {
    return selector
      ? `Transaction reverted (code ${selector}). This usually means a limit or safety check blocked it — check the numbers above and try again.`
      : "Transaction reverted. This usually means a limit or safety check blocked it — check the numbers above and try again.";
  }

  if (error instanceof Error) {
    // Last resort: an ethers-shaped message is long and technical, so lead
    // with just its first clause rather than the full multi-line dump.
    const firstClause = error.message.split(/[\n(]/)[0]?.trim();
    return firstClause && firstClause.length > 0 && firstClause.length < 160 ? firstClause : "Something went wrong completing that transaction.";
  }
  return "Something went wrong completing that transaction.";
}
