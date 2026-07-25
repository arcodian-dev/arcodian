import { describe, expect, it } from "vitest";
import { CIRCLE_BRIDGE_EXECUTION } from "./circleBridgeConfig";

describe("Circle bridge execution", () => {
  it("uses sequential standard-finality burns that never revert on fee/amount edges", () => {
    expect(CIRCLE_BRIDGE_EXECUTION).toEqual({
      batchTransactions: false,
      transferSpeed: "SLOW",
      maxFee: "0",
    });
  });
});
