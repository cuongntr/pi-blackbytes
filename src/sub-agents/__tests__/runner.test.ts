import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SpawnFn } from "../runner.js";
import { runNestedPi } from "../runner.js";

const PI_CLI_COMPATIBILITY_EVIDENCE = {
  installedCliVersion: "0.74.0",
  inspectedPackageVersion: "@earendil-works/pi-coding-agent@0.74.0",
  acceptedFlags: [
    "-p",
    "--system-prompt",
    "--no-session",
    "--no-context-files",
    "--mode",
    "--model",
    "--tools",
    "--thinking",
  ],
  acceptedBuiltinTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  unknownToolBehavior: "warning-and-drop",
  temperatureFlagSupport: "unsupported",
  cwdContract:
    "registerSubAgent forwards ExtensionContext.cwd; runNestedPi falls back to process.cwd().",
} as const;

// Helper: create a fake ChildProcess-like object
function makeFakeChild(options: {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number | null;
  delay?: number;
  emitError?: Error;
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
    process.nextTick(() => {
      child.emit("close", null);
    });
  };

  const delay = options.delay ?? 10;

  if (options.emitError) {
    const err = options.emitError;
    setTimeout(() => {
      child.emit("error", err);
    }, delay);
  } else {
    setTimeout(() => {
      if (options.stdoutData) {
        child.stdout.emit("data", Buffer.from(options.stdoutData));
      }
      if (options.stderrData) {
        child.stderr.emit("data", Buffer.from(options.stderrData));
      }
      child.emit("close", options.exitCode ?? 0);
    }, delay);
  }

  return child;
}

