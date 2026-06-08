import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { librarianDeclaration } from "../librarian.js";
import { resolveSystemPromptBody } from "../prompt-builder.js";

describe("librarian prompt contracts", () => {
  it("default prompt includes Confidence & Caveats section", () => {
    const prompt = resolveSystemPromptBody(librarianDeclaration, undefined);
    assert.ok(prompt.includes("## Confidence & Caveats"));
    assert.ok(prompt.includes("High") || prompt.includes("Medium") || prompt.includes("Low"));
  });

  it("GPT prompt includes confidence tag in output_spec", () => {
    const prompt = resolveSystemPromptBody(librarianDeclaration, "gpt-4");
    assert.ok(prompt.includes("Confidence"));
    assert.ok(prompt.includes("<output_spec>"));
  });
});
