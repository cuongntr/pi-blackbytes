import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  _resetEnabledSet,
  computeEnabledSet,
  getEnabledSet,
  initEnabledSet,
} from "../enabled-set.js";
import {
  ALL_SUB_AGENT_NAMES,
  ALL_TOOL_NAMES,
  BUNDLED_TOOLS,
  SUB_AGENTS,
  TOOL_GROUPS,
  _resetSubAgentRegistry,
  derivePromptFeatureFlags,
  getRegisteredSubAgentNames,
  getRegisteredSubAgents,
  isBundledTool,
  registerSubAgentMeta,
} from "../resource-metadata.js";
import type { BlackbytesConfig } from "../schema.js";

const defaultConfig: BlackbytesConfig = {
  disabled_tools: [],
  disabled_sub_agents: [],
  hashline_edit: true,
  copilot_initiator_header: true,
};

describe("enabled-set", () => {
  beforeEach(() => {
    _resetEnabledSet();
    _resetSubAgentRegistry();
  });

  function seedBuiltinAgents() {
    for (const agent of SUB_AGENTS) registerSubAgentMeta(agent);
  }

  it("default config enables all tools, subAgents, and skills", () => {
    const set = computeEnabledSet(defaultConfig);
    assert.ok(set.tools.has("hashline_edit"));
    assert.ok(set.tools.has("gh_search"));
    assert.equal(set.tools.size, 10);
    assert.ok(set.subAgents.has("explore"));
    assert.ok(set.subAgents.has("oracle"));
    assert.equal(set.subAgents.size, 4);
    assert.ok(set.skills.has("implementing-beads"));
    assert.equal(set.skills.size, 9);
  });

  it("disabled_tools removes specific tools", () => {
    const config: BlackbytesConfig = {
      ...defaultConfig,
      disabled_tools: ["hashline_edit", "grep"],
    };
    const set = computeEnabledSet(config);
    assert.ok(!set.tools.has("hashline_edit"));
    assert.ok(!set.tools.has("grep"));
    assert.ok(set.tools.has("glob"));
    assert.equal(set.tools.size, 8);
  });

  it("disabled_sub_agents removes specific sub-agents", () => {
    const config: BlackbytesConfig = {
      ...defaultConfig,
      disabled_sub_agents: ["explore", "oracle"],
    };
    const set = computeEnabledSet(config);
    assert.ok(!set.subAgents.has("explore"));
    assert.ok(!set.subAgents.has("oracle"));
    assert.ok(set.subAgents.has("librarian"));
    assert.equal(set.subAgents.size, 2);
  });

  it("computeEnabledSet accepts dynamic agent names", () => {
    const customAgents = ["explore", "oracle", "yaml-researcher"];
    const config: BlackbytesConfig = {
      ...defaultConfig,
      disabled_sub_agents: ["oracle"],
    };
    const set = computeEnabledSet(config, customAgents);
    assert.ok(set.subAgents.has("explore"));
    assert.ok(!set.subAgents.has("oracle"));
    assert.ok(set.subAgents.has("yaml-researcher"));
    assert.equal(set.subAgents.size, 2);
    // tools are unaffected by agent names
    assert.equal(set.tools.size, ALL_TOOL_NAMES.length);
  });

  it("unknown disabled_sub_agents are harmless no-ops", () => {
    const config: BlackbytesConfig = {
      ...defaultConfig,
      disabled_sub_agents: ["nonexistent", "explore"],
    };
    const set = computeEnabledSet(config);
    assert.ok(!set.subAgents.has("explore"));
    assert.ok(!set.subAgents.has("nonexistent"));
    assert.equal(set.subAgents.size, ALL_SUB_AGENT_NAMES.length - 1);
  });

  it("getEnabledSet throws before init", () => {
    assert.throws(() => getEnabledSet(), /not initialized/);
  });

  it("initEnabledSet throws on double init", () => {
    initEnabledSet(defaultConfig);
    assert.throws(() => initEnabledSet(defaultConfig), /already initialized/);
  });

  it("computeEnabledSet is pure and does not affect singleton", () => {
    computeEnabledSet(defaultConfig);
    assert.throws(() => getEnabledSet(), /not initialized/);
  });

  describe("resource-metadata consistency", () => {
    it("ALL_TOOL_NAMES matches bundled + tool group tools", () => {
      const expected = [
        ...BUNDLED_TOOLS.map((t) => t.name),
        ...TOOL_GROUPS.flatMap((s) => s.tools),
      ];
      assert.deepEqual([...ALL_TOOL_NAMES], expected);
    });

    it("ALL_SUB_AGENT_NAMES matches SUB_AGENTS entries", () => {
      assert.deepEqual(
        [...ALL_SUB_AGENT_NAMES],
        SUB_AGENTS.map((a) => a.name),
      );
    });

    it("enabled-set default tool count matches ALL_TOOL_NAMES", () => {
      const set = computeEnabledSet(defaultConfig);
      assert.equal(set.tools.size, ALL_TOOL_NAMES.length);
      for (const name of ALL_TOOL_NAMES) {
        assert.ok(set.tools.has(name), `${name} should be in enabled tools`);
      }
    });

    it("enabled-set default sub-agent count matches ALL_SUB_AGENT_NAMES", () => {
      const set = computeEnabledSet(defaultConfig);
      assert.equal(set.subAgents.size, ALL_SUB_AGENT_NAMES.length);
      for (const name of ALL_SUB_AGENT_NAMES) {
        assert.ok(set.subAgents.has(name), `${name} should be in enabled sub-agents`);
      }
    });

    it("isBundledTool correctly identifies bundled vs tool group tools", () => {
      for (const tool of BUNDLED_TOOLS) {
        assert.ok(isBundledTool(tool.name), `${tool.name} should be bundled`);
      }
      for (const group of TOOL_GROUPS) {
        for (const toolName of group.tools) {
          assert.ok(!isBundledTool(toolName), `${toolName} should not be bundled`);
        }
      }
    });

    it("derivePromptFeatureFlags reflects enabled tools and sub-agents", () => {
      seedBuiltinAgents();
      const set = computeEnabledSet(defaultConfig);
      const flags = derivePromptFeatureFlags(set.tools, set.subAgents);

      assert.deepEqual(flags, {
        hashlineEdit: true,
        subagentDelegation: true,
        documentationLookup: true,
        githubCodeSearch: true,
        webSearch: true,
      });
    });

    it("derivePromptFeatureFlags drops features when backing resources are disabled", () => {
      seedBuiltinAgents();
      const set = computeEnabledSet({
        ...defaultConfig,
        disabled_tools: [
          "hashline_edit",
          "web_search",
          "web_fetch",
          "docs_resolve",
          "docs_query",
          "gh_search",
        ],
        disabled_sub_agents: ["explore", "oracle", "librarian", "general"],
      });
      const flags = derivePromptFeatureFlags(set.tools, set.subAgents);

      assert.deepEqual(flags, {
        hashlineEdit: false,
        subagentDelegation: false,
        documentationLookup: false,
        githubCodeSearch: false,
        webSearch: false,
      });
    });

    it("derivePromptFeatureFlags keeps exact capabilities for partially enabled tool groups", () => {
      seedBuiltinAgents();
      const set = computeEnabledSet({
        ...defaultConfig,
        disabled_tools: ["docs_query", "web_search"],
      });
      const flags = derivePromptFeatureFlags(set.tools, set.subAgents);

      assert.deepEqual(flags, {
        hashlineEdit: true,
        subagentDelegation: true,
        documentationLookup: false,
        githubCodeSearch: true,
        webSearch: true,
      });
    });
  });

  describe("dynamic sub-agent metadata registry", () => {
    it("registerSubAgentMeta adds agents to the registry", () => {
      registerSubAgentMeta({ name: "custom-agent", description: "A custom agent" });
      const agents = getRegisteredSubAgents();
      assert.equal(agents.length, 1);
      assert.equal(agents[0].name, "custom-agent");
    });

    it("getRegisteredSubAgentNames returns names of registered agents", () => {
      registerSubAgentMeta({ name: "alpha", description: "Alpha" });
      registerSubAgentMeta({ name: "beta", description: "Beta" });
      assert.deepEqual(getRegisteredSubAgentNames(), ["alpha", "beta"]);
    });

    it("rejects duplicate registration by name", () => {
      registerSubAgentMeta({ name: "dup", description: "First" });
      assert.throws(
        () => registerSubAgentMeta({ name: "dup", description: "Second" }),
        /already registered.*"dup"/,
      );
    });

    it("_resetSubAgentRegistry clears all registered agents", () => {
      registerSubAgentMeta({ name: "temp", description: "Temporary" });
      assert.equal(getRegisteredSubAgents().length, 1);
      _resetSubAgentRegistry();
      assert.equal(getRegisteredSubAgents().length, 0);
    });

    it("derivePromptFeatureFlags uses dynamically registered agents for subagentDelegation", () => {
      // No agents registered yet — subagentDelegation should be false
      const set = computeEnabledSet(defaultConfig);
      const flagsNone = derivePromptFeatureFlags(set.tools, set.subAgents);
      assert.equal(flagsNone.subagentDelegation, false);

      // Register a custom agent and include it in enabled set
      registerSubAgentMeta({
        name: "yaml-bot",
        description: "YAML bot",
        promptFeatures: ["subagentDelegation"],
      });
      const setWithCustom = computeEnabledSet(defaultConfig, ["yaml-bot"]);
      const flagsCustom = derivePromptFeatureFlags(setWithCustom.tools, setWithCustom.subAgents);
      assert.equal(flagsCustom.subagentDelegation, true);
    });

    it("derivePromptFeatureFlags returns false when all registered agents are disabled", () => {
      registerSubAgentMeta({ name: "only-agent", description: "Only" });
      const set = computeEnabledSet({ ...defaultConfig, disabled_sub_agents: ["only-agent"] }, [
        "only-agent",
      ]);
      const flags = derivePromptFeatureFlags(set.tools, set.subAgents);
      assert.equal(flags.subagentDelegation, false);
    });
  });
});
