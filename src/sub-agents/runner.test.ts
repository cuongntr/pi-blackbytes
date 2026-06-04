import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boundReturnContent } from "./runner.js";

describe("boundReturnContent", () => {
  it("returns text unchanged when within the cap", () => {
    const text = "a".repeat(100);
    assert.equal(boundReturnContent(text, 1_000), text);
  });

  it("returns text unchanged at exactly the cap", () => {
    const text = "a".repeat(1_000);
    assert.equal(boundReturnContent(text, 1_000), text);
  });

  it("clips the middle and preserves head and tail when over the cap", () => {
    const head = "HEAD".repeat(50);
    const tail = "=== TASK COMPLETE ===\nOutcome: done";
    const text = `${head}${"x".repeat(5_000)}${tail}`;
    const out = boundReturnContent(text, 500);

    assert.ok(out.length < text.length);
    assert.ok(out.startsWith("HEAD"));
    assert.ok(out.endsWith("Outcome: done"));
    assert.ok(out.includes("truncated"));
  });

  it("never grows the output, even when the cap is smaller than the marker", () => {
    const text = "x".repeat(100);
    const out = boundReturnContent(text, 10);
    assert.ok(out.length <= 10);
    assert.ok(text.includes(out));
  });
});
