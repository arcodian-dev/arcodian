import { describe, expect, it } from "vitest";
import type { Contract } from "ethers";
import { sendWithMargin } from "./txGas";

function fakeContract(estimate: bigint) {
  const calls: unknown[][] = [];
  const fn = Object.assign(async (...args: unknown[]) => { calls.push(args); return { hash: "0xabc" }; }, {
    estimateGas: async (...args: unknown[]) => { calls.push(["estimate", ...args]); return estimate; },
  });
  return { contract: { getFunction: () => fn } as unknown as Contract, calls };
}

describe("sendWithMargin", () => {
  it("sends with 30% over the estimate and keeps the value", async () => {
    const { contract, calls } = fakeContract(200_000n);
    await sendWithMargin(contract, "buy", [1, 2], { value: 5n });
    expect(calls[0]).toEqual(["estimate", 1, 2, { value: 5n }]);
    expect(calls[1]).toEqual([1, 2, { value: 5n, gasLimit: 260_000n }]);
  });

  it("works with no arguments or overrides", async () => {
    const { contract, calls } = fakeContract(100n);
    await sendWithMargin(contract, "syncOracle");
    expect(calls[1]).toEqual([{ gasLimit: 130n }]);
  });
});
