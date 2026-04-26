import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewerDeclaration } from "../reviewer.js";

describe("reviewerDeclaration", () => {
  it("is a read-only sub-agent with the expected identity", () => {
    assert.equal(reviewerDeclaration.name, "reviewer");
    assert.equal(reviewerDeclaration.toolName, "delegate_reviewer");
    assert.equal(reviewerDeclaration.mutability, "read-only");
    assert.equal(reviewerDeclaration.finalizeMode, "strict");
    assert.equal(reviewerDeclaration.source, "builtin");
  });

  it("only allowlists read-only tools (no bash/write/edit/replace)", () => {
    const tools =
      typeof reviewerDeclaration.allowedTools === "function"
        ? reviewerDeclaration.allowedTools()
        : reviewerDeclaration.allowedTools;
    const set = new Set(tools);
    for (const allowed of ["read", "grep", "glob", "ast_search"]) {
      assert.ok(set.has(allowed), `reviewer should allow ${allowed}`);
    }
    for (const forbidden of [
      "write",
      "edit",
      "bash",
      "hashline_edit",
      "ast_replace",
      "delegate_general",
      "delegate_reviewer",
    ]) {
      assert.ok(!set.has(forbidden), `reviewer must NOT allow ${forbidden}`);
    }
  });

  it("system prompt enforces read-only stance and structured output", () => {
    const sp = reviewerDeclaration.systemPrompt;
    assert.match(sp, /Read-only/i);
    assert.match(sp, /## Verdict/);
    assert.match(sp, /### High/);
    assert.match(sp, /### Medium/);
    assert.match(sp, /### Low/);
    // Caller must provide diff/context because reviewer has no bash/git.
    assert.match(sp, /caller must include the diff/i);
  });

  it("buildUserPrompt appends context when provided", () => {
    const a = reviewerDeclaration.buildUserPrompt({ request: "review the auth refactor" });
    assert.equal(a, "review the auth refactor");
    const b = reviewerDeclaration.buildUserPrompt({
      request: "review",
      context: "diff --git a/x b/x\n+changed",
    });
    assert.match(b, /Review context:/);
    assert.match(b, /diff --git/);
  });

  it("prependSystemPrompt produces a runtime overlay with date and tools", async () => {
    assert.ok(reviewerDeclaration.prependSystemPrompt, "should expose prependSystemPrompt");
    const overlay = await reviewerDeclaration.prependSystemPrompt!({
      cwd: "/repo/x",
      finalizedTools: ["read", "grep"],
    });
    assert.match(overlay, /Runtime Overlay.*reviewer/);
    assert.match(overlay, /Today is/);
    assert.match(overlay, /\/repo\/x/);
  });
});
