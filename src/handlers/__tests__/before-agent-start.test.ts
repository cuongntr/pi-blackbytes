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
    assert.ok(result.includes("Guardrails"), "prompt guidance content present");
    assert.ok(
      result.indexOf("Guardrails") < result.indexOf("<available_resources>"),
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
