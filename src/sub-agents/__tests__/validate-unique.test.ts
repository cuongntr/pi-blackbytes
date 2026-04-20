import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertUniqueNames } from "../validate-unique.js";

describe("assertUniqueNames", () => {
  it("passes with unique names", () => {
    assert.doesNotThrow(() => assertUniqueNames(["explore", "oracle", "general"]));
  });

  it("passes with empty list", () => {
    assert.doesNotThrow(() => assertUniqueNames([]));
  });

  it("throws on duplicate names", () => {
    assert.throws(
      () => assertUniqueNames(["explore", "oracle", "explore"]),
      /Duplicate sub-agent names detected: explore/,
    );
  });

  it("reports all duplicates", () => {
    assert.throws(
      () => assertUniqueNames(["a", "b", "a", "b", "c"]),
      /Duplicate sub-agent names detected: a, b/,
    );
  });
});
