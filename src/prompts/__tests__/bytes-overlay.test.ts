import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBytesPromptRenderContext } from "../bytes/shared.js";
import { renderBytesPrompt } from "../loader.js";

function renderPrompt(
  family: "claude" | "gpt" | "gemini",
  enabledTools: string[],
  enabledSubAgents: string[],
): string {
  return renderBytesPrompt(
    createBytesPromptRenderContext(family, new Set(enabledTools), new Set(enabledSubAgents)),
  );
}

describe("bytes overlay rendering", () => {
  it("renders full-capability sessions across model families", () => {
    for (const family of ["claude", "gpt", "gemini"] as const) {
      const prompt = renderPrompt(
        family,
        [
          "hashline_edit",
          "websearch_search",
          "websearch_fetch",
          "context7_resolve_library_id",
          "context7_query_docs",
          "grep_app_search_github",
        ],
        ["explore", "oracle", "librarian", "general"],
      );

      assert.ok(prompt.includes("Precedence"));
      assert.ok(prompt.includes("Session Capabilities"));
      assert.ok(prompt.includes("Hashline Edit Workflow"));
      assert.ok(prompt.includes("Delegate when specialization materially reduces"));
      assert.ok(prompt.includes("Documentation lookup may be available"));
      assert.ok(prompt.includes("Web lookup capabilities may be available"));
      assert.ok(prompt.includes("GitHub code search may be available"));
    }
  });

  it("omits delegation guidance when sub-agents are unavailable", () => {
    const prompt = renderPrompt(
      "claude",
      [
        "hashline_edit",
        "websearch_search",
        "websearch_fetch",
        "context7_resolve_library_id",
        "context7_query_docs",
        "grep_app_search_github",
      ],
      [],
    );

    assert.ok(!prompt.includes("Delegate when specialization materially reduces"));
    assert.ok(prompt.includes("Hashline Edit Workflow"));
  });

  it("omits hashline workflow when hashline_edit is unavailable", () => {
    const prompt = renderPrompt(
      "claude",
      [
        "websearch_search",
        "websearch_fetch",
        "context7_resolve_library_id",
        "context7_query_docs",
        "grep_app_search_github",
      ],
      ["explore"],
    );

    assert.ok(!prompt.includes("Hashline Edit Workflow"));
    assert.ok(prompt.includes("Delegate when specialization materially reduces"));
  });

  it("omits docs, web, and code-search guidance when backing capabilities are unavailable", () => {
    const prompt = renderPrompt("claude", ["hashline_edit"], ["explore"]);

    assert.ok(!prompt.includes("Documentation lookup may be available"));
    assert.ok(!prompt.includes("Web lookup capabilities may be available"));
    assert.ok(!prompt.includes("GitHub code search may be available"));
    assert.ok(prompt.includes("Hashline Edit Workflow"));
  });

  it("renders a minimal safe fallback overlay when no capabilities are enabled", () => {
    const prompt = renderPrompt("claude", [], []);

    assert.ok(prompt.includes("Precedence"));
    assert.ok(prompt.includes("Hard Boundaries"));
    assert.ok(prompt.includes("Completion Contract"));
    assert.ok(!prompt.includes("Hashline Edit Workflow"));
    assert.ok(!prompt.includes("Delegate when specialization materially reduces"));
    assert.ok(!prompt.includes("Documentation lookup may be available"));
    assert.ok(!prompt.includes("Web lookup capabilities may be available"));
    assert.ok(!prompt.includes("GitHub code search may be available"));
  });
});
