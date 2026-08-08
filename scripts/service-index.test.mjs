import { describe, it, expect } from "vitest";
import { joinReputation } from "./service-index.mjs";

describe("joinReputation", () => {
  it("attaches reputation by agentId and sorts desc", () => {
    const out = joinReputation(
      [{ serviceId: "0x1", agentId: "42", volume: "0" }, { serviceId: "0x2", agentId: "7", volume: "0" }],
      { "42": 25, "7": 75 });
    expect(out[0].serviceId).toBe("0x2");
    expect(out[0].reputation).toBe(75);
    expect(out[1].reputation).toBe(25);
  });
  it("defaults missing reputation to 0", () => {
    expect(joinReputation([{ serviceId: "0x1", agentId: "99", volume: "0" }], {})[0].reputation).toBe(0);
  });
});
