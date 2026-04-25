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

function makeFakeChild(opts: {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number | null;
}) {
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
    if (opts.stderrData) {
      child.stderr.emit("data", Buffer.from(opts.stderrData));
    }
    child.emit("close", opts.exitCode ?? 0);
  }, 10);

  return child;
}

function makeCapturingSpawnFn(
  opts: { stdoutData?: string; stderrData?: string; exitCode?: number },
  onSpawn?: (args: string[], options: { cwd?: string }) => void,
): SpawnFn {
  return ((_cmd: string, args: string[], options: { cwd?: string }) => {
    onSpawn?.(args, options);
    return makeFakeChild(opts);
  }) as unknown as SpawnFn;
}

function extractAllowedTools(args: string[]): string[] {
  const idx = args.indexOf("--tools");
  if (idx === -1) return [];
  return (args[idx + 1] ?? "").split(",");
}

function makeFakePi(): {
  registeredTools: Map<
    string,
    {
      execute: (
        toolCallId: string,
        p: any,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: { cwd?: string },
      ) => Promise<any>;
    }
  >;
} & ExtensionAPI {
  const registeredTools = new Map<
    string,
    {
      execute: (
        toolCallId: string,
        p: any,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: { cwd?: string },
      ) => Promise<any>;
    }
  >();
  return {
    registeredTools,
    on: () => {},
    registerTool: (def: any) => {
      registeredTools.set(def.name, def);
    },
    registerProvider: () => {},
    registerCommand: () => {},
  } as unknown as {
    registeredTools: Map<
      string,
      {
        execute: (
          toolCallId: string,
          p: any,
          signal?: AbortSignal,
          onUpdate?: unknown,
          ctx?: { cwd?: string },
        ) => Promise<any>;
      }
    >;
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
    await tool.execute("test-call", { question: "Where is the auth module?" });

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
    await tool.execute("test-call", { question: "test" });

    const tools = extractAllowedTools(capturedArgs);
    assert.deepEqual(tools, ["ast_search", "glob", "grep", "read"]);
  });

  it("passes tool execution cwd to nested Pi", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    let capturedCwd: string | undefined;
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (_args, options) => {
      capturedCwd = options.cwd;
    });

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute("test-call", { question: "test" }, undefined, undefined, {
      cwd: "/tmp/host-workspace",
    });

    assert.equal(capturedCwd, "/tmp/host-workspace");
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
    await tool.execute("test-call", { task: "find something" });

    const tools = extractAllowedTools(capturedArgs);
    assert.deepEqual(tools, ["grep", "read"]);
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
    await tool.execute("test-call", { question: "test" });

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
    await tool.execute("test-call", { question: "test" });

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
    const result = await tool.execute("test-call", { question: "test" });

    assert.match(result.content[0].text, /^Error:/);
  });

  it("returns formatted failure details from runNestedPi failure", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    const spawnFn = makeCapturingSpawnFn({
      stderrData:
        'OPENAI_API_KEY=secret-token\nTOKEN=\'quoted-secret\'\n{"api_key": "json-secret"}\nUnknown tool delegate_general',
      exitCode: 1,
    });

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    const result = await tool.execute("test-call", { question: "test" });

    assert.match(result.content[0].text, /^Error: Nested Pi failed \(invalid_tool_allowlist\)/);
    assert.match(result.content[0].text, /Details:/);
    assert.match(result.content[0].text, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(result.content[0].text, /secret-token/);
    assert.doesNotMatch(result.content[0].text, /quoted-secret/);
    assert.doesNotMatch(result.content[0].text, /json-secret/);
  });

  it("returns success content on runNestedPi success", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "found it!", exitCode: 0 });

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    const result = await tool.execute("test-call", { question: "test" });

    assert.equal(result.content[0].text, "found it!");
  });

  it("streams safe collapsed progress updates with expandable details", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    const events = [
      { type: "message_start", message: { model: "resolved-model" } },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "OPENAI_API_KEY=secret-token\n",
          partial: {},
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "useful output",
          partial: {},
        },
      },
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "OPENAI_API_KEY=secret-token\nuseful output" }],
          },
        ],
      },
    ];
    const stdoutData = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    const spawnFn = makeCapturingSpawnFn({ stdoutData, exitCode: 0 });
    const updates: Array<{ content: Array<{ text: string }>; details: any }> = [];

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    const result = await tool.execute(
      "test-call",
      { question: "test" },
      undefined,
      (update: { content: Array<{ text: string }>; details: any }) => updates.push(update),
      { cwd: "/tmp/host-workspace" },
    );

    assert.equal(result.content[0].text, "OPENAI_API_KEY=secret-token\nuseful output");
    assert.ok(updates.length >= 3, "should emit start, running, and completed updates");
    assert.match(updates[0]!.content[0]!.text, /Sub-agent explore starting/);
    assert.equal(updates[0]!.details.status, "starting");
    assert.equal(updates[0]!.details.cwd, "/tmp/host-workspace");
    assert.deepEqual(updates[0]!.details.allowedTools, ["ast_search", "glob", "grep", "read"]);

    const running = updates.filter((u) => u.details.status === "running").at(-1)!;
    assert.match(running.content[0]!.text, /Sub-agent explore running/);
    assert.match(running.details.outputPreview, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(running.details.outputPreview, /secret-token/);
    assert.match(running.details.outputPreview, /useful output/);

    const finalUpdate = updates.at(-1)!;
    assert.equal(finalUpdate.details.status, "completed");
    assert.deepEqual(finalUpdate.details.attemptedModels, ["(host model)"]);
  });

  it("bounds sub-agent progress preview without changing runner result semantics", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    const hugeText = `text-head-${"x".repeat(9_000)}-text-tail`;
    const events = [
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: hugeText,
          partial: {},
        },
      },
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: hugeText }] }],
      },
    ];
    const stdoutData = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    const spawnFn = makeCapturingSpawnFn({ stdoutData, exitCode: 0 });
    const updates: Array<{ details: any }> = [];

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    const result = await tool.execute(
      "test-call",
      { question: "test" },
      undefined,
      (update: { details: any }) => updates.push(update),
    );

    assert.match(result.content[0].text, /text-head/);
    assert.match(result.content[0].text, /text-tail/);
    const running = updates.filter((u) => u.details.status === "running").at(-1)!;
    assert.ok(running.details.outputPreview.length <= 8_192);
    assert.match(running.details.outputPreview, /text-head/);
    assert.match(running.details.outputPreview, /text-tail/);
    assert.match(running.details.outputPreview, /truncated/);
  });

  it("refuses nested invocation at depth >= 1", async () => {
    initEnabledSet(defaultConfig);
    process.env.PI_NESTED_DEPTH = "1";
    const pi = makeFakePi();
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 });

    registerSubAgent(pi, testDecl, { spawnFn });

    const tool = pi.registeredTools.get("delegate_explore")!;
    const result = await tool.execute("test-call", { question: "test" });

    assert.match(result.content[0].text, /Error:.*recursion/);
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
    await tool.execute("test-call", { question: "test" });

    // --system-prompt should be passed with non-empty content
    const spIdx = capturedArgs.indexOf("--system-prompt");
    assert.ok(spIdx >= 0, "should pass --system-prompt");
    assert.ok(capturedArgs[spIdx + 1]!.length > 0, "system prompt should not be empty");
  });
});