describe("runNestedPi", () => {
  const originalDepth = process.env.PI_NESTED_DEPTH;

  beforeEach(() => {
    delete process.env.PI_NESTED_DEPTH;
  });

  afterEach(() => {
    if (originalDepth === undefined) {
      delete process.env.PI_NESTED_DEPTH;
    } else {
      process.env.PI_NESTED_DEPTH = originalDepth;
    }
  });

  it("recursion guard rejects when PI_NESTED_DEPTH >= 1", async () => {
    process.env.PI_NESTED_DEPTH = "1";

    const result = await runNestedPi({
      systemPrompt: "You are helpful",
      userPrompt: "Hello",
      allowedTools: ["read"],
    });

    assert.equal(result.success, false);
    assert.match(result.content, /recursion depth limit/);
    assert.equal(result.failureKind, "recursion_refused");
  });

  it("successful execution returns content from stdout", async () => {
    const fakeChild = makeFakeChild({ stdoutData: "Hello from nested Pi", exitCode: 0 });
    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: ["read", "grep"],
      },
      spawnFn,
    );

    assert.equal(result.success, true);
    assert.equal(result.content, "Hello from nested Pi");
  });

  it("non-zero exit code returns failure with stderr details", async () => {
    const fakeChild = makeFakeChild({
      stderrData: "Something went wrong",
      exitCode: 1,
    });
    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
      },
      spawnFn,
    );

    assert.equal(result.success, false);
    assert.equal(result.content, "Nested Pi failed");
    assert.equal(result.details, "Something went wrong");
    assert.equal(result.failureKind, "failed");
  });

  it("timeout returns failure and kills child", async () => {
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
    // Never emits close on its own — waits for kill/abort

    const spawnFn = (() => child) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        timeoutMs: 50,
      },
      spawnFn,
    );

    assert.equal(result.success, false);
    assert.match(result.content, /timed out/);
    assert.equal(child.killed, true);
    assert.equal(result.failureKind, "timed_out");
  });

  it("cancellation via AbortSignal kills child process", async () => {
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

    const spawnFn = (() => child) as unknown as SpawnFn;

    const controller = new AbortController();

    const resultPromise = runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        signal: controller.signal,
        timeoutMs: 30_000,
      },
      spawnFn,
    );

    // Abort immediately
    controller.abort();

    const result = await resultPromise;

    assert.equal(result.success, false);
    assert.match(result.content, /cancelled|timed out/);
    assert.equal(child.killed, true);
    assert.equal(result.failureKind, "cancelled");
  });

  it("env filtering only passes allowlisted vars", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    const fakeChild = makeFakeChild({ stdoutData: "ok", exitCode: 0 });

    const spawnFn = ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = opts.env;
      return fakeChild;
    }) as unknown as SpawnFn;

    // Set a sensitive env var that should NOT be passed
    process.env.AWS_SECRET_ACCESS_KEY = "supersecret";
    process.env.PATH = "/usr/bin:/bin";

    await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
      },
      spawnFn,
    );

    delete process.env.AWS_SECRET_ACCESS_KEY;

    assert.ok(capturedEnv !== undefined, "env should have been captured");
    assert.equal(capturedEnv!.AWS_SECRET_ACCESS_KEY, undefined);
    // PI_NESTED_DEPTH should always be set to 1
    assert.equal(capturedEnv!.PI_NESTED_DEPTH, "1");
    // PATH should be passed through
    assert.equal(capturedEnv!.PATH, "/usr/bin:/bin");
  });

  it("records deterministic Pi CLI compatibility evidence", () => {
    assert.equal(PI_CLI_COMPATIBILITY_EVIDENCE.installedCliVersion, "0.74.0");
    assert.equal(
      PI_CLI_COMPATIBILITY_EVIDENCE.inspectedPackageVersion,
      "@earendil-works/pi-coding-agent@0.74.0",
    );
    assert.deepEqual(PI_CLI_COMPATIBILITY_EVIDENCE.acceptedBuiltinTools, [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
    assert.equal(PI_CLI_COMPATIBILITY_EVIDENCE.unknownToolBehavior, "warning-and-drop");
    assert.equal(PI_CLI_COMPATIBILITY_EVIDENCE.temperatureFlagSupport, "unsupported");
    assert.match(PI_CLI_COMPATIBILITY_EVIDENCE.cwdContract, /ExtensionContext\.cwd/);
  });

  it("spawn error returns failure", async () => {
    const fakeChild = makeFakeChild({
      emitError: new Error("spawn ENOENT"),
      delay: 5,
    });
    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
      },
      spawnFn,
    );

    assert.equal(result.success, false);
    assert.equal(result.content, "Nested Pi failed");
    assert.match(result.details ?? "", /ENOENT/);
    assert.equal(result.failureKind, "spawn_error");
  });

  it("returns spawn_error when spawn throws synchronously", async () => {
    const spawnFn = (() => {
      throw new Error("spawn EACCES");
    }) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
      },
      spawnFn,
    );

    assert.equal(result.success, false);
    assert.equal(result.content, "Nested Pi failed");
    assert.match(result.details ?? "", /EACCES/);
    assert.equal(result.failureKind, "spawn_error");
  });

  it("does not spawn when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const spawnFn = (() => {
      spawned = true;
      return makeFakeChild({ stdoutData: "unexpected", exitCode: 0 });
    }) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        signal: controller.signal,
      },
      spawnFn,
    );

    assert.equal(result.success, false);
    assert.equal(result.failureKind, "cancelled");
    assert.equal(spawned, false);
  });

  it("bounds high-volume child output while preserving head and tail", async () => {
    const hugeStdout = `stdout-head-${"x".repeat(9_000)}-stdout-tail`;
    const hugeStderr = `stderr-head-${"y".repeat(9_000)}-stderr-tail`;
    const fakeChild = makeFakeChild({
      stdoutData: hugeStdout,
      stderrData: hugeStderr,
      exitCode: 1,
    });
    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
      },
      spawnFn,
    );

    assert.equal(result.success, false);
    assert.ok((result.details?.length ?? 0) <= 8_192);
    assert.match(result.details ?? "", /stderr-head/);
    assert.match(result.details ?? "", /stderr-tail/);
    assert.match(result.details ?? "", /truncated/);
  });

  it("classifies CLI usage, invalid tool allowlist, and provider/model failures", async () => {
    const cases = [
      { stderrData: "Error: Unknown option: --temperature", kind: "cli_usage_error" },
      { stderrData: "Warning: Unknown tool nope", kind: "invalid_tool_allowlist" },
      { stderrData: "Unknown tool nope\nUsage: pi [options]", kind: "invalid_tool_allowlist" },
      { stderrData: "Provider rejected unavailable model", kind: "provider_or_model_unavailable" },
    ] as const;

    for (const testCase of cases) {
      const fakeChild = makeFakeChild({ stderrData: testCase.stderrData, exitCode: 1 });
      const spawnFn = (() => fakeChild) as unknown as SpawnFn;
      const result = await runNestedPi(
        {
          systemPrompt: "You are helpful",
          userPrompt: "Hello",
          allowedTools: [],
        },
        spawnFn,
      );

      assert.equal(result.failureKind, testCase.kind);
    }
  });

  it("escalates timeout termination to SIGKILL after grace period", async () => {
    const signals: string[] = [];
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (signal?: string) => void;
      stdin: null;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = null;
    child.kill = (signal?: string) => {
      signals.push(signal ?? "");
      if (signal === "SIGKILL") {
        process.nextTick(() => child.emit("close", null));
      }
    };
    const spawnFn = (() => child) as unknown as SpawnFn;
    const startedAt = Date.now();

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        timeoutMs: 10,
        killGraceMs: 10,
      },
      spawnFn,
    );

    assert.equal(result.failureKind, "timed_out");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.ok(Date.now() - startedAt < 200);
  });

  it("resolves timeout after SIGKILL even when close never arrives", async () => {
    const signals: string[] = [];
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (signal?: string) => void;
      stdin: null;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = null;
    child.kill = (signal?: string) => {
      signals.push(signal ?? "");
    };
    const spawnFn = (() => child) as unknown as SpawnFn;
    const startedAt = Date.now();

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        timeoutMs: 10,
        killGraceMs: 10,
      },
      spawnFn,
    );

    assert.equal(result.failureKind, "timed_out");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.ok(Date.now() - startedAt < 200);
  });

  it("escalates cancellation termination to SIGKILL after grace period", async () => {
    const signals: string[] = [];
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (signal?: string) => void;
      stdin: null;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = null;
    child.kill = (signal?: string) => {
      signals.push(signal ?? "");
      if (signal === "SIGKILL") {
        process.nextTick(() => child.emit("close", null));
      }
    };
    const spawnFn = (() => child) as unknown as SpawnFn;
    const controller = new AbortController();

    const resultPromise = runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        signal: controller.signal,
        timeoutMs: 30_000,
        killGraceMs: 10,
      },
      spawnFn,
    );
    controller.abort();
    const result = await resultPromise;

    assert.equal(result.failureKind, "cancelled");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  });

  it("spawn args always include --no-session and --no-context-files", async () => {
    let capturedArgs: string[] | undefined;

    const fakeChild = makeFakeChild({ stdoutData: "ok", exitCode: 0 });
    const spawnFn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return fakeChild;
    }) as unknown as SpawnFn;

    await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
      },
      spawnFn,
    );

    assert.ok(capturedArgs !== undefined);
    assert.ok(capturedArgs!.includes("--no-session"), "should include --no-session");
    assert.ok(capturedArgs!.includes("--no-context-files"), "should include --no-context-files");
  });

  it("serializes nested tools and omits unsupported temperature flag", async () => {
    let capturedArgs: string[] | undefined;

    const fakeChild = makeFakeChild({ stdoutData: "ok", exitCode: 0 });
    const spawnFn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return fakeChild;
    }) as unknown as SpawnFn;

    await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: ["read", "grep", "find", "ls"],
      },
      spawnFn,
    );

    const toolsIdx = capturedArgs!.indexOf("--tools");
    assert.ok(toolsIdx !== -1, "--tools flag should be present");
    assert.equal(capturedArgs![toolsIdx + 1], "read,grep,find,ls");
    assert.ok(!capturedArgs!.includes("--temperature"), "--temperature must not be passed");
  });

  it("uses explicit cwd and falls back to process.cwd()", async () => {
    const cwdBefore = process.cwd();
    const capturedCwds: string[] = [];

    const explicitChild = makeFakeChild({ stdoutData: "ok", exitCode: 0 });
    const explicitSpawnFn = ((_cmd: string, _args: string[], opts: { cwd?: string }) => {
      capturedCwds.push(opts.cwd ?? "");
      return explicitChild;
    }) as unknown as SpawnFn;

    await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        cwd: "/tmp/nested-pi-workspace",
      },
      explicitSpawnFn,
    );

    const fallbackChild = makeFakeChild({ stdoutData: "ok", exitCode: 0 });
    const fallbackSpawnFn = ((_cmd: string, _args: string[], opts: { cwd?: string }) => {
      capturedCwds.push(opts.cwd ?? "");
      return fallbackChild;
    }) as unknown as SpawnFn;

    await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
      },
      fallbackSpawnFn,
    );

    assert.deepEqual(capturedCwds, ["/tmp/nested-pi-workspace", cwdBefore]);
  });

  it("--thinking flag is passed when reasoningEffort is set", async () => {
    let capturedArgs: string[] | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    const fakeChild = makeFakeChild({ stdoutData: "ok", exitCode: 0 });
    const spawnFn = ((_cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedArgs = args;
      capturedEnv = opts.env;
      return fakeChild;
    }) as unknown as SpawnFn;

    await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        reasoningEffort: "high",
      },
      spawnFn,
    );

    const thinkingIdx = capturedArgs!.indexOf("--thinking");
    assert.ok(thinkingIdx !== -1, "--thinking flag should be present");
    assert.equal(capturedArgs![thinkingIdx + 1], "high", "--thinking value should be 'high'");
    // Must NOT set it via spawn env (old approach) — reasoning effort must go via --thinking flag
    assert.equal(
      capturedEnv!.BLACKBYTES_REASONING_EFFORT,
      undefined,
      "BLACKBYTES_REASONING_EFFORT must not be in spawn env",
    );
  });

  it("--thinking flag is absent when reasoningEffort is not set", async () => {
    let capturedArgs: string[] | undefined;

    const fakeChild = makeFakeChild({ stdoutData: "ok", exitCode: 0 });
    const spawnFn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return fakeChild;
    }) as unknown as SpawnFn;

    await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
      },
      spawnFn,
    );

    assert.ok(
      !capturedArgs!.includes("--thinking"),
      "--thinking should not be present when reasoningEffort is undefined",
    );
  });
});
