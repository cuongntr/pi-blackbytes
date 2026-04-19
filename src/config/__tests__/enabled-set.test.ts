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
  isBundledTool,
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
  });

  it("default config enables all tools, subAgents, and skills", () => {
    const set = computeEnabledSet(defaultConfig);
    assert.ok(set.tools.has("hashline_edit"));
    assert.ok(set.tools.has("grep_app_search_github"));
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
  });
});
