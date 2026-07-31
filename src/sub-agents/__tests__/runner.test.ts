import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SpawnFn } from "../runner.js";
import { runNestedPi } from "../runner.js";

const PI_CLI_COMPATIBILITY_EVIDENCE = {
  installedCliVersion: "0.83.0",
  inspectedPackageVersion: "@earendil-works/pi-coding-agent@0.83.0",
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
  const originalPiAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    delete process.env.PI_NESTED_DEPTH;
  });

  afterEach(() => {
    if (originalDepth === undefined) {
      delete process.env.PI_NESTED_DEPTH;
    } else {
      process.env.PI_NESTED_DEPTH = originalDepth;
    }
    if (originalPiAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = originalPiAgentDir;
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

  it("zero exit without agent_end returns malformed_jsonl", async () => {
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

    assert.equal(result.success, false);
    assert.equal(result.content, "Nested Pi failed");
    assert.equal(result.failureKind, "malformed_jsonl");
  });

  it("successful JSONL execution returns final assistant text", async () => {
    const agentEndEvent = JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Hello from agent_end" }] }],
    });
    const fakeChild = makeFakeChild({
      stdoutData: `banner line\n${agentEndEvent}\n`,
      exitCode: 0,
    });
    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: ["read"],
      },
      spawnFn,
    );

    assert.equal(result.success, true);
    assert.equal(result.content, "Hello from agent_end");
  });

  it("agent_end without assistant text still satisfies the terminal contract", async () => {
    const agentEndEvent = JSON.stringify({ type: "agent_end", messages: [] });
    const fakeChild = makeFakeChild({ stdoutData: `${agentEndEvent}\n`, exitCode: 0 });
    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: ["read"],
      },
      spawnFn,
    );

    assert.equal(result.success, true);
    assert.equal(result.content, `${agentEndEvent}\n`);
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

  for (const reason of ["timed_out", "cancelled"] as const) {
    it(
      `terminates a nested descendant when ${reason}`,
      { skip: process.platform === "win32" },
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-blackbytes-process-group-"));
        const pidFile = join(dir, "grandchild.pid");
        const grandchildScript = `
          const fs = require("node:fs");
          process.on("SIGTERM", () => {});
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
          setInterval(() => {}, 1000);
        `;
        const parentScript = `
          const { spawn } = require("node:child_process");
          spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
          setInterval(() => {}, 1000);
        `;
        let parentPid: number | undefined;
        let grandchildPid: number | undefined;

        const spawnFn = ((_cmd: string, _args: string[], options: Parameters<SpawnFn>[2]) => {
          const child = nodeSpawn(process.execPath, ["-e", parentScript], options);
          parentPid = child.pid;
          return child;
        }) as SpawnFn;
        const controller = new AbortController();

        try {
          const resultPromise = runNestedPi(
            {
              systemPrompt: "You are helpful",
              userPrompt: "Hello",
              allowedTools: [],
              signal: controller.signal,
              timeoutMs: reason === "timed_out" ? 500 : 30_000,
              killGraceMs: 50,
            },
            spawnFn,
          );

          for (let i = 0; i < 100; i++) {
            try {
              grandchildPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          assert.ok(grandchildPid, "grandchild fixture should report its pid");
          if (reason === "cancelled") controller.abort();

          const result = await resultPromise;
          assert.equal(result.failureKind, reason);

          let alive = true;
          for (let i = 0; i < 100; i++) {
            try {
              process.kill(grandchildPid, 0);
              await new Promise((resolve) => setTimeout(resolve, 10));
            } catch {
              alive = false;
              break;
            }
          }
          assert.equal(alive, false, "grandchild must not survive termination");
        } finally {
          for (const pid of [grandchildPid, parentPid]) {
            if (!pid) continue;
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
  }

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
    assert.equal(PI_CLI_COMPATIBILITY_EVIDENCE.installedCliVersion, "0.83.0");
    assert.equal(
      PI_CLI_COMPATIBILITY_EVIDENCE.inspectedPackageVersion,
      "@earendil-works/pi-coding-agent@0.83.0",
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

  it("malformed JSONL lines with non-zero exit classifies as malformed_jsonl", async () => {
    // Emit lines that look like JSON (start with {) but are invalid JSON.
    // No agent_end event captured. Exits non-zero.
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (signal?: string) => void;
      killed: boolean;
      stdin: null;
    };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.stdin = null;
    fakeChild.killed = false;
    fakeChild.kill = () => {
      fakeChild.killed = true;
    };

    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    const resultPromise = runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        timeoutMs: 30_000,
      },
      spawnFn,
    );

    // Emit malformed JSONL lines (start with { but not valid JSON)
    process.nextTick(() => {
      fakeChild.stdout.emit("data", Buffer.from('{"type": incomplete\n'));
      fakeChild.stdout.emit("data", Buffer.from('{"bad": "json", missing\n'));
      fakeChild.stderr.emit("data", Buffer.from("Some error\n"));
      fakeChild.emit("close", 1);
    });

    const result = await resultPromise;

    assert.equal(result.success, false);
    assert.equal(result.content, "Nested Pi failed");
    assert.equal(result.failureKind, "malformed_jsonl");
    assert.equal(result.details, "Some error\n");
  });

  it("malformed JSONL does not override specific stderr classifications", async () => {
    const stdoutData = '{"type": incomplete\n';
    const fakeChild = makeFakeChild({
      stdoutData,
      stderrData: "model not found",
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
    assert.equal(result.failureKind, "provider_or_model_unavailable");
  });

  it("killed by external signal returns killed failure", async () => {
    // Child emits close with a signal but no terminationRequested
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
    };

    const spawnFn = (() => child) as unknown as SpawnFn;

    const resultPromise = runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        timeoutMs: 30_000,
      },
      spawnFn,
    );

    // Emit close with exitCode=null and signal=SIGTERM (external kill)
    process.nextTick(() => {
      child.emit("close", null, "SIGTERM");
    });

    const result = await resultPromise;

    assert.equal(result.success, false);
    assert.equal(result.content, "Nested Pi killed");
    assert.equal(result.failureKind, "killed");
  });

  it("killed not triggered when termination was self-requested (cancellation wins)", async () => {
    // When we request termination, the terminationReason check fires first,
    // even if close emits with a non-null signal.
    const signals: string[] = [];
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
    child.kill = (signal?: string) => {
      child.killed = true;
      signals.push(signal ?? "");
      // Emit close with the signal (realistic: SIGTERM triggers close with signal)
      process.nextTick(() => child.emit("close", null, signal ?? "SIGTERM"));
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
    controller.abort();

    const result = await resultPromise;

    assert.equal(result.success, false);
    assert.equal(result.failureKind, "cancelled");
    assert.equal(result.content, "Nested Pi cancelled");
    assert.ok(signals.includes("SIGTERM"), "SIGTERM must have been sent");
  });

  it("captures an artifact for over-cap successful output when enabled", async () => {
    process.env.PI_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-blackbytes-runner-artifacts-"));
    const largeOutput = `${"x".repeat(30_000)}\nAPI_KEY=supersecret123`;
    const agentEndEvent = JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: largeOutput }] }],
    });
    const fakeChild = makeFakeChild({ stdoutData: `${agentEndEvent}\n`, exitCode: 0 });
    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        model: "test-model",
        captureArtifacts: true,
        artifactAgent: "explore",
      },
      spawnFn,
    );

    assert.equal(result.success, true);
    assert.ok(result.artifactPath);
    assert.ok(result.content.length <= 24_576);
    const artifact = await readFile(result.artifactPath, "utf8");
    assert.ok(artifact.includes('agent: "explore"'));
    assert.ok(artifact.includes('model: "test-model"'));
    assert.ok(artifact.includes("API_KEY=[REDACTED]"));
    assert.ok(!artifact.includes("supersecret123"));
  });

  it("does not capture artifacts for under-cap successful output", async () => {
    process.env.PI_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-blackbytes-runner-artifacts-"));
    const agentEndEvent = JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "short output" }] }],
    });
    const fakeChild = makeFakeChild({ stdoutData: `${agentEndEvent}\n`, exitCode: 0 });
    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    const result = await runNestedPi(
      {
        systemPrompt: "You are helpful",
        userPrompt: "Hello",
        allowedTools: [],
        captureArtifacts: true,
        artifactAgent: "explore",
      },
      spawnFn,
    );

    assert.equal(result.success, true);
    assert.equal(result.content, "short output");
    assert.equal(result.artifactPath, undefined);
  });

  it("continues successfully when artifact capture fails", async () => {
    process.env.PI_AGENT_DIR = "/dev/null";
    const originalConsoleError = console.error;
    const errors: string[] = [];
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };

    try {
      const largeOutput = "x".repeat(30_000);
      const agentEndEvent = JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: largeOutput }] }],
      });
      const fakeChild = makeFakeChild({ stdoutData: `${agentEndEvent}\n`, exitCode: 0 });
      const spawnFn = (() => fakeChild) as unknown as SpawnFn;

      const result = await runNestedPi(
        {
          systemPrompt: "You are helpful",
          userPrompt: "Hello",
          allowedTools: [],
          captureArtifacts: true,
          artifactAgent: "explore",
        },
        spawnFn,
      );

      assert.equal(result.success, true);
      assert.equal(result.artifactPath, undefined);
      assert.ok(result.content.length <= 24_576);
      assert.ok(errors.some((message) => message.includes("artifact capture failed")));
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("malformed_jsonl flag does not fire when agent_end captured successfully", async () => {
    // Valid JSONL with an agent_end event, followed by non-zero exit.
    // Since finalAssistantText is populated, malformed_jsonl should NOT fire.
    const agentEndEvent = JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Hello from assistant" }] }],
    });
    const stdoutData = `${agentEndEvent}\n{"type": "session"}\n`;
    const fakeChild = makeFakeChild({
      stdoutData,
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
    assert.equal(result.failureKind, "failed"); // NOT malformed_jsonl
  });
});
