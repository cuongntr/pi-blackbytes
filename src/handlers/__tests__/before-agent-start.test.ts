import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import {
  ALL_TOOL_NAMES,
  BUNDLED_TOOLS,
  SUB_AGENTS,
  TOOL_GROUPS,
} from "../../config/resource-metadata.js";
import { parseBlackbytesConfig } from "../../config/schema.js";
import { injectPromptAugmentation } from "../before-agent-start.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  const result = parseBlackbytesConfig(overrides);
  if (!result.ok) throw new Error(result.errors.join(", "));
  return result.value;
}

beforeEach(() => {
  _resetEnabledSet();
});

describe("injectPromptAugmentation", () => {
  it("first turn: appends resources block to system prompt", () => {
    initEnabledSet(makeConfig());
    const original = "You are a helpful assistant.";
    const result = injectPromptAugmentation(original);

    assert.ok(result.startsWith(original), "original prompt preserved at start");
    assert.ok(result.includes("<!-- pi-blackbytes:resources:start -->"), "start sentinel present");
    assert.ok(result.includes("<!-- pi-blackbytes:resources:end -->"), "end sentinel present");
    assert.ok(result.includes("<available_resources>"), "XML tag present");
    assert.ok(result.includes("hashline_edit"), "bundled tool listed");
  });

  it("includes prompt guidance in augmentation block", () => {
    initEnabledSet(makeConfig());
    const result = injectPromptAugmentation("Base prompt.");
    assert.ok(result.includes("Hard Boundaries"), "prompt guidance content present");
    assert.ok(
      result.indexOf("Hard Boundaries") < result.indexOf("<available_resources>"),
      "prompt guidance appears before available_resources",
    );
  });

  it("second turn: replaces existing block in-place (no duplicates)", () => {
    initEnabledSet(makeConfig());
    const original = "You are a helpful assistant.";
    const first = injectPromptAugmentation(original);
    const second = injectPromptAugmentation(first);

    const startCount = (second.match(/<!-- pi-blackbytes:resources:start -->/g) ?? []).length;
    const endCount = (second.match(/<!-- pi-blackbytes:resources:end -->/g) ?? []).length;
    assert.equal(startCount, 1, "only one start sentinel");
    assert.equal(endCount, 1, "only one end sentinel");
    assert.ok(second.startsWith(original), "original text still at start");
  });

  it("disabled tool group is excluded when all its tools are disabled", () => {
    initEnabledSet(makeConfig({ disabled_tools: ["grep_app_search_github"] }));
    const result = injectPromptAugmentation("prompt");
    assert.ok(!result.includes("grep_app"), "disabled tool group not listed");
    assert.ok(result.includes("hashline_edit"), "bundled tools still present");
  });

  it("resource block lists exact enabled tools for partially enabled groups", () => {
    initEnabledSet(makeConfig({ disabled_tools: ["websearch_search", "context7_query_docs"] }));
    const result = injectPromptAugmentation("prompt");

    assert.ok(result.includes("websearch (web search and page fetching): websearch_fetch"));
    assert.ok(!result.includes("websearch (web search and page fetching): websearch_search"));
    assert.ok(
      result.includes(
        "context7 (library/framework documentation lookup): context7_resolve_library_id",
      ),
    );
    assert.ok(
      !result.includes("context7 (library/framework documentation lookup): context7_query_docs"),
    );
  });

  it("disabled sub-agent is excluded from resources block", () => {
    initEnabledSet(makeConfig({ disabled_sub_agents: ["oracle"] }));
    const result = injectPromptAugmentation("prompt");
    assert.ok(!result.includes("oracle"), "disabled agent not listed");
    assert.ok(result.includes("explore"), "other agents still present");
  });

  it("resource block lists bundled tools and tool group descriptions", () => {
    initEnabledSet(makeConfig());
    const result = injectPromptAugmentation("prompt");
    for (const tool of BUNDLED_TOOLS) {
      assert.ok(result.includes(tool.name), `bundled tool ${tool.name} should appear`);
    }
    for (const group of TOOL_GROUPS) {
      assert.ok(
        result.includes(group.description),
        `tool group ${group.name} description should appear`,
      );
    }
  });

  it("resource block lists all enabled sub-agents from shared metadata", () => {
    initEnabledSet(makeConfig());
    const result = injectPromptAugmentation("prompt");
    for (const agent of SUB_AGENTS) {
      assert.ok(result.includes(agent.name), `agent ${agent.name} should appear`);
      assert.ok(
        result.includes(agent.description),
        `agent ${agent.name} description should appear`,
      );
    }
  });
});

it("falls back to a minimal safe overlay when enabled-set is unavailable", () => {
  const result = injectPromptAugmentation("prompt");

  assert.ok(result.includes("<!-- pi-blackbytes:resources:start -->"));
  assert.ok(result.includes("Precedence"), "fallback overlay should still be injected");
  assert.ok(
    !result.includes("Hashline Edit Workflow"),
    "fallback should not imply hashline support",
  );
  assert.ok(
    !result.includes("Delegate when specialization materially reduces"),
    "fallback should not imply delegation support",
  );
});

it("renders capability-aware prompt sections from enabled resources", () => {
  initEnabledSet(
    makeConfig({
      disabled_tools: [
        "hashline_edit",
        "websearch_search",
        "websearch_fetch",
        "context7_resolve_library_id",
        "context7_query_docs",
        "grep_app_search_github",
      ],
      disabled_sub_agents: ["explore", "oracle", "librarian", "general"],
    }),
  );

  const result = injectPromptAugmentation("prompt");

  assert.ok(!result.includes("Hashline Edit Workflow"));
  assert.ok(!result.includes("Delegate when specialization materially reduces"));
  assert.ok(!result.includes("Documentation lookup may be available"));
  assert.ok(!result.includes("Web lookup capabilities may be available"));
  assert.ok(!result.includes("GitHub code search may be available"));
});

it("does not advertise docs lookup when only context7 resolve is enabled", () => {
  initEnabledSet(makeConfig({ disabled_tools: ["context7_query_docs"] }));
  const result = injectPromptAugmentation("prompt");

  assert.ok(!result.includes("Documentation lookup may be available"));
  assert.ok(
    result.includes(
      "context7 (library/framework documentation lookup): context7_resolve_library_id",
    ),
  );
});

it("does not advertise web lookup when websearch is fully disabled", () => {
  initEnabledSet(makeConfig({ disabled_tools: ["websearch_search", "websearch_fetch"] }));
  const result = injectPromptAugmentation("prompt");

  assert.ok(!result.includes("Web lookup capabilities may be available"));
});
