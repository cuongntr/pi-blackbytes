/**
 * Opt-in exclusion sentinel.
 *
 * Normal discovery sets `EVIDENCE_HERMETIC_TESTS=1` and must exclude this file.
 * Direct opt-in execution leaves that variable unset, so the sentinel itself remains runnable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("opt-in exclusion", () => {
  it("should not run inside the normal hermetic suite", () => {
    assert.notEqual(
      process.env.EVIDENCE_HERMETIC_TESTS,
      "1",
      "opt-in test was discovered by the normal hermetic runner",
    );
  });
});
