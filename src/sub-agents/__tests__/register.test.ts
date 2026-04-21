import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import type { BlackbytesConfig } from "../../config/schema.js";
import { defineSubAgent } from "../declaration.js";
import { registerSubAgent } from "../register.js";
import type { SpawnFn } from "../runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultConfig: BlackbytesConfig = {
  disabled_tools: [],
  disabled_sub_agents: [],
  hashline_edit: true,
  copilot_initiator_header: true,
};

function makeFakeChild(opts: { stdoutData?: string; exitCode?: number | null }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => void;
    killed: boolean;
    stdin: null;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    process.nextTick(() => child.emit("close", null));
  };

  setTimeout(() => {
    if (opts.stdoutData) {
      child.stdout.emit("data", Buffer.from(opts.stdoutData));
    }
    child.emit("close", opts.exitCode ?? 0);
  }, 10);

  return child;
}

function makeCapturingSpawnFn(
  opts: { stdoutData?: string; exitCode?: number },
  onSpawn?: (args: string[]) => void,
): SpawnFn {
  return ((_cmd: string, args: string[]) => {
    onSpawn?.(args);
    return makeFakeChild(opts);
  }) as unknown as SpawnFn;
}

function extractAllowedTools(args: string[]): string[] {
  const idx = args.indexOf("--tools");
  if (idx === -1) return [];
  return (args[idx + 1] ?? "").split(",");
}

function makeFakePi(): {
  registeredTools: Map<string, { execute: (p: any) => Promise<any> }>;
} & ExtensionAPI {
  const registeredTools = new Map<string, { execute: (p: any) => Promise<any> }>();
  return {
    registeredTools,
    on: () => {},
    registerTool: (def: any) => {
      registeredTools.set(def.name, def);
    },
    registerProvider: () => {},
    registerCommand: () => {},
  } as unknown as {
    registeredTools: Map<string, { execute: (p: any) => Promise<any> }>;
  } & ExtensionAPI;
}

// A minimal declaration for testing
const testDecl = defineSubAgent<{ question: string }>({
  name: "explore",
  toolName: "delegate_explore",
  description: "Test explore description",
  parameters: Type.Object({
    question: Type.String({ description: "The question" }),
  }),
  systemPromptPath: "prompts/explore.md",
  allowedTools: ["read", "grep", "glob", "ast_search"],
  buildUserPrompt: (p) => p.question,
});

// ---------------------------------------------------------------------------
// Reset enabled-set singleton between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetEnabledSet();
  delete process.env.PI_NESTED_DEPTH;
});

afterEach(() => {
  _resetEnabledSet();
  delete process.env.PI_NESTED_DEPTH;
});

// ---------------------------------------------------------------------------
// registerSubAgent
// ---------------------------------------------------------------------------

describe("registerSubAgent", () => {
  it("registers the tool when agent is enabled", () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();

    registerSubAgent(pi, testDecl);

    assert.ok(pi.registeredTools.has("delegate_explore"));
  });

  it("skips registration when agent is disabled", () => {
    initEnabledSet({ ...defaultConfig, disabled_sub_agents: ["explore"] });
    const pi = makeFakePi();

    registerSubAgent(pi, testDecl);

    assert.equal(pi.registeredTools.size, 0);
  });

  it("passes user prompt from buildUserPrompt to runNestedPi", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "result", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute({ question: "Where is the auth module?" });

    // -p <userPrompt> should be the question
    const pIdx = capturedArgs.indexOf("-p");
    assert.ok(pIdx >= 0, "should pass -p flag");
    assert.equal(capturedArgs[pIdx + 1], "Where is the auth module?");
  });

  it("passes static allowedTools to runNestedPi", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute({ question: "test" });

    const tools = extractAllowedTools(capturedArgs);
    assert.deepEqual(tools, ["read", "grep", "glob", "ast_search"]);
  });

  it("resolves dynamic allowedTools at execution time", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    const dynamicDecl = defineSubAgent<{ task: string }>({
      name: "explore",
      toolName: "delegate_explore",
      description: "dynamic test",
      parameters: Type.Object({ task: Type.String() }),
      systemPromptPath: "prompts/explore.md",
      allowedTools: () => ["read", "grep"],
      buildUserPrompt: (p) => p.task,
    });

    registerSubAgent(pi, dynamicDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute({ task: "find something" });

    const tools = extractAllowedTools(capturedArgs);
    assert.deepEqual(tools, ["read", "grep"]);
  });

  it("applies model overrides from resolveModelOverrides", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    const declWithOverrides = defineSubAgent<{ question: string }>({
      name: "explore",
      toolName: "delegate_explore",
      description: "with overrides",
      parameters: Type.Object({ question: Type.String() }),
      systemPromptPath: "prompts/explore.md",
      allowedTools: ["read"],
      buildUserPrompt: (p) => p.question,
      resolveModelOverrides: () => ({ model: "o3", reasoningEffort: "high" }),
    });

    registerSubAgent(pi, declWithOverrides, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute({ question: "test" });

    const modelIdx = capturedArgs.indexOf("--model");
    assert.ok(modelIdx >= 0, "should pass --model");
    assert.equal(capturedArgs[modelIdx + 1], "o3");
  });

  it("applies async model overrides", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    const declWithAsyncOverrides = defineSubAgent<{ question: string }>({
      name: "explore",
      toolName: "delegate_explore",
      description: "with async overrides",
      parameters: Type.Object({ question: Type.String() }),
      systemPromptPath: "prompts/explore.md",
      allowedTools: ["read"],
      buildUserPrompt: (p) => p.question,
      resolveModelOverrides: async () => ({
        model: "claude-sonnet",
        reasoningEffort: "medium",
      }),
    });

    registerSubAgent(pi, declWithAsyncOverrides, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute({ question: "test" });

    const modelIdx = capturedArgs.indexOf("--model");
    assert.ok(modelIdx >= 0, "should pass --model");
    assert.equal(capturedArgs[modelIdx + 1], "claude-sonnet");
  });

  it("returns error content on runNestedPi failure", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    const spawnFn = makeCapturingSpawnFn({ exitCode: 1 });

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    const result = await tool.execute({ question: "test" });

    assert.match(result.content, /^Error:/);
  });

  it("returns success content on runNestedPi success", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "found it!", exitCode: 0 });

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    const result = await tool.execute({ question: "test" });

    assert.equal(result.content, "found it!");
  });

  it("refuses nested invocation at depth >= 1", async () => {
    initEnabledSet(defaultConfig);
    process.env.PI_NESTED_DEPTH = "1";
    const pi = makeFakePi();
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 });

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    const result = await tool.execute({ question: "test" });

    assert.match(result.content, /Error:.*recursion/);
  });

  it("reads system prompt from declaration path", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute({ question: "test" });

    // --system-prompt should be passed with non-empty content
    const spIdx = capturedArgs.indexOf("--system-prompt");
    assert.ok(spIdx >= 0, "should pass --system-prompt");
    assert.ok(capturedArgs[spIdx + 1]!.length > 0, "system prompt should not be empty");
  });
});
