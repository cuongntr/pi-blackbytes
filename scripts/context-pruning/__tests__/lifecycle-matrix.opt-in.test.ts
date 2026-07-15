/**
 * T-021 owns real owner-pinned Pi execution. This file is deliberately excluded
 * from normal discovery; running it directly verifies that T-010B cannot make a
 * real matrix claim without T-021's isolated subprocess executor.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { requireT021RealMatrixExecutor } from "../lifecycle/runner.js";

describe("opt-in lifecycle matrix handoff", () => {
  it("is excluded from hermetic discovery and requires T-021 execution wiring", () => {
    assert.notEqual(process.env.EVIDENCE_HERMETIC_TESTS, "1");
    assert.throws(() => requireT021RealMatrixExecutor(), { code: "E_EVAL_INCOMPLETE" });
  });
});
