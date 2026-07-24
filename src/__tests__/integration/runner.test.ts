import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SpawnFn } from "../../sub-agents/runner.js";
import { runNestedPi } from "../../sub-agents/runner.js";

// ---------------------------------------------------------------------------
// Helper: create a fake ChildProcess-like object
// ---------------------------------------------------------------------------

function makeFakeChild(options: {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number | null;
  delay?: number;
  neverCloses?: boolean;
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
    // Emit close on next tick to simulate OS behaviour
    process.nextTick(() => child.emit("close", null));
  };

  if (!options.neverCloses) {
    const delay = options.delay ?? 10;
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

function agentEnd(text: string): string {
  return `${JSON.stringify({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  })}\n`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: runNestedPi runner", () => {
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

  it("success: runNestedPi returns DelegateResult with success=true and stdout output", async () => {
    // Arrange: mock spawn that emits stdout then closes with code 0
    const expectedOutput = "Task completed successfully.\nAll done.";
    const fakeChild = makeFakeChild({ stdoutData: agentEnd(expectedOutput), exitCode: 0 });
    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    // Act
    const result = await runNestedPi(
      {
        systemPrompt: "You are a helpful assistant.",
        userPrompt: "Do something.",
        allowedTools: ["read", "grep"],
      },
      spawnFn,
    );

    // Assert
    assert.equal(result.success, true, "result should indicate success");
    assert.equal(result.content, expectedOutput, "content should match stdout");
  });

  it("timeout: returns failure result with error containing 'timed out'", async () => {
    // Arrange: child that never closes on its own
    const fakeChild = makeFakeChild({ neverCloses: true });
    const spawnFn = (() => fakeChild) as unknown as SpawnFn;

    // Act: very short timeout
    const result = await runNestedPi(
      {
        systemPrompt: "You are a helpful assistant.",
        userPrompt: "Do something slow.",
        allowedTools: [],
        timeoutMs: 50,
      },
      spawnFn,
    );

    // Assert
    assert.equal(result.success, false, "result should indicate failure on timeout");
    assert.match(result.content, /timed out/i, "error content should mention timeout");
    assert.equal(fakeChild.killed, true, "child process should have been killed");
  });

  it("recursion guard: PI_NESTED_DEPTH=1 rejects immediately without spawning", async () => {
    // Arrange: set recursion depth to 1
    process.env.PI_NESTED_DEPTH = "1";

    let spawnCalled = false;
    const spawnFn = (() => {
      spawnCalled = true;
      // Return a dummy child — should never be called
      return makeFakeChild({ exitCode: 0 });
    }) as unknown as SpawnFn;

    // Act
    const result = await runNestedPi(
      {
        systemPrompt: "You are a helpful assistant.",
        userPrompt: "Hello.",
        allowedTools: [],
      },
      spawnFn,
    );

    // Assert
    assert.equal(result.success, false, "should fail due to recursion guard");
    assert.match(result.content, /recursion depth limit/i, "error should mention recursion limit");
    assert.equal(spawnCalled, false, "spawn should NOT have been called");
  });

  it("cancellation: aborting AbortSignal sends SIGTERM to child", async () => {
    // Arrange: child that never closes on its own
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

    // Act: start the runner, abort immediately
    const resultPromise = runNestedPi(
      {
        systemPrompt: "You are a helpful assistant.",
        userPrompt: "Do something.",
        allowedTools: [],
        signal: controller.signal,
        timeoutMs: 30_000,
      },
      spawnFn,
    );

    controller.abort();

    const result = await resultPromise;

    // Assert
    assert.equal(result.success, false, "cancelled run should fail");
    assert.match(
      result.content,
      /cancelled|timed out/i,
      "error should mention cancellation or timeout",
    );
    assert.equal(child.killed, true, "child process should have been killed via SIGTERM");
  });
});
