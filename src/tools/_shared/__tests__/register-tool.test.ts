import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { _resetEnabledSet, initEnabledSet } from "../../../config/enabled-set.js";
import { parseBlackbytesConfig } from "../../../config/schema.js";
import { registerTool } from "../register-tool.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  const result = parseBlackbytesConfig(overrides);
  if (!result.ok) throw new Error(result.errors.join(", "));
  return result.value;
}

describe("registerTool", () => {
  beforeEach(() => {
    _resetEnabledSet();
  });

  it("skips registration when tool is disabled", () => {
    initEnabledSet(makeConfig({ disabled_tools: ["hashline_edit"] }));

    const registered: any[] = [];
    const mockPi = {
      on() {},
      registerProvider() {},
      registerCommand() {},
      registerTool(def: any) {
        registered.push(def);
      },
    };

    registerTool(mockPi as unknown as ExtensionAPI, "hashline_edit", { name: "hashline_edit" });
    assert.equal(registered.length, 0);
  });

  it("registers tool when it is enabled", () => {
    initEnabledSet(makeConfig({}));

    const registered: any[] = [];
    const mockPi = {
      on() {},
      registerProvider() {},
      registerCommand() {},
      registerTool(def: any) {
        registered.push(def);
      },
    };

    const definition = { name: "hashline_edit", description: "Edit files" };
    registerTool(mockPi as unknown as ExtensionAPI, "hashline_edit", definition);
    assert.equal(registered.length, 1);
    assert.deepEqual(registered[0], definition);
  });

  it("skips registration silently for unknown/non-default tool names", () => {
    initEnabledSet(makeConfig({}));

    const registered: any[] = [];
    const mockPi = {
      on() {},
      registerProvider() {},
      registerCommand() {},
      registerTool(def: any) {
        registered.push(def);
      },
    };

    registerTool(mockPi as unknown as ExtensionAPI, "nonexistent_tool", {
      name: "nonexistent_tool",
    });
    assert.equal(registered.length, 0);
  });
});
