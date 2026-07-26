import { describe, it, expect } from "vitest";
import { TOOLS } from "./registry";

describe("registry", () => {
  it("exposes all 22 tools with unique names, descriptions, and zod schemas", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      "find_agents", "inspect_agent", "list_jobs", "inspect_job", "inspect_vault",
      "inspect_spending_policy", "get_receipt", "quote_payment", "build_create_job",
      "build_submit_job", "build_evaluate_job", "build_leave_feedback",
      "inspect_x402_challenge", "quote_nanopayment", "build_nanopayment_authorization",
      "verify_nanopayment_receipt",
      "build_send_delegation", "activate_send_delegation", "build_revoke_send_delegation",
      "revoke_send_delegation", "build_appkit_send",
      "verify_appkit_send_receipt",
    ]));
    expect(names).toHaveLength(22);
    for (const t of TOOLS) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.schema).toBeTypeOf("object");   // zod raw shape
      expect(t.handler).toBeTypeOf("function");
    }
  });
});
