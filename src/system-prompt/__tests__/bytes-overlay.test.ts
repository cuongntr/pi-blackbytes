import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { _resetSubAgentRegistry, registerSubAgentMeta } from "../../config/resource-metadata.js";
import { declarationToMeta } from "../../sub-agents/declaration.js";
import { exploreDeclaration } from "../../sub-agents/explore.js";
import { generalDeclaration } from "../../sub-agents/general.js";
import { librarianDeclaration } from "../../sub-agents/librarian.js";
import { oracleDeclaration } from "../../sub-agents/oracle.js";
import { createBytesPromptRenderContext } from "../bytes/shared.js";
import { renderBytesPrompt } from "../loader.js";

function renderPrompt(
  family: "claude" | "gpt" | "gemini" | "kimi",
  enabledTools: string[],
  enabledSubAgents: string[],
): string {
  return renderBytesPrompt(
    createBytesPromptRenderContext(family, new Set(enabledTools), new Set(enabledSubAgents)),
  );
}

beforeEach(() => {
  _resetSubAgentRegistry();
  for (const decl of [
    exploreDeclaration,
    oracleDeclaration,
    librarianDeclaration,
    generalDeclaration,
  ]) {
    registerSubAgentMeta(declarationToMeta(decl));
  }
});

describe("bytes overlay rendering", () => {
  it("renders full-capability sessions across model families", () => {
    for (const family of ["claude", "gpt", "gemini", "kimi"] as const) {
      const prompt = renderPrompt(
        family,
        ["hashline_edit", "web_search", "web_fetch", "docs_resolve", "docs_query", "gh_search"],
        ["explore", "oracle", "librarian", "general"],
      );

      assert.ok(prompt.includes("Precedence"));
      assert.ok(prompt.includes("Session Capabilities"));
      assert.ok(prompt.includes("Hashline Edit Workflow"));
      assert.ok(prompt.includes("Skills"));
      assert.ok(prompt.includes("Default to delegating"));
      assert.ok(prompt.includes("Documentation lookup may be available"));
      assert.ok(prompt.includes("Web lookup capabilities may be available"));
      assert.ok(prompt.includes("GitHub code search may be available"));
      assert.ok(prompt.includes("`explore`"));
      assert.ok(prompt.includes("`oracle`"));
      assert.ok(prompt.includes("`general`"));
      assert.ok(prompt.includes("difficult/high-risk code review"));
    }
  });

  it("renders the concise visibility contract across model families", () => {
    for (const family of ["claude", "gpt", "gemini", "kimi"] as const) {
      const prompt = renderPrompt(family, [], []);

      assert.ok(prompt.includes("implement rather than stopping at a description"));
      assert.ok(prompt.includes("Be direct and concise, not silent"));
      assert.ok(prompt.includes("intended outcome and immediate approach"));
      assert.ok(prompt.includes("meaningful phase changes"));
      assert.ok(prompt.includes("important discoveries"));
      assert.ok(prompt.includes("blockers"));
    }
  });

  it("requires Bytes to surface material delegated results", () => {
    const withDelegation = renderPrompt("claude", [], ["explore"]);
    assert.ok(withDelegation.includes("Never rely on collapsed sub-agent output"));

    const withoutDelegation = renderPrompt("claude", [], []);
    assert.ok(!withoutDelegation.includes("collapsed sub-agent output"));
  });

  it("uses a proportional completion contract without a hard line cap", () => {
    const prompt = renderPrompt("claude", [], []);

    assert.ok(prompt.includes("State the outcome first"));
    assert.ok(prompt.includes("proportional to the work"));
    assert.ok(prompt.includes("analysis or no-change tasks"));
    assert.ok(prompt.includes("never omit a material fact"));
    assert.ok(!prompt.includes("2–10 lines"));
  });

  it("renders skill-loading and atomic-unit delegation guidance", () => {
    const prompt = renderPrompt("claude", [], ["general"]);

    assert.ok(prompt.includes("read that skill file before planning or implementing"));
    assert.ok(prompt.includes("If a loaded skill defines atomic work units"));
    assert.ok(prompt.includes("one unit per call"));
    assert.ok(prompt.includes("do not merge units just because the combined batch is large"));
    // The anti-bundling guidance must be merged into the trigger, not a standalone bullet
    assert.ok(!prompt.includes("  - Do not bundle"));
  });

  it("renders librarian-specific trigger guidance only when librarian is enabled", () => {
    const withLibrarian = renderPrompt("claude", [], ["librarian"]);
    assert.ok(
      withLibrarian.includes("Consider `librarian` only for non-trivial external research"),
    );
    assert.ok(withLibrarian.includes("`librarian`"));
    assert.ok(withLibrarian.includes("Multi-source external research"));

    const withoutLibrarian = renderPrompt(
      "claude",
      ["web_search", "web_fetch", "docs_resolve", "docs_query", "gh_search"],
      ["explore"],
    );
    assert.ok(!withoutLibrarian.includes("Consider `librarian` only for non-trivial"));
  });

  it("renders sub-agent trigger guidance only for enabled sub-agents", () => {
    const withOracle = renderPrompt("claude", [], ["oracle"]);
    assert.ok(withOracle.includes("`oracle`"));
    assert.ok(withOracle.includes("Oracle review context"));
    assert.ok(withOracle.includes("default to one Oracle review pass"));
    assert.ok(withOracle.includes("architecture consultation"));
    assert.ok(withOracle.includes("does not automatically require post-implementation review"));
    assert.ok(withOracle.includes("does not consume the justified review pass"));
    assert.ok(withOracle.includes("Fix confirmed findings directly"));
    assert.ok(!withOracle.includes("General remediation"));
    assert.ok(withOracle.includes("do not automatically re-review"));
    assert.ok(withOracle.includes("deterministic verification"));

    const withExplore = renderPrompt("claude", [], ["explore"]);
    assert.ok(withExplore.includes("`explore`"));
    assert.ok(!withExplore.includes("`general`"));

    const withGeneral = renderPrompt("claude", [], ["general"]);
    assert.ok(withGeneral.includes("`general`"));
    assert.ok(!withGeneral.includes("`explore`"));
    assert.ok(!withGeneral.includes("Oracle review pass"));
    assert.ok(!withGeneral.includes("Avoid review ping-pong"));
    assert.ok(!withGeneral.includes("architecture consultation"));

    const withOracleAndGeneral = renderPrompt("claude", [], ["oracle", "general"]);
    assert.ok(withOracleAndGeneral.includes("one General remediation"));
    assert.ok(withOracleAndGeneral.includes("one Oracle review pass"));
  });

  it("omits delegation guidance when sub-agents are unavailable", () => {
    const prompt = renderPrompt(
      "claude",
      ["hashline_edit", "web_search", "web_fetch", "docs_resolve", "docs_query", "gh_search"],
      [],
    );

    assert.ok(!prompt.includes("Default to delegating"));
    assert.ok(!prompt.includes("`explore`"));
    assert.ok(!prompt.includes("`oracle`"));
    assert.ok(!prompt.includes("`general`"));
    assert.ok(!prompt.includes("Oracle review context"));
    assert.ok(prompt.includes("Hashline Edit Workflow"));
  });

  it("omits hashline workflow when hashline_edit is unavailable", () => {
    const prompt = renderPrompt(
      "claude",
      ["web_search", "web_fetch", "docs_resolve", "docs_query", "gh_search"],
      ["explore"],
    );

    assert.ok(!prompt.includes("Hashline Edit Workflow"));
    assert.ok(prompt.includes("Default to delegating"));
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
    assert.ok(prompt.includes("Completion"));
    assert.ok(!prompt.includes("Hashline Edit Workflow"));
    assert.ok(!prompt.includes("Default to delegating"));
    assert.ok(!prompt.includes("Documentation lookup may be available"));
    assert.ok(!prompt.includes("Web lookup capabilities may be available"));
    assert.ok(!prompt.includes("GitHub code search may be available"));
  });
});
