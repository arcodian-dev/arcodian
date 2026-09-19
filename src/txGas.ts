import type { Contract } from "ethers";

/** Gas margin over the node's estimate for every write the site sends. */
export const GAS_MARGIN_PCT = 30n;

/**
 * Calls `method` with a gas limit 30% above the estimate instead of the bare
 * estimate ethers would use. Contracts that end inside a reentrancy lock need
 * gas left over for the lock's final storage write, and a bare estimate can
 * land just under that line: on a mainnet fork a stock buy ran out of gas at
 * exactly the estimated limit (ReentrancySentryOOG). Unused gas is not
 * charged, so the margin costs the user nothing.
 */
export async function sendWithMargin(contract: Contract, method: string, args: unknown[] = [], overrides: { value?: bigint } = {}) {
  const fn = contract.getFunction(method);
  const estimate = await fn.estimateGas(...args, overrides);
  return fn(...args, { ...overrides, gasLimit: estimate + estimate * GAS_MARGIN_PCT / 100n });
}