// ---------------------------------------------------------------------------
// finalizeNestedTools wiring (acceptance criteria for canonical registry)
// ---------------------------------------------------------------------------

describe("registerSubAgent finalizer integration", () => {
  it("builtin static path: throws on unknown name BEFORE generated args are built", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    let spawned = false;
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, () => {
      spawned = true;
    });

    const badDecl = defineSubAgent<{ question: string }>({
      name: "explore",
      toolName: "delegate_explore",
      description: "test",
      parameters: Type.Object({ question: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read", "definitely_not_a_tool"],
      mutability: "read-only",
      finalizeMode: "strict",
      buildUserPrompt: (p) => p.question,
    });

    registerSubAgent(pi, badDecl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_explore")!;
    const result = await tool.execute("test-call", { question: "q" });
    const text = result.content[0].text as string;
    assert.match(text, /Unknown or delegate tool names/);
    assert.match(text, /failed before nested Pi execution/);
    assert.equal(spawned, false, "runNestedPi must not spawn when finalizer rejects");
  });

  it("builtin static path: rejects delegate_* in declared allowlist", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 });

    const badDecl = defineSubAgent<{ question: string }>({
      name: "explore",
      toolName: "delegate_explore",
      description: "test",
      parameters: Type.Object({ question: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read", "delegate_oracle"],
      mutability: "read-only",
      finalizeMode: "strict",
      buildUserPrompt: (p) => p.question,
    });

    registerSubAgent(pi, badDecl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_explore")!;
    const result = await tool.execute("test-call", { question: "q" });
    const text = result.content[0].text as string;
    assert.match(text, /delegate_oracle/);
    assert.match(text, /failed before nested Pi execution/);
  });

  it("builtin static path: applies global disabled_tools to declared allowlist", async () => {
    initEnabledSet({ ...defaultConfig, disabled_tools: ["glob", "ast_search"] });
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    const decl = defineSubAgent<{ question: string }>({
      name: "explore",
      toolName: "delegate_explore",
      description: "test",
      parameters: Type.Object({ question: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read", "grep", "glob", "ast_search"],
      mutability: "read-only",
      finalizeMode: "strict",
      buildUserPrompt: (p) => p.question,
    });

    registerSubAgent(pi, decl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute("test-call", { question: "q" });
    assert.deepEqual(extractAllowedTools(capturedArgs), ["grep", "read"]);
  });

  it("dynamic broad path: filters delegate_* and applies global disabled_tools", async () => {
    initEnabledSet({ ...defaultConfig, disabled_tools: ["hashline_edit"] });
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    // Simulates a broad dynamic resolver that returns extension+Pi tools
    // and accidentally includes delegate_* and a disabled tool.
    const decl = defineSubAgent<{ task: string }>({
      name: "explore",
      toolName: "delegate_explore",
      description: "dyn",
      parameters: Type.Object({ task: Type.String() }),
      systemPrompt: "x",
      allowedTools: () => ["read", "grep", "glob", "hashline_edit", "delegate_oracle"],
      mutability: "full-access",
      finalizeMode: "lenient",
      buildUserPrompt: (p) => p.task,
    });

    registerSubAgent(pi, decl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute("test-call", { task: "t" });
    const tools = extractAllowedTools(capturedArgs);
    assert.deepEqual(tools, ["glob", "grep", "read"]);
    assert.ok(!tools.some((t) => t.startsWith("delegate_")), "delegate_* leaked");
    assert.ok(!tools.includes("hashline_edit"), "globally disabled tool leaked");
  });

  it("YAML allowlist path: lenient finalizer drops unknown + applies global disable + sorts", async () => {
    initEnabledSet({ ...defaultConfig, disabled_tools: ["web_search"] }, ["yaml_agent"]);
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    // Mirrors what loader.ts produces for `allowed_tools: [...]`:
    //  - static array allowedTools
    //  - mutability: 'read-only'
    //  - finalizeMode: 'lenient'
    const decl = defineSubAgent<{ prompt: string }>({
      name: "yaml_agent",
      toolName: "delegate_yaml_agent",
      description: "yaml",
      parameters: Type.Object({ prompt: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read", "grep", "web_search", "unknown_tool", "delegate_x"],
      mutability: "read-only",
      finalizeMode: "lenient",
      buildUserPrompt: (p) => p.prompt,
    });

    registerSubAgent(pi, decl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_yaml_agent")!;
    await tool.execute("test-call", { prompt: "q" });
    const tools = extractAllowedTools(capturedArgs);
    assert.deepEqual(tools, ["grep", "read"]);
  });

  it("YAML denylist path: lenient finalizer applies global disable on top", async () => {
    _resetEnabledSet();
    initEnabledSet({ ...defaultConfig, disabled_tools: ["glob"] }, ["yaml_agent"]);
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    // Mirrors `denied_tools: ['web_search']` -> dynamic resolver
    // returning enabledTools ∪ PI_DEFAULT_TOOLS minus denied minus delegate_*.
    const decl = defineSubAgent<{ prompt: string }>({
      name: "yaml_agent",
      toolName: "delegate_yaml_agent",
      description: "yaml denylist",
      parameters: Type.Object({ prompt: Type.String() }),
      systemPrompt: "x",
      // The actual loader uses resolveToolStrategy(); for this test we simulate
      // the pre-finalizer output directly.
      allowedTools: () => ["read", "grep", "glob", "ast_search"],
      mutability: "read-only",
      finalizeMode: "lenient",
      buildUserPrompt: (p) => p.prompt,
    });

    registerSubAgent(pi, decl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_yaml_agent")!;
    await tool.execute("test-call", { prompt: "q" });
    const tools = extractAllowedTools(capturedArgs);
    // glob is globally disabled.
    assert.deepEqual(tools, ["ast_search", "grep", "read"]);
    assert.ok(!tools.some((t) => t.startsWith("delegate_")));
  });

  it("read-only mutability strips mutating tools even when explicitly listed", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    const decl = defineSubAgent<{ q: string }>({
      name: "explore",
      toolName: "delegate_explore",
      description: "x",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      // Lenient so finalizer drops mutating instead of throwing on the strict-only
      // "unknown" path. Mutating tools are never in the unknown bucket; they are
      // dropped by mutability. Either mode demonstrates the strip behavior.
      allowedTools: ["read", "write", "bash", "hashline_edit", "ast_replace"],
      mutability: "read-only",
      finalizeMode: "lenient",
      buildUserPrompt: (p) => p.q,
    });

    registerSubAgent(pi, decl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute("test-call", { q: "q" });
    assert.deepEqual(extractAllowedTools(capturedArgs), ["read"]);
  });
});

// ---------------------------------------------------------------------------
// general sub-agent broad allowlist + safety overlay (AC #1, AC #4)
// ---------------------------------------------------------------------------

describe("general sub-agent", () => {
  it("--tools includes Pi built-ins + extension tools, excludes delegate_*, respects globalDisabled", async () => {
    initEnabledSet({ ...defaultConfig, disabled_tools: ["web_search"] });
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    // Use the actual general declaration
    const generalModule = await import("../general.js");
    registerSubAgent(pi, generalModule.generalDeclaration, { spawnFn });
    const tool = pi.registeredTools.get("delegate_general")!;
    await tool.execute("test-call", { task: "do a thing" });

    const tools = extractAllowedTools(capturedArgs);
    // Pi built-ins must be present.
    for (const builtin of ["read", "bash", "edit", "write"]) {
      assert.ok(tools.includes(builtin), `Pi built-in ${builtin} must be present`);
    }
    // Extension tools must be present.
    assert.ok(tools.includes("hashline_edit"), "extension tool must be present");
    // No delegate_*.
    assert.ok(!tools.some((t) => t.startsWith("delegate_")), "delegate_* must not leak");
    // Globally disabled tool excluded.
    assert.ok(!tools.includes("web_search"), "globally disabled tool must be filtered");
  });

  it("system prompt includes the safety overlay header when broad tools are passed", async () => {
    initEnabledSet(defaultConfig);
    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    const generalModule = await import("../general.js");
    const overlayModule = await import("../general-safety-overlay.js");
    registerSubAgent(pi, generalModule.generalDeclaration, { spawnFn });
    const tool = pi.registeredTools.get("delegate_general")!;
    await tool.execute("test-call", { task: "go" });

    const spIdx = capturedArgs.indexOf("--system-prompt");
    assert.ok(spIdx >= 0, "--system-prompt must be passed");
    const sp = capturedArgs[spIdx + 1] ?? "";
    assert.ok(
      sp.includes(overlayModule.GENERAL_SAFETY_OVERLAY_HEADER),
      "safety overlay header must appear in general's system prompt",
    );
    assert.ok(
      sp.includes(overlayModule.GENERAL_SAFETY_OVERLAY_FOOTER),
      "safety overlay footer must appear in general's system prompt",
    );
  });
});

// ---------------------------------------------------------------------------
// Per-agent snapshot drives model/reasoning resolution (bead pib-vyj.1.5)
// ---------------------------------------------------------------------------

describe("registerSubAgent snapshot integration", () => {
  it("reads model + reasoningEffort from the active session snapshot", async () => {
    const { _resetAgentSnapshot, initAgentSnapshot } = await import("../snapshot.js");
    initEnabledSet(defaultConfig);
    _resetAgentSnapshot();

    const decl = defineSubAgent<{ q: string }>({
      name: "explore",
      toolName: "delegate_explore",
      description: "x",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read"],
      mutability: "read-only",
      finalizeMode: "strict",
      source: "builtin",
      // Declaration default — should be overridden by snapshot below.
      staticOverrides: { model: "decl-model", reasoningEffort: "low" },
      buildUserPrompt: (p) => p.q,
    });

    initAgentSnapshot([decl], {
      ...defaultConfig,
      sub_agents: { explore: { model: "snap-model", reasoningEffort: "high" } },
    });

    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    registerSubAgent(pi, decl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute("call-1", { q: "q" });

    const modelIdx = capturedArgs.indexOf("--model");
    const thinkingIdx = capturedArgs.indexOf("--thinking");
    assert.ok(modelIdx >= 0, "--model should be passed");
    assert.equal(capturedArgs[modelIdx + 1], "snap-model");
    assert.ok(thinkingIdx >= 0, "--thinking should be passed");
    assert.equal(capturedArgs[thinkingIdx + 1], "high");
  });

  it("snapshot is the source of truth even if config disk-state changes after startup", async () => {
    const { _resetAgentSnapshot, initAgentSnapshot } = await import("../snapshot.js");
    initEnabledSet(defaultConfig);
    _resetAgentSnapshot();

    const decl = defineSubAgent<{ q: string }>({
      name: "explore",
      toolName: "delegate_explore",
      description: "x",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read"],
      mutability: "read-only",
      finalizeMode: "strict",
      source: "builtin",
      buildUserPrompt: (p) => p.q,
    });

    const config: BlackbytesConfig = {
      ...defaultConfig,
      sub_agents: { explore: { model: "frozen-model" } },
    };
    initAgentSnapshot([decl], config);

    // Simulate disk mutation after session_start finished.
    config.sub_agents = { explore: { model: "mutated-after-startup" } };

    const pi = makeFakePi();
    let capturedArgs: string[] = [];
    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      capturedArgs = args;
    });

    registerSubAgent(pi, decl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute("call-frozen", { q: "q" });

    const modelIdx = capturedArgs.indexOf("--model");
    assert.equal(capturedArgs[modelIdx + 1], "frozen-model", "snapshot must remain stable");
  });
});
