import { describe, expect, it } from "vitest";
import { isArcBridgeRoute } from "./bridgeRoute";

describe("two-way Arc bridge routes", () => {
  it("allows routes into and out of Arc", () => {
    expect(isArcBridgeRoute(11155111, 5042002, 5042002)).toBe(true);
    expect(isArcBridgeRoute(5042002, 84532, 5042002)).toBe(true);
  });
  it("rejects same-chain and routes that bypass Arc", () => {
    expect(isArcBridgeRoute(5042002, 5042002, 5042002)).toBe(false);
    expect(isArcBridgeRoute(11155111, 84532, 5042002)).toBe(false);
  });
});
