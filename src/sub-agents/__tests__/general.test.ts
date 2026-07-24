import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeEnabledSet } from "../../config/enabled-set.js";
import { buildGeneralSafetyOverlay } from "../general-safety-overlay.js";
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

  for (const model of [undefined, "gpt-4"] as const) {
    it(`prefers repository-defined verification for ${model ?? "default"}`, () => {
      const prompt = resolveSystemPromptBody(generalDeclaration, model);
      assert.ok(prompt.includes("repository-defined full verification command"));
      assert.ok(!prompt.includes("typecheck → lint → test → build"));
    });
  }

  it("safety overlay defers verification order to repository conventions", async () => {
    const overlay = await buildGeneralSafetyOverlay({
      enabledSet: computeEnabledSet({
        disabled_tools: [],
        disabled_sub_agents: [],
        hashline_edit: true,
      }),
      finalizedTools: ["read", "bash"],
      readRepoFile: async () => "Run `bun run check` for full verification.",
    });

    assert.ok(overlay.includes("repository-defined full verification command"));
    assert.ok(overlay.includes("bun run check"));
    assert.ok(!overlay.includes("typecheck → lint → test → build"));
  });
});
