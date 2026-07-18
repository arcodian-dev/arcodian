import { describe, expect, it } from "vitest";

// Mirrors the SDK result shape we surface to users. This regression check keeps
// Circle step errors from being collapsed into a generic route failure again.
function message(result: { steps?: Array<{ name?: string; state?: string; errorMessage?: string }> }) {
  const failed = result.steps?.find((step) => step.state === "error");
  return `${failed?.name ? `${failed.name}: ` : ""}${failed?.errorMessage || "Circle could not complete this route."}`;
}

describe("Circle bridge failure detail", () => {
  it("surfaces the failing bridge step", () => {
    expect(message({ steps: [{ name: "approve", state: "error", errorMessage: "User rejected" }] })).toBe("approve: User rejected");
  });
});
