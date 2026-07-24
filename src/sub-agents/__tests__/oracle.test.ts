import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { oracleDeclaration } from "../oracle.js";
import { resolveSystemPromptBody } from "../prompt-builder.js";

describe("oracle prompt contracts", () => {
  it("default prompt includes Confidence & Caveats section", () => {
    const prompt = resolveSystemPromptBody(oracleDeclaration, undefined);
    assert.ok(prompt.includes("## Confidence & Caveats"));
    assert.ok(prompt.includes("High") || prompt.includes("Medium") || prompt.includes("Low"));
  });

  it("GPT prompt includes confidence tag in output_spec", () => {
    const prompt = resolveSystemPromptBody(oracleDeclaration, "gpt-4");
    assert.ok(prompt.includes("Confidence"));
    assert.ok(prompt.includes("<output_spec>"));
  });

  for (const model of [undefined, "gpt-4"] as const) {
    it(`uses assumption-first one-shot ambiguity handling for ${model ?? "default"}`, () => {
      const prompt = resolveSystemPromptBody(oracleDeclaration, model);
      assert.ok(prompt.includes("one-shot consultation"));
      assert.ok(prompt.includes("do not stop to ask clarifying questions"));
      assert.ok(prompt.includes("state the assumption"));
      assert.ok(prompt.includes("without waiting for a reply"));
    });
  }
});
