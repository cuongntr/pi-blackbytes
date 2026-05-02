import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import {
  SUB_AGENTS,
  _resetSubAgentRegistry,
  registerSubAgentMeta,
} from "../../config/resource-metadata.js";
import { parseBlackbytesConfig } from "../../config/schema.js";
import { injectPromptAugmentation } from "../before-agent-start.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  const result = parseBlackbytesConfig(overrides);
  if (!result.ok) throw new Error(result.errors.join(", "));
  return result.value;
}

const originalNestedDepth = process.env.PI_NESTED_DEPTH;

beforeEach(() => {
  _resetEnabledSet();
  _resetSubAgentRegistry();
  delete process.env.PI_NESTED_DEPTH;
});

afterEach(() => {
  if (originalNestedDepth === undefined) {
    delete process.env.PI_NESTED_DEPTH;
  } else {
    process.env.PI_NESTED_DEPTH = originalNestedDepth;
  }
});

function seedBuiltinAgents() {
  for (const agent of SUB_AGENTS) registerSubAgentMeta(agent);
}

describe("injectPromptAugmentation", () => {
  it("first turn: appends resources block to system prompt", () => {
    seedBuiltinAgents();
    initEnabledSet(makeConfig());
    const original = "You are a helpful assistant.";
    const result = injectPromptAugmentation(original);

    assert.ok(result.startsWith(original), "original prompt preserved at start");
    assert.ok(result.includes("<!-- pi-blackbytes:resources:start -->"), "start sentinel present");
    assert.ok(result.includes("<!-- pi-blackbytes:resources:end -->"), "end sentinel present");
    assert.ok(result.includes("<available_resources>"), "XML tag present (claude default)");
    assert.ok(result.includes("explore"), "sub-agent listed");
  });

  it("resources block only lists sub-agents, not individual tools", () => {
    seedBuiltinAgents();
    initEnabledSet(makeConfig());
    const result = injectPromptAugmentation("Base prompt.");
    // Tool groups should NOT appear in resources block (Pi base prompt already lists them)
    assert.ok(!result.includes("Bundled tools:"), "no bundled tools section");
    assert.ok(!result.includes("External tools:"), "no external tools section");
    // But agents should be listed
    assert.ok(result.includes("Available agents:"), "agents section present");
    assert.ok(result.includes("explore"), "agent name present");
  });

  it("includes prompt guidance in augmentation block", () => {
    seedBuiltinAgents();
    initEnabledSet(makeConfig());
    const result = injectPromptAugmentation("Base prompt.");
    assert.ok(result.includes("Hard Boundaries"), "prompt guidance content present");
    assert.ok(
      result.indexOf("Hard Boundaries") < result.indexOf("<available_resources>"),
      "prompt guidance appears before available_resources",
    );
  });

  it("second turn: replaces existing block in-place (no duplicates)", () => {
    seedBuiltinAgents();
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

  it("disabled sub-agent does not affect resource block tool listing", () => {
    seedBuiltinAgents();
    initEnabledSet(makeConfig({ disabled_tools: ["gh_search"] }));
    const result = injectPromptAugmentation("prompt");
    // Tool disabling should not affect the agents-only resources block
    assert.ok(result.includes("explore"), "agents still present");
    assert.ok(!result.includes("grep_app"), "tool groups not listed regardless");
  });

  it("disabled sub-agent is excluded from resources block", () => {
    seedBuiltinAgents();
    initEnabledSet(makeConfig({ disabled_sub_agents: ["oracle"] }));
    const result = injectPromptAugmentation("prompt");
    assert.ok(!result.includes("oracle"), "disabled agent not listed");
    assert.ok(result.includes("explore"), "other agents still present");
  });

  it("uses XML wrapper for available_resources with claude family", () => {
    seedBuiltinAgents();
    initEnabledSet(makeConfig());
    const result = injectPromptAugmentation("prompt");
    assert.ok(result.includes("<available_resources>"), "XML open tag for claude");
    assert.ok(result.includes("</available_resources>"), "XML close tag for claude");
  });

  it("omits XML wrapper for available_resources with gpt family", () => {
    seedBuiltinAgents();
    initEnabledSet(makeConfig());
    const result = injectPromptAugmentation("prompt", "gpt-4o");
    assert.ok(!result.includes("<available_resources>"), "no XML tag for gpt");
    assert.ok(result.includes("Available agents:"), "agents still listed for gpt");
  });

  it("resource block lists all enabled sub-agents from shared metadata", () => {
    seedBuiltinAgents();
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
        "web_search",
        "web_fetch",
        "docs_resolve",
        "docs_query",
        "gh_search",
      ],
      disabled_sub_agents: ["explore", "oracle", "librarian", "general", "reviewer", "code-tour"],
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
  seedBuiltinAgents();
  initEnabledSet(makeConfig({ disabled_tools: ["docs_query"] }));
  const result = injectPromptAugmentation("prompt");

  assert.ok(!result.includes("Documentation lookup may be available"));
});

it("does not advertise web lookup when websearch is fully disabled", () => {
  seedBuiltinAgents();
  initEnabledSet(makeConfig({ disabled_tools: ["web_search", "web_fetch"] }));
  const result = injectPromptAugmentation("prompt");

  assert.ok(!result.includes("Web lookup capabilities may be available"));
});

it("advertises dynamically registered YAML agents in the resource block", () => {
  seedBuiltinAgents();
  registerSubAgentMeta({ name: "yaml-researcher", description: "YAML-defined research agent" });
  initEnabledSet(makeConfig(), [
    "explore",
    "oracle",
    "librarian",
    "general",
    "reviewer",
    "code-tour",
    "yaml-researcher",
  ]);
  const result = injectPromptAugmentation("prompt");

  assert.ok(result.includes("yaml-researcher"), "dynamically registered agent should appear");
  assert.ok(
    result.includes("YAML-defined research agent"),
    "dynamic agent description should appear",
  );
});

it("excludes disabled dynamically registered agents from resource block", () => {
  seedBuiltinAgents();
  registerSubAgentMeta({ name: "yaml-bot", description: "A YAML bot" });
  initEnabledSet(makeConfig({ disabled_sub_agents: ["yaml-bot"] }), [
    "explore",
    "oracle",
    "librarian",
    "general",
    "yaml-bot",
  ]);
  const result = injectPromptAugmentation("prompt");

  assert.ok(!result.includes("yaml-bot"), "disabled dynamic agent should not appear");
  assert.ok(result.includes("explore"), "other agents still present");
});
