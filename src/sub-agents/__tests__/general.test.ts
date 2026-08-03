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

    it(`owns the self-review and verification loop for ${model ?? "default"}`, () => {
      const prompt = resolveSystemPromptBody(generalDeclaration, model);
      assert.ok(prompt.includes("git status --short"));
      assert.ok(prompt.includes("unstaged") && prompt.includes("staged diff"));
      assert.ok(prompt.includes("untracked target files"));
      assert.ok(prompt.includes("Before any edit"));
      assert.ok(prompt.includes("immutable ownership boundary"));
      assert.ok(prompt.includes("target/in-scope files"));
      assert.ok(prompt.includes("delta created by this invocation"));
      assert.ok(
        prompt.includes("never modify or revert") || prompt.includes("Never modify or revert"),
      );
      assert.ok(
        prompt.includes("cannot establish") || prompt.includes("cannot establish the baseline"),
      );
      assert.ok(prompt.includes("report") && prompt.includes("caveat"));
      assert.ok(prompt.includes("implement → self-review → fix → verify"));
      assert.ok(prompt.includes("without delegation") || prompt.includes("do not delegate"));
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
