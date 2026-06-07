import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exploreDeclaration } from "../explore.js";
import { resolveSystemPromptBody } from "../prompt-builder.js";

describe("explore prompt contracts", () => {
  it("default prompt includes Confidence section", () => {
    const prompt = resolveSystemPromptBody(exploreDeclaration, undefined);
    assert.ok(prompt.includes("## Confidence"));
    assert.ok(prompt.includes("High") || prompt.includes("Medium") || prompt.includes("Low"));
  });

  it("GPT prompt includes confidence tag in output_spec", () => {
    const prompt = resolveSystemPromptBody(exploreDeclaration, "gpt-4");
    assert.ok(prompt.includes("Confidence"));
    assert.ok(prompt.includes("<output_spec>"));
  });
});
