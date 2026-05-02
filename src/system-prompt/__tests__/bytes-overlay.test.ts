import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  SUB_AGENTS,
  _resetSubAgentRegistry,
  registerSubAgentMeta,
} from "../../config/resource-metadata.js";
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

beforeEach(() => {
  _resetSubAgentRegistry();
  for (const agent of SUB_AGENTS) registerSubAgentMeta(agent);
});

describe("bytes overlay rendering", () => {
  it("renders full-capability sessions across model families", () => {
    for (const family of ["claude", "gpt", "gemini"] as const) {
      const prompt = renderPrompt(
        family,
        ["hashline_edit", "web_search", "web_fetch", "docs_resolve", "docs_query", "gh_search"],
        ["explore", "oracle", "librarian", "general", "reviewer", "code-tour"],
      );

      assert.ok(prompt.includes("Precedence"));
      assert.ok(prompt.includes("Session Capabilities"));
      assert.ok(prompt.includes("Hashline Edit Workflow"));
      assert.ok(prompt.includes("Delegate when specialization materially reduces"));
      assert.ok(prompt.includes("Documentation lookup may be available"));
      assert.ok(prompt.includes("Web lookup capabilities may be available"));
      assert.ok(prompt.includes("GitHub code search may be available"));
      assert.ok(prompt.includes("Use `delegate_explore` for broad or unfamiliar"));
      assert.ok(prompt.includes("Use `delegate_oracle` for hard architecture/debugging"));
      assert.ok(prompt.includes("Use `delegate_general` only for well-scoped"));
      assert.ok(prompt.includes("Use `delegate_reviewer` after significant implementation"));
    }
  });

  it("renders librarian-specific trigger guidance only when librarian is enabled", () => {
    const withLibrarian = renderPrompt("claude", [], ["librarian"]);
    assert.ok(
      withLibrarian.includes("Consider `librarian` only for non-trivial external research"),
    );
    assert.ok(withLibrarian.includes("Librarian gating (strict)"));
    assert.ok(withLibrarian.includes("DO NOT delegate to `librarian`"));
    assert.ok(withLibrarian.includes("NOT sufficient by themselves"));

    const withoutLibrarian = renderPrompt(
      "claude",
      ["web_search", "web_fetch", "docs_resolve", "docs_query", "gh_search"],
      ["explore"],
    );
    assert.ok(!withoutLibrarian.includes("Consider `librarian` only for non-trivial"));
    assert.ok(!withoutLibrarian.includes("Librarian gating (strict)"));
    assert.ok(!withoutLibrarian.includes("DO NOT delegate to `librarian`"));
  });

  it("renders sub-agent trigger guidance only for enabled sub-agents", () => {
    const withReviewer = renderPrompt("claude", [], ["reviewer"]);
    assert.ok(withReviewer.includes("Use `delegate_reviewer` after significant implementation"));
    assert.ok(!withReviewer.includes("Use `delegate_oracle` for hard architecture/debugging"));

    const withOracle = renderPrompt("claude", [], ["oracle"]);
    assert.ok(withOracle.includes("Use `delegate_oracle` for hard architecture/debugging"));
    assert.ok(!withOracle.includes("Use `delegate_reviewer` after significant implementation"));

    const withExplore = renderPrompt("claude", [], ["explore"]);
    assert.ok(withExplore.includes("Use `delegate_explore` for broad or unfamiliar"));
    assert.ok(!withExplore.includes("Use `delegate_general` only for well-scoped"));

    const withGeneral = renderPrompt("claude", [], ["general"]);
    assert.ok(withGeneral.includes("Use `delegate_general` only for well-scoped"));
    assert.ok(!withGeneral.includes("Use `delegate_explore` for broad or unfamiliar"));
  });

  it("omits delegation guidance when sub-agents are unavailable", () => {
    const prompt = renderPrompt(
      "claude",
      ["hashline_edit", "web_search", "web_fetch", "docs_resolve", "docs_query", "gh_search"],
      [],
    );

    assert.ok(!prompt.includes("Delegate when specialization materially reduces"));
    assert.ok(!prompt.includes("Use `delegate_explore` for broad or unfamiliar"));
    assert.ok(!prompt.includes("Use `delegate_oracle` for hard architecture/debugging"));
    assert.ok(!prompt.includes("Use `delegate_general` only for well-scoped"));
    assert.ok(!prompt.includes("Use `delegate_reviewer` after significant implementation"));
    assert.ok(prompt.includes("Hashline Edit Workflow"));
  });

  it("omits hashline workflow when hashline_edit is unavailable", () => {
    const prompt = renderPrompt(
      "claude",
      ["web_search", "web_fetch", "docs_resolve", "docs_query", "gh_search"],
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
