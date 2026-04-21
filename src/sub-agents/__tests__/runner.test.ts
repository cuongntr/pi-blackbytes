import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SpawnFn } from "../runner.js";
import { runNestedPi } from "../runner.js";

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
