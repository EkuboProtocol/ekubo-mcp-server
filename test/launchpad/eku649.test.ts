import { describe, expect, it } from "bun:test";
import { evaluate } from "./eku649/evaluate.js";

/**
 * Pins the current reproduction of the EKU-649 benchmark bundle. A change in
 * any status is a change in what the engine can claim, so it must be
 * deliberate. Print the full report with `bun test/launchpad/eku649/report.ts`.
 */
describe("EKU-649 benchmark bundle through the fixture adapter", () => {
  it("reproduces C1, C6 and parts of C4 and E12; not C5 or E11", async () => {
    const { results, adapter } = await evaluate();
    expect(Object.fromEntries(results.map((r) => [r.id, r.status]))).toEqual({
      C1: "reproduced",
      C4: "partially_reproduced",
      C5: "not_reproduced",
      C6: "reproduced",
      E11: "not_reproduced",
      E12: "partially_reproduced",
    });
    expect(adapter.substitutions).toHaveLength(21);
    expect(adapter.transfers_before_mint).toHaveLength(6);
    expect(adapter.unmapped_fields.length).toBeGreaterThan(0);
  });
});
