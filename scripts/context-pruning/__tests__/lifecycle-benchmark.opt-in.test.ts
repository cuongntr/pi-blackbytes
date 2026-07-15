/** Excluded from normal discovery. T-021 owns real benchmark execution. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { requireT021RealBenchmarkExecutor } from "../lifecycle/benchmark.js";

describe("opt-in lifecycle performance handoff", () => {
  it("cannot claim real evidence before T-021 supplies frozen fixtures and processes", () => {
    assert.notEqual(process.env.EVIDENCE_HERMETIC_TESTS, "1");
    assert.throws(() => requireT021RealBenchmarkExecutor(), { code: "E_EVAL_INCOMPLETE" });
  });
});
