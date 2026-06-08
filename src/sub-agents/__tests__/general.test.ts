import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generalDeclaration } from "../general.js";
import { resolveSystemPromptBody } from "../prompt-builder.js";

describe("general prompt contracts", () => {
  it("default prompt includes TASK COMPLETE reporting section", () => {
    const prompt = resolveSystemPromptBody(generalDeclaration, undefined);
    assert.ok(prompt.includes("=== TASK COMPLETE ==="));
    assert.ok(prompt.includes("Outcome"));
    assert.ok(prompt.includes("Changed Files"));
    assert.ok(prompt.includes("Verification"));
    assert.ok(prompt.includes("Failures"));
    assert.ok(prompt.includes("Follow-up"));
  });

  it("GPT prompt includes TASK COMPLETE reporting section", () => {
    const prompt = resolveSystemPromptBody(generalDeclaration, "gpt-4");
    assert.ok(prompt.includes("=== TASK COMPLETE ==="));
    assert.ok(prompt.includes("Outcome"));
    assert.ok(prompt.includes("Changed Files"));
    assert.ok(prompt.includes("Verification"));
    assert.ok(prompt.includes("Failures"));
    assert.ok(prompt.includes("Follow-up"));
  });
});
