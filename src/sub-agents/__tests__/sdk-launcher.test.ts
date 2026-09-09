import assert from "node:assert/strict";
import { ChildProcess, type spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { type ChildEvent, type LaunchEnvelope, encodeChildEvent } from "../sdk-child-protocol.js";
import {
  type LauncherDependencies,
  launchManagedSdkChild,
  sdkChildEnvironment,
} from "../sdk-launcher.js";

const envelope: LaunchEnvelope = {
  version: 1,
  expectedSdkVersion: "0.83.0",
  model: { provider: "fixture", id: "literal/slash:high" },
  cwd: "/tmp",
  agentDir: "/tmp/fixture-home",
  projectTrusted: false,
  allowedTools: ["fixture_read"],
  systemPrompt: "/not/a/prompt/file",
  userPrompt: "synthetic",
  remainingMs: 10000,
};
const success: ChildEvent = {
  version: 1,
  type: "terminal",
  outcome: "success",
  refusalLatched: false,
  settlement: { gateClosed: true, runsIdle: true, runtimeDisposed: true },
};
function fixture(run: (child: ChildProcess, pipe: PassThrough) => void) {
  const signals: string[] = [];
  let spawned = 0;
  const child = new ChildProcess();
  const pipe = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [stdin, null, null, pipe],
  });
  const deps: LauncherDependencies = {
    nestedDepth: () => 0,
    access: async () => {},
    expectedVersion: async () => "0.83.0",
    entry: "/installed/dist/sdk-child.js",
    spawn: ((exe, args, opts) => {
      spawned++;
      assert.equal(exe, process.execPath);
      assert.deepEqual(args?.slice(0, 2), ["--experimental-import-meta-resolve", deps.entry]);
      assert.equal(opts?.shell, false);
      queueMicrotask(() => run(child, pipe));
      return child;
    }) as typeof spawn,
    signalChild: (_child, signal) => {
      signals.push(signal);
    },
  };
  return { deps, child, pipe, signals, spawned: () => spawned };
}
function settle(child: ChildProcess, pipe: PassThrough, events: ChildEvent[], code = 0) {
  for (const event of events) {
    const bytes = encodeChildEvent(event);
    for (let i = 0; i < bytes.length; i += 7) pipe.write(bytes.subarray(i, i + 7));
  }
  pipe.end();
  setImmediate(() => {
    child.emit("exit", code, null);
    child.emit("close", code, null);
  });
}
describe("managed parent process adapter (injected child, no process/SDK launch)", () => {
  it("filters environment, equal home aliases and version-specific markers", () => {
    const env = sdkChildEnvironment("/tmp/home", "0.83.0", {
      PATH: "/bin",
      HOME: "/tmp/os-home",
      NODE_OPTIONS: "canary",
      HTTPS_PROXY: "canary",
      PRIVATE_API_KEY: "synthetic",
    });
    assert.deepEqual(
      Object.keys(env).sort(),
      [
        "HOME",
        "PATH",
        "PI_AGENT_DIR",
        "PI_CODING_AGENT",
        "PI_CODING_AGENT_DIR",
        "PI_NESTED_DEPTH",
      ].sort(),
    );
    assert.equal(env.PI_AGENT_DIR, env.PI_CODING_AGENT_DIR);
    assert.equal(sdkChildEnvironment("/tmp/home", "0.85.1", {}).AI_AGENT, "pi");
  });
  it("requires terminal, EOF, zero exit and observed close; preserves successful text", async () => {
    const text = "sensitive synthetic output 🦊";
    const f = fixture((child, pipe) =>
      settle(child, pipe, [{ version: 1, type: "delta", channel: "output", text }, success]),
    );
    const result = await launchManagedSdkChild({ envelope, deadline: Date.now() + 10000 }, f.deps);
    assert.equal(result.success, true);
    assert.equal(result.content, text);
    assert.equal(result.settlement?.reaped, true);
  });
  for (const [name, events, code, kind] of [
    ["raw agent_end", [{ version: 1, type: "progress", event: "agent_end" }], 0, "malformed_jsonl"],
    ["missing terminal", [], 0, "malformed_jsonl"],
    ["duplicate terminal", [success, success], 0, "malformed_jsonl"],
    ["nonzero exit", [success], 1, "failed"],
  ] as const) {
    it(name, async () => {
      const f = fixture((child, pipe) => settle(child, pipe, [...events], code));
      const result = await launchManagedSdkChild(
        { envelope, deadline: Date.now() + 10000 },
        f.deps,
      );
      assert.equal(result.success, false);
      assert.equal(result.failureKind, kind);
    });
  }
  it("refuses late close even before the deadline timer gets an event-loop turn", async (t) => {
    let now = Date.now();
    const deadline = now + 10000;
    t.mock.method(Date, "now", () => now);
    const f = fixture((child, pipe) => {
      pipe.end(encodeChildEvent(success));
      setImmediate(() => {
        now = deadline;
        child.emit("close", 0, null);
      });
    });
    const result = await launchManagedSdkChild({ envelope, deadline }, f.deps);
    assert.equal(result.success, false);
    assert.equal(result.failureKind, "timed_out");
    assert.equal(result.settlement?.reaped, true);
  });
  it("stdout/stderr noise is never protocol or returned diagnostics", async () => {
    const f = fixture((child, pipe) => {
      child.stdout?.emit("data", "PRIVATE_CANARY");
      child.stderr?.emit("data", "PRIVATE_CANARY");
      settle(child, pipe, [success]);
    });
    const result = await launchManagedSdkChild({ envelope, deadline: Date.now() + 10000 }, f.deps);
    assert.equal(result.success, true);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_CANARY"));
  });
  it("cancellation during peer preflight revokes late spawn authority", async () => {
    const controller = new AbortController();
    const f = fixture(() => {
      assert.fail("must not spawn");
    });
    f.deps.expectedVersion = async () => {
      controller.abort();
      return "0.83.0";
    };
    const result = await launchManagedSdkChild(
      { envelope, deadline: Date.now() + 10000, signal: controller.signal },
      f.deps,
    );
    assert.equal(result.failureKind, "cancelled");
    assert.equal(f.spawned(), 0);
  });
  it("TERM, 100ms KILL, 5000ms drain are not reaping; late close cannot rewrite evidence", async () => {
    const controller = new AbortController();
    const f = fixture(() => controller.abort());
    const result = await launchManagedSdkChild(
      { envelope, deadline: Date.now() + 10000, signal: controller.signal },
      f.deps,
    );
    assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(result.settlement, {
      reaped: false,
      childCloseObserved: false,
      reason: "cancelled",
      writerRetired: true,
    });
    f.child.emit("close", null, "SIGKILL");
    assert.equal(result.settlement?.reaped, false);
    assert.equal(result.failureKind, "cancelled");
    f.pipe.end();
  });
});
