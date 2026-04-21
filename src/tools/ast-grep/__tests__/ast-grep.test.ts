import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import { _resetEnabledSet, initEnabledSet } from "../../../config/enabled-set.js";
import { parseBlackbytesConfig } from "../../../config/schema.js";
import { registerAstGrepReplaceTool } from "../replace.js";
import { registerAstGrepSearchTool } from "../search.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  const result = parseBlackbytesConfig(overrides);
  if (!result.ok) throw new Error(result.errors.join(", "));
  return result.value;
}

function makeMockPi() {
  const registered: any[] = [];
  return {
    pi: {
      on() {},
      registerProvider() {},
      registerCommand() {},
      registerTool(def: any) {
        registered.push(def);
      },
    },
    registered,
  };
}

describe("ast_search tool", () => {
  beforeEach(() => {
    _resetEnabledSet();
  });

  it("registers ast_search when enabled", () => {
    initEnabledSet(makeConfig({}));
    const { pi, registered } = makeMockPi();
    registerAstGrepSearchTool(pi as any);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "ast_search");
  });

  it("does not register ast_search when disabled", () => {
    initEnabledSet(makeConfig({ disabled_tools: ["ast_search"] }));
    const { pi, registered } = makeMockPi();
    registerAstGrepSearchTool(pi as any);
    assert.equal(registered.length, 0);
  });

  it("returns error when ast-grep binary is missing", async () => {
    initEnabledSet(makeConfig({}));
    const { pi, registered } = makeMockPi();
    registerAstGrepSearchTool(pi as any);

    const tool = registered[0];
    assert.ok(tool, "tool should be registered");

    // Mock detectBinary by overriding PATH to simulate missing binary
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await tool.execute({
        pattern: "console.log($MSG)",
        lang: "javascript",
      });
      // Should return an error about the missing binary
      assert.ok(
        result.isError === true ||
          result.content[0].text.includes("not found") ||
          result.content[0].text.includes("Error"),
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("tool definition has correct schema fields", () => {
    initEnabledSet(makeConfig({}));
    const { pi, registered } = makeMockPi();
    registerAstGrepSearchTool(pi as any);

    const tool = registered[0];
    assert.ok(tool.parameters, "should have parameters");
    assert.ok(tool.description, "should have description");
    assert.equal(tool.name, "ast_search");

    const props = tool.parameters.properties;
    assert.ok(props.pattern, "should have pattern param");
    assert.ok(props.lang, "should have lang param");
    assert.ok(props.paths, "should have paths param");
    assert.ok(props.globs, "should have globs param");
    assert.ok(props.context, "should have context param");
  });
});

describe("ast_replace tool", () => {
  beforeEach(() => {
    _resetEnabledSet();
  });

  it("registers ast_replace when enabled", () => {
    initEnabledSet(makeConfig({}));
    const { pi, registered } = makeMockPi();
    registerAstGrepReplaceTool(pi as any);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "ast_replace");
  });

  it("does not register ast_replace when disabled", () => {
    initEnabledSet(makeConfig({ disabled_tools: ["ast_replace"] }));
    const { pi, registered } = makeMockPi();
    registerAstGrepReplaceTool(pi as any);
    assert.equal(registered.length, 0);
  });

  it("tool definition has correct schema fields including dryRun", () => {
    initEnabledSet(makeConfig({}));
    const { pi, registered } = makeMockPi();
    registerAstGrepReplaceTool(pi as any);

    const tool = registered[0];
    assert.ok(tool.parameters, "should have parameters");
    const props = tool.parameters.properties;
    assert.ok(props.pattern, "should have pattern param");
    assert.ok(props.rewrite, "should have rewrite param");
    assert.ok(props.lang, "should have lang param");
    assert.ok(props.dryRun, "should have dryRun param");
  });

  it("returns error when ast-grep binary is missing", async () => {
    initEnabledSet(makeConfig({}));
    const { pi, registered } = makeMockPi();
    registerAstGrepReplaceTool(pi as any);

    const tool = registered[0];
    assert.ok(tool, "tool should be registered");

    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await tool.execute({
        pattern: "console.log($MSG)",
        rewrite: "logger.info($MSG)",
        lang: "javascript",
        dryRun: true,
      });
      assert.ok(
        result.isError === true ||
          result.content[0].text.includes("not found") ||
          result.content[0].text.includes("Error"),
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
