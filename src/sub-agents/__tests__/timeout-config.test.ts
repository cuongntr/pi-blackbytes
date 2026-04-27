/**
 * Tests for per-agent timeoutMs configuration (bead pib-vyj.2.1).
 *
 * Covers:
 *  - Builtin defaults via staticOverrides
 *  - JSON config override
 *  - YAML config override
 *  - JSON-over-YAML precedence
 *  - Invalid-value rejection (schema + snapshot guard)
 *  - registerSubAgent → runNestedPi option pass-through
 *  - Runner timeout enforcement (SIGKILL/cancellation kept green)
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import { parseBlackbytesConfig } from "../../config/schema.js";
import type { BlackbytesConfig } from "../../config/schema.js";
import { defineSubAgent } from "../declaration.js";
import { exploreDeclaration } from "../explore.js";
import { generalDeclaration } from "../general.js";
import { librarianDeclaration } from "../librarian.js";
import { oracleDeclaration } from "../oracle.js";
import { registerSubAgent } from "../register.js";
import { reviewerDeclaration } from "../reviewer.js";
import type { SpawnFn } from "../runner.js";
import { runNestedPi } from "../runner.js";
import { _resetAgentSnapshot, initAgentSnapshot, resolveAgentSnapshot } from "../snapshot.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultConfig: BlackbytesConfig = {
  disabled_tools: [],
  disabled_sub_agents: [],
  hashline_edit: true,
  copilot_initiator_header: true,
};

const baseDecl = defineSubAgent<{ q: string }>({
  name: "explore",
  toolName: "delegate_explore",
  description: "test",
  parameters: Type.Object({ q: Type.String() }),
  systemPrompt: "x",
  allowedTools: ["read"],
  source: "builtin",
  buildUserPrompt: (p) => p.q,
});

function makeFakeChild(opts: {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number | null;
  delay?: number;
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
  child.kill = (_signal?: string) => {
    child.killed = true;
    process.nextTick(() => child.emit("close", null));
  };

  const delay = opts.delay ?? 10;
  setTimeout(() => {
    if (opts.stdoutData) child.stdout.emit("data", Buffer.from(opts.stdoutData));
    if (opts.stderrData) child.stderr.emit("data", Buffer.from(opts.stderrData));
    child.emit("close", opts.exitCode ?? 0);
  }, delay);

  return child;
}

function makeCapturingSpawnFn(
  opts: { stdoutData?: string; stderrData?: string; exitCode?: number; delay?: number },
  onSpawn?: (args: string[], options: { cwd?: string }) => void,
): SpawnFn {
  return ((_cmd: string, args: string[], options: { cwd?: string }) => {
    onSpawn?.(args, options);
    return makeFakeChild(opts);
  }) as unknown as SpawnFn;
}

function makeFakePi(): ExtensionAPI & {
  registeredTools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
} {
  const registeredTools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  return {
    registeredTools,
    on: () => {},
    registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      registeredTools.set(def.name, def);
    },
    registerProvider: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI & { registeredTools: typeof registeredTools };
}

// ---------------------------------------------------------------------------
// Builtin defaults
// ---------------------------------------------------------------------------

describe("timeoutMs builtin defaults", () => {
  beforeEach(() => {
    _resetAgentSnapshot();
    _resetEnabledSet();
    initEnabledSet(defaultConfig);
  });

  afterEach(() => {
    _resetEnabledSet();
  });

  it("explore has default timeoutMs=600000", () => {
    const snap = resolveAgentSnapshot(exploreDeclaration, defaultConfig);
    assert.equal(snap.timeoutMs, 600_000);
  });

  it("librarian has default timeoutMs=900000", () => {
    const snap = resolveAgentSnapshot(librarianDeclaration, defaultConfig);
    assert.equal(snap.timeoutMs, 900_000);
  });

  it("oracle has default timeoutMs=1200000", () => {
    const snap = resolveAgentSnapshot(oracleDeclaration, defaultConfig);
    assert.equal(snap.timeoutMs, 1_200_000);
  });

  it("general has default timeoutMs=1800000", () => {
    const snap = resolveAgentSnapshot(generalDeclaration, defaultConfig);
    assert.equal(snap.timeoutMs, 1_800_000);
  });

  it("reviewer has default timeoutMs=900000", () => {
    const snap = resolveAgentSnapshot(reviewerDeclaration, defaultConfig);
    assert.equal(snap.timeoutMs, 900_000);
  });
});

// ---------------------------------------------------------------------------
// JSON config override
// ---------------------------------------------------------------------------

describe("timeoutMs JSON config override", () => {
  beforeEach(() => _resetAgentSnapshot());

  it("JSON sub_agents.<name>.timeoutMs overrides declaration default", () => {
    const config: BlackbytesConfig = {
      ...defaultConfig,
      sub_agents: { explore: { timeoutMs: 60_000 } },
    };
    const snap = resolveAgentSnapshot(baseDecl, config);
    assert.equal(snap.timeoutMs, 60_000);
  });

  it("JSON timeoutMs=undefined falls back to declaration default", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { timeoutMs: 180_000 },
    });
    const snap = resolveAgentSnapshot(decl, defaultConfig);
    assert.equal(snap.timeoutMs, 180_000);
  });

  it("invalid JSON timeoutMs (non-integer) is silently ignored, falls back to declaration default", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { timeoutMs: 99_000 },
    });
    const config: BlackbytesConfig = {
      ...defaultConfig,
      sub_agents: { explore: { timeoutMs: 1.5 as unknown as number } },
    };
    const snap = resolveAgentSnapshot(decl, config);
    assert.equal(snap.timeoutMs, 99_000, "fell back to declaration default");
  });

  it("invalid JSON timeoutMs (non-positive) is silently ignored", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { timeoutMs: 99_000 },
    });
    const config: BlackbytesConfig = {
      ...defaultConfig,
      sub_agents: { explore: { timeoutMs: -1 as unknown as number } },
    };
    const snap = resolveAgentSnapshot(decl, config);
    assert.equal(snap.timeoutMs, 99_000, "fell back to declaration default");
  });

  it("invalid JSON timeoutMs (zero) is silently ignored", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { timeoutMs: 99_000 },
    });
    const config: BlackbytesConfig = {
      ...defaultConfig,
      sub_agents: { explore: { timeoutMs: 0 as unknown as number } },
    };
    const snap = resolveAgentSnapshot(decl, config);
    assert.equal(snap.timeoutMs, 99_000, "fell back to declaration default");
  });

  it("invalid JSON timeoutMs (exceeds 1h max) is silently ignored", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { timeoutMs: 99_000 },
    });
    const config: BlackbytesConfig = {
      ...defaultConfig,
      sub_agents: { explore: { timeoutMs: 3_600_001 as unknown as number } },
    };
    const snap = resolveAgentSnapshot(decl, config);
    assert.equal(snap.timeoutMs, 99_000, "fell back to declaration default");
  });
});

// ---------------------------------------------------------------------------
// JSON schema validation (parseBlackbytesConfig)
// ---------------------------------------------------------------------------

describe("timeoutMs JSON schema validation", () => {
  it("accepts valid timeoutMs in schema", () => {
    const result = parseBlackbytesConfig({
      sub_agents: { myagent: { timeoutMs: 300_000 } },
    });
    assert.equal(result.ok, true);
  });

  it("rejects non-integer timeoutMs", () => {
    const result = parseBlackbytesConfig({
      sub_agents: { myagent: { timeoutMs: 1.5 } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => /integer/i.test(e)));
  });

  it("rejects non-positive timeoutMs", () => {
    const result = parseBlackbytesConfig({
      sub_agents: { myagent: { timeoutMs: -1 } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => /positive/i.test(e)));
  });

  it("rejects zero timeoutMs", () => {
    const result = parseBlackbytesConfig({
      sub_agents: { myagent: { timeoutMs: 0 } },
    });
    assert.equal(result.ok, false);
  });

  it("rejects timeoutMs > 3600000", () => {
    const result = parseBlackbytesConfig({
      sub_agents: { myagent: { timeoutMs: 3_600_001 } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => /3600000|1 hour/i.test(e)));
  });

  it("accepts boundary value 3600000", () => {
    const result = parseBlackbytesConfig({
      sub_agents: { myagent: { timeoutMs: 3_600_000 } },
    });
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// YAML override (via staticOverrides in declaration)
// ---------------------------------------------------------------------------

describe("timeoutMs YAML override", () => {
  beforeEach(() => _resetAgentSnapshot());

  it("YAML timeout_ms is folded into staticOverrides.timeoutMs", () => {
    // Simulate what loader.toDeclaration() produces for timeout_ms: 90000
    const yamlDecl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      name: "yaml_agent",
      toolName: "delegate_yaml_agent",
      source: "yaml",
      staticOverrides: { timeoutMs: 90_000 },
    });
    const snap = resolveAgentSnapshot(yamlDecl, defaultConfig);
    assert.equal(snap.timeoutMs, 90_000);
  });

  it("JSON timeoutMs takes precedence over YAML-derived staticOverrides (JSON-over-YAML)", () => {
    const yamlDecl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      name: "yaml_agent",
      toolName: "delegate_yaml_agent",
      source: "yaml",
      staticOverrides: { timeoutMs: 90_000 },
    });
    const config: BlackbytesConfig = {
      ...defaultConfig,
      sub_agents: { yaml_agent: { timeoutMs: 45_000 } },
    };
    const snap = resolveAgentSnapshot(yamlDecl, config);
    assert.equal(snap.timeoutMs, 45_000, "JSON must win over YAML default");
  });
});

// ---------------------------------------------------------------------------
// AgentSnapshot exposes timeoutMs
// ---------------------------------------------------------------------------

describe("AgentSnapshot exposes timeoutMs", () => {
  beforeEach(() => _resetAgentSnapshot());

  it("snapshot.timeoutMs is available and frozen", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { timeoutMs: 120_000 },
    });
    const snap = resolveAgentSnapshot(decl, defaultConfig);
    assert.equal(snap.timeoutMs, 120_000);
    assert.equal(Object.isFrozen(snap), true);
  });
});

// ---------------------------------------------------------------------------
// registerSubAgent → runNestedPi option pass-through
// ---------------------------------------------------------------------------

describe("registerSubAgent passes timeoutMs to runNestedPi options", () => {
  beforeEach(() => {
    _resetEnabledSet();
    _resetAgentSnapshot();
    delete process.env.PI_NESTED_DEPTH;
  });

  afterEach(() => {
    _resetEnabledSet();
    _resetAgentSnapshot();
    delete process.env.PI_NESTED_DEPTH;
  });

  it("passes snapshot timeoutMs to runNestedPi (not as CLI flag)", async () => {
    initEnabledSet(defaultConfig);

    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { timeoutMs: 45_000 },
    });

    initAgentSnapshot([decl], defaultConfig);

    const pi = makeFakePi();
    const spawnedArgs: string[][] = [];

    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, (args) => {
      spawnedArgs.push(args);
    });

    registerSubAgent(pi, decl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute("call-1", { q: "q" });

    const args = spawnedArgs[0] ?? [];
    // timeoutMs must NOT appear in CLI args
    assert.ok(!args.includes("--timeout"), "timeoutMs must not be a CLI flag");
    assert.ok(!args.includes("--timeout-ms"), "timeoutMs must not be a CLI flag");
    // Verify we spawned at least once (timeout was accepted as option, not rejected)
    assert.equal(spawnedArgs.length, 1);
  });

  it("JSON config timeoutMs flows through snapshot to runNestedPi", async () => {
    initEnabledSet(defaultConfig);

    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { timeoutMs: 45_000 },
    });

    initAgentSnapshot([decl], {
      ...defaultConfig,
      sub_agents: { explore: { timeoutMs: 30_000 } },
    });

    const pi = makeFakePi();
    let spawned = false;

    const spawnFn = makeCapturingSpawnFn({ stdoutData: "ok", exitCode: 0 }, () => {
      spawned = true;
    });

    registerSubAgent(pi, decl, { spawnFn });
    const tool = pi.registeredTools.get("delegate_explore")!;
    await tool.execute("call-1", { q: "q" });

    assert.equal(spawned, true, "runNestedPi should have been called");
  });
});

// ---------------------------------------------------------------------------
// Runner timeout enforcement (keep existing SIGKILL/cancellation tests green)
// ---------------------------------------------------------------------------

describe("runNestedPi timeout enforcement with custom timeoutMs", () => {
  beforeEach(() => {
    delete process.env.PI_NESTED_DEPTH;
  });

  afterEach(() => {
    delete process.env.PI_NESTED_DEPTH;
  });

  it("respects custom timeoutMs option: resolves timed_out when process hangs", async () => {
    const hangingSpawnFn: SpawnFn = ((_cmd: string, _args: string[]) => {
      // Never emits close — simulates hanging process
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
      return child;
    }) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "x",
        userPrompt: "y",
        allowedTools: [],
        timeoutMs: 50, // 50ms — very short for test
        killGraceMs: 10,
      },
      hangingSpawnFn,
    );

    assert.equal(result.success, false);
    assert.equal(result.failureKind, "timed_out");
  });

  it("completes normally when process exits before custom timeoutMs", async () => {
    const fastSpawnFn = makeCapturingSpawnFn({ stdoutData: "done", exitCode: 0, delay: 5 });

    const result = await runNestedPi(
      {
        systemPrompt: "x",
        userPrompt: "y",
        allowedTools: [],
        timeoutMs: 5_000, // 5s — plenty of time
      },
      fastSpawnFn,
    );

    assert.equal(result.success, true);
    assert.equal(result.content, "done");
  });
});
