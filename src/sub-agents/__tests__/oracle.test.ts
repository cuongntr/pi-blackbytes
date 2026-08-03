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

    it(`includes the conditional difficult-review contract for ${model ?? "default"}`, () => {
      const prompt = resolveSystemPromptBody(oracleDeclaration, model);
      for (const marker of [
        "bounded",
        "surrounding code",
        "call sites",
        "High",
        "Medium",
        "Low",
        "path:line",
        "smallest",
        "style nits",
        "verification results",
        "## Verdict",
        "Block | Approve with comments | Approve",
      ]) {
        assert.ok(prompt.includes(marker), `missing review marker: ${marker}`);
      }
      assert.ok(prompt.includes("cannot run git or tests"));
      assert.ok(prompt.includes("non-review"));
      for (const marker of [
        "mutually exclusive",
        "overrides",
        "## Findings",
        "### High",
        "No blocking findings.",
        "## Notes",
        "## Verdict",
        "MUST be the final section",
        "project guidance first",
        "verification adequacy",
        "missing tests for risky behavior",
        "abstraction fit",
        "concrete practical impact",
        ">100 files",
        ">10,000 changed lines",
        "missing or vague",
        "Do not invent",
        "runtime bug",
        "data loss",
        "incorrect permissions",
        "integration mismatch",
        "necessary error handling",
        "near-term",
        "Never emit `## Findings`",
      ]) {
        assert.ok(prompt.includes(marker), `missing detailed review marker: ${marker}`);
      }
      assert.ok(prompt.includes("no Effort") || prompt.includes("including Effort"));
      assert.ok(prompt.includes("Confidence"));
    });
  }

  it("keeps Oracle read-only without mutating or execution tools", () => {
    assert.equal(oracleDeclaration.mutability, "read-only");
    assert.ok(Array.isArray(oracleDeclaration.allowedTools));
    const tools = oracleDeclaration.allowedTools as readonly string[];
    for (const forbidden of ["bash", "write", "edit", "hashline_edit", "ast_replace"]) {
      assert.ok(!tools.includes(forbidden), `unexpected Oracle tool: ${forbidden}`);
    }
  });
});
