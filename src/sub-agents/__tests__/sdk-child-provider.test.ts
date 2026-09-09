import assert from "node:assert/strict";
import { ChildProcess, type spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type * as AI from "@earendil-works/pi-ai";
import type * as SDK from "@earendil-works/pi-coding-agent";
import { type ChildEvent, ChildEventDecoder, type LaunchEnvelope } from "../sdk-child-protocol.js";
import { type AiBinding, type SdkBinding, runSdkChildProvider } from "../sdk-child-provider.js";
import { launchManagedSdkChild } from "../sdk-launcher.js";

const envelope: LaunchEnvelope = {
  version: 1,
  expectedSdkVersion: "0.83.0",
  model: { provider: "fixture", id: "literal/slash:high" },
  cwd: "/tmp/checkout",
  agentDir: "/tmp/home-a",
  projectTrusted: false,
  allowedTools: ["fixture_read"],
  systemPrompt: "/this/is/text",
  userPrompt: "synthetic",
  remainingMs: 10000,
};
function fixture(
  options: {
    startupRun?: boolean;
    noHistory?: boolean;
    promptMode?: "command" | "input" | "fabricated" | "no-new" | "reuse" | "error" | "aborted";
    hook?: (stage: string) => void;
    replaceRequest?: boolean;
    reload?: boolean;
    shutdownThrow?: boolean;
    models?: AI.Model<AI.Api>[];
    authProviders?: string[];
    intent?: LaunchEnvelope["model"];
  } = {},
) {
  const stages: string[] = [];
  const events: ChildEvent[] = [];
  const decoder = new ChildEventDecoder();
  const intended = options.intent ?? envelope.model;
  const model: AI.Model<AI.Api> = options.models?.find(
    (m) => m.provider === intended.provider && m.id === intended.id,
  ) ?? {
    provider: "fixture",
    id: "literal/slash:high",
    name: "fixture",
    api: "openai-completions",
    baseUrl: "https://invalid.example",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  const models = options.models ?? [model];
  const auth = options.authProviders ?? [model.provider];
  let lookups = 0;
  let calls = 0;
  let settingsOptions: unknown;
  let serviceOptions: SDK.CreateAgentSessionServicesOptions | undefined;
  let sessionOptions: SDK.CreateAgentSessionFromServicesOptions | undefined;
  const message: AI.AssistantMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "selected " },
      { type: "text", text: "output 🦊" },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const createStream = () => {
    let result: AI.AssistantMessage = message;
    const values: AI.AssistantMessageEvent[] = [];
    return {
      push: (event: AI.AssistantMessageEvent) => values.push(event),
      end: (m?: AI.AssistantMessage) => {
        if (m) result = m;
      },
      result: async () => result,
      async *[Symbol.asyncIterator]() {
        yield* values;
      },
    } as unknown as AI.AssistantMessageEventStream;
  };
  const services = {
    cwd: envelope.cwd,
    agentDir: envelope.agentDir,
    diagnostics: [],
    resourceLoader: { getExtensions: () => ({ errors: [] }) },
    modelRuntime: {
      getModel: (provider: string, id: string) => {
        lookups++;
        return models.find((m) => m.provider === provider && m.id === id);
      },
      getModels: () => models.map((m) => ({ ...m })),
      getAvailableSnapshot: () =>
        models.filter((m) => auth.includes(m.provider)).map((m) => ({ ...m })),
      hasConfiguredAuth: (provider: string) => auth.includes(provider),
      getAuth: () => {
        throw new Error("forbidden admission auth probe");
      },
      checkAuth: () => {
        throw new Error("forbidden admission auth probe");
      },
      refresh: () => {
        throw new Error("forbidden admission refresh");
      },
    },
  } as unknown as SDK.AgentSessionServices;
  let listener: ((event: SDK.AgentSessionEvent) => void) | undefined;
  let idleCount = 0;
  const session = {
    model,
    messages: options.noHistory ? [] : [message],
    agent: {
      streamFunction: ((request) => {
        assert.equal(request, model);
        calls++;
        return createStream();
      }) as SDK.AgentSession["agent"]["streamFunction"],
    },
    getActiveToolNames: () => [...envelope.allowedTools],
    subscribe: (fn: typeof listener) => {
      stages.push("subscribe");
      listener = fn;
      return () => {
        stages.push("unsubscribe");
      };
    },
    bindExtensions: async (bindings: Parameters<SDK.AgentSession["bindExtensions"]>[0]) => {
      stages.push("bind");
      if (options.startupRun) {
        const stream = await session.agent.streamFunction(model, { messages: [] });
        assert.equal((await stream.result()).stopReason, "error");
      }
      if (options.reload) await bindings.commandContextActions?.reload();
      options.hook?.("bind");
    },
    prompt: async () => {
      stages.push("prompt");
      options.hook?.("prompt");
      if (options.promptMode === "command" || options.promptMode === "input") return;
      if (options.promptMode !== "fabricated") {
        await session.agent.streamFunction(options.replaceRequest ? { ...model } : model, {
          messages: [],
        });
      }
      if (options.promptMode !== "no-new") {
        session.messages.push(
          options.promptMode === "reuse"
            ? message
            : {
                ...message,
                stopReason:
                  options.promptMode === "error" || options.promptMode === "aborted"
                    ? options.promptMode
                    : "stop",
              },
        );
      }
      listener?.({ type: "message_end", message });
      listener?.({ type: "agent_end", messages: [message], willRetry: false });
    },
    waitForIdle: async () => {
      stages.push("idle");
      options.hook?.(["startup_idle", "prompt_idle", "cleanup_idle"][idleCount++] ?? "idle");
    },
    abort: async () => {
      stages.push("abort");
      options.hook?.("abort");
    },
  };
  const sdk = {
    VERSION: "0.83.0",
    SettingsManager: {
      create: (_cwd: string, _home: string, opts: unknown) => {
        settingsOptions = opts;
        return {};
      },
    },
    SessionManager: {
      inMemory: (cwd: string) => {
        assert.equal(cwd, envelope.cwd);
        return {};
      },
    },
    createAgentSessionServices: async (opts: SDK.CreateAgentSessionServicesOptions) => {
      serviceOptions = opts;
      stages.push("services");
      options.hook?.("services");
      return services;
    },
    createAgentSessionFromServices: async (opts: SDK.CreateAgentSessionFromServicesOptions) => {
      sessionOptions = opts;
      assert.equal(opts.model, model);
      stages.push("session");
      options.hook?.("session");
      return { session };
    },
    createAgentSessionRuntime: async (
      factory: SDK.CreateAgentSessionRuntimeFactory,
      target: Parameters<SdkBinding["createAgentSessionRuntime"]>[1],
    ) => {
      const result = await factory(target);
      return {
        ...result,
        dispose: async () => {
          stages.push("shutdown");
          options.hook?.("disposal");
          if (options.shutdownThrow) throw new Error("private canary");
        },
      };
    },
  } as unknown as SdkBinding;
  const ai: AiBinding = { createAssistantMessageEventStream: createStream };
  const sink = {
    write(frame: Buffer) {
      decoder.push(frame, (event) => {
        events.push(event);
        if (event.type === "terminal") stages.push("terminal");
      });
    },
    async flush() {
      decoder.finish();
      stages.push("flush");
    },
  };
  return {
    sdk,
    ai,
    sink,
    events,
    stages,
    calls: () => calls,
    lookups: () => lookups,
    settings: () => settingsOptions,
    service: () => serviceOptions,
    session: () => sessionOptions,
  };
}
describe("managed provider lifecycle (entire SDK injected, not runtime proof)", () => {
  for (const [promptMode, noHistory] of [
    ["command", false],
    ["input", false],
    ["command", true],
    ["input", true],
    ["fabricated", false],
    ["no-new", false],
    ["reuse", false],
    ["error", false],
    ["aborted", false],
  ] as const) {
    it(`${promptMode} (noHistory=${noHistory}): requires a guarded request AND a new successful final assistant`, async () => {
      const f = fixture({ promptMode, noHistory });
      const terminal = await runSdkChildProvider(
        envelope,
        f.sdk,
        f.ai,
        f.sink,
        new AbortController().signal,
        Date.now() + 10000,
      );
      assert.equal(terminal.outcome, "failure");
      if (terminal.outcome === "failure") assert.equal(terminal.code, "runtime");
      assert.equal(f.calls(), ["command", "input", "fabricated"].includes(promptMode) ? 0 : 1);
      assert.equal(f.events.filter((e) => e.type === "delta" && e.channel === "output").length, 0);
      assert.equal(f.events.filter((e) => e.type === "terminal").length, 1);
      assert.equal(terminal.settlement.runtimeDisposed, true);
      assert.ok(f.stages.indexOf("shutdown") < f.stages.indexOf("terminal"));
      // Feed the actual provider receipt through the injected parent, with the
      // nonzero exit the child entry assigns to a failure terminal. No SDK/process launch.
      const child = new ChildProcess();
      const pipe = new PassThrough();
      const stdin = new PassThrough();
      Object.assign(child, {
        stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdio: [stdin, null, null, pipe],
      });
      const result = await launchManagedSdkChild(
        { envelope, deadline: Date.now() + 10000 },
        {
          nestedDepth: () => 0,
          access: async () => {},
          expectedVersion: async () => envelope.expectedSdkVersion,
          entry: "/injected/sdk-child.js",
          spawn: (() => {
            queueMicrotask(() => {
              for (const event of f.events) pipe.write(`${JSON.stringify(event)}\n`);
              pipe.end();
              setImmediate(() => {
                child.emit("exit", 1, null);
                child.emit("close", 1, null);
              });
            });
            return child;
          }) as typeof spawn,
          signalChild: () => {},
        },
      );
      assert.equal(result.success, false);
      assert.equal(result.failureKind, "failed");
      assert.equal(result.settlement?.reaped, true);
    });
  }
  for (const stage of [
    "services",
    "session",
    "bind",
    "startup_idle",
    "prompt",
    "prompt_idle",
    "abort",
    "cleanup_idle",
    "disposal",
  ]) {
    for (const expiry of ["cancelled", "timed_out"] as const) {
      it(`${stage} rejects after ${expiry}: authority wins SDK exception`, async (t) => {
        let now = Date.now();
        const deadline = now + 10000;
        t.mock.method(Date, "now", () => now);
        const controller = new AbortController();
        let triggered = false;
        const f = fixture({
          hook: (current) => {
            if (current !== stage || triggered) return;
            triggered = true;
            if (expiry === "cancelled") controller.abort();
            else now = deadline;
            throw new Error("injected late SDK rejection");
          },
        });
        const terminal = await runSdkChildProvider(
          envelope,
          f.sdk,
          f.ai,
          f.sink,
          controller.signal,
          deadline,
        );
        assert.equal(triggered, true);
        assert.equal(terminal.outcome, "failure");
        if (terminal.outcome === "failure") assert.equal(terminal.failureKind, expiry);
        assert.equal(f.events.filter((e) => e.type === "terminal").length, 1);
        assert.equal(f.stages.at(-1), "flush");
        if (stage === "services" || stage === "session") {
          assert.equal(f.calls(), 0);
          assert.equal(f.stages.includes("bind"), false);
        } else assert.ok(f.stages.includes("shutdown"));
      });
    }
  }
  for (const rejectionStage of ["bind", "disposal"]) {
    for (const expiry of ["cancelled", "timed_out"] as const) {
      it(`first gate refusal survives ${expiry} and rejected ${rejectionStage}`, async (t) => {
        let now = Date.now();
        const deadline = now + 10000;
        t.mock.method(Date, "now", () => now);
        const controller = new AbortController();
        const f = fixture({
          startupRun: true,
          hook: (stage) => {
            if (stage !== rejectionStage) return;
            if (expiry === "cancelled") controller.abort();
            else now = deadline;
            throw new Error("injected rejection after gate refusal");
          },
        });
        const terminal = await runSdkChildProvider(
          envelope,
          f.sdk,
          f.ai,
          f.sink,
          controller.signal,
          deadline,
        );
        assert.equal(terminal.outcome, "failure");
        if (terminal.outcome === "failure") {
          assert.equal(terminal.code, "gate_closed");
          assert.equal(terminal.refusalLatched, true);
        }
        assert.equal(f.calls(), 0);
        assert.equal(terminal.settlement.runtimeDisposed, rejectionStage !== "disposal");
        assert.equal(f.events.filter((e) => e.type === "terminal").length, 1);
      });
    }
  }
  it("rejects version mismatch before ordinary services/resources", async () => {
    const f = fixture();
    const terminal = await runSdkChildProvider(
      { ...envelope, expectedSdkVersion: "0.85.1" },
      f.sdk,
      f.ai,
      f.sink,
      new AbortController().signal,
      Date.now() + 10000,
    );
    assert.equal(terminal.outcome, "failure");
    if (terminal.outcome === "failure") assert.equal(terminal.code, "version_mismatch");
    assert.equal(f.stages.includes("services"), false);
    assert.equal(f.lookups(), 0);
    assert.equal(f.calls(), 0);
  });
  it("passes each separately requested effort unchanged; Pi owns capability/default resolution", async () => {
    for (const requestedThinking of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
      const f = fixture();
      const terminal = await runSdkChildProvider(
        { ...envelope, requestedThinking },
        f.sdk,
        f.ai,
        f.sink,
        new AbortController().signal,
        Date.now() + 10000,
      );
      assert.equal(terminal.outcome, "success");
      assert.equal(f.session()?.thinkingLevel, requestedThinking);
    }
  });
  it("cancellation during services prevents every late session/model factory", async () => {
    const f = fixture();
    const controller = new AbortController();
    const createServices = f.sdk.createAgentSessionServices;
    const sdk = {
      ...f.sdk,
      createAgentSessionServices: async (options: SDK.CreateAgentSessionServicesOptions) => {
        const result = await createServices(options);
        controller.abort();
        return result;
      },
    };
    const terminal = await runSdkChildProvider(
      envelope,
      sdk,
      f.ai,
      f.sink,
      controller.signal,
      Date.now() + 10000,
    );
    assert.equal(terminal.outcome, "failure");
    if (terminal.outcome === "failure") assert.equal(terminal.failureKind, "cancelled");
    assert.equal(f.session(), undefined);
    assert.equal(f.lookups(), 0);
    assert.equal(f.calls(), 0);
  });
  it("passes one admitted object, trust/home/text/no-context and omitted thinking; shutdown precedes terminal", async () => {
    const f = fixture();
    const terminal = await runSdkChildProvider(
      envelope,
      f.sdk,
      f.ai,
      f.sink,
      new AbortController().signal,
      Date.now() + 10000,
    );
    assert.equal(terminal.outcome, "success");
    assert.equal(f.lookups(), 1);
    assert.equal(f.calls(), 1);
    assert.equal(
      f.events
        .filter((event) => event.type === "delta" && event.channel === "output")
        .map((event) => (event.type === "delta" ? event.text : ""))
        .join(""),
      "selected output 🦊",
    );
    assert.deepEqual(f.settings(), { projectTrusted: false });
    assert.equal(f.service()?.agentDir, envelope.agentDir);
    assert.equal(f.service()?.resourceLoaderOptions?.noContextFiles, true);
    assert.equal(
      f.service()?.resourceLoaderOptions?.systemPromptOverride?.("ambient"),
      envelope.systemPrompt,
    );
    assert.equal("thinkingLevel" in (f.session() ?? {}), false);
    assert.deepEqual(f.session()?.tools, envelope.allowedTools);
    assert.ok(f.stages.indexOf("subscribe") < f.stages.indexOf("bind"));
    assert.ok(f.stages.indexOf("shutdown") < f.stages.indexOf("terminal"));
    assert.equal(f.stages.at(-1), "flush");
    assert.equal(f.events.filter((e) => e.type === "usage").length, 1);
  });
  for (const [name, options, code] of [
    ["startup run", { startupRun: true }, "gate_closed"],
    ["same tuple request replacement", { replaceRequest: true }, "model_identity"],
    ["reload action", { reload: true }, "replacement_refused"],
    ["shutdown throws", { shutdownThrow: true }, "runtime"],
  ] as const)
    it(name, async () => {
      const f = fixture(options);
      const terminal = await runSdkChildProvider(
        envelope,
        f.sdk,
        f.ai,
        f.sink,
        new AbortController().signal,
        Date.now() + 10000,
      );
      assert.equal(terminal.outcome, "failure");
      if (terminal.outcome === "failure") assert.equal(terminal.code, code);
      if (!options.shutdownThrow) assert.equal(f.calls(), 0);
      assert.equal(f.events.filter((event) => event.type === "terminal").length, 1);
    });
});

// Attributable re-expression of all 182 original probe rows:
// /tmp/pib-2m0i-investigation.TXzg0F/probe.mjs (18 fixtures x 5 argv forms x 2
// historical source versions, plus 2 scope/default rows). These are INJECTED child
// admission assertions, NOT either installed SDK's runtime/compatibility matrix.
const counterModel = (provider: string, id: string, name = id): AI.Model<AI.Api> => ({
  provider,
  id,
  name,
  api: "openai-completions",
  baseUrl: "https://invalid.example",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1234,
  maxTokens: 99,
});
const parentProvider = "parent-only";
const wantedId = "gpt-exact";
const wanted = counterModel(parentProvider, wantedId);
const raw = counterModel("other", `${parentProvider}/${wantedId}`);
const counterexamples: Array<[string, string, AI.Model<AI.Api>[], string[]]> = [
  ["provider missing", wantedId, [raw], ["other"]],
  ["provider unauthenticated", wantedId, [wanted, raw], ["other"]],
  ["exact present", wantedId, [wanted, raw], [parentProvider, "other"]],
  [
    "missing model fuzzy ID",
    wantedId,
    [counterModel(parentProvider, `${wantedId}-latest`), raw],
    [parentProvider, "other"],
  ],
  [
    "missing model fuzzy name",
    wantedId,
    [counterModel(parentProvider, "unrelated", `Friendly ${wantedId}`), raw],
    [parentProvider, "other"],
  ],
  [
    "missing model no match",
    wantedId,
    [counterModel(parentProvider, "unrelated"), raw],
    [parentProvider, "other"],
  ],
  ["missing model no auth", wantedId, [counterModel(parentProvider, "unrelated"), raw], ["other"]],
  [
    "duplicate bare both auth",
    wantedId,
    [counterModel("other", wantedId), wanted],
    [parentProvider, "other"],
  ],
  [
    "duplicate bare only requested auth",
    wantedId,
    [counterModel("other", wantedId), wanted],
    [parentProvider],
  ],
  ["duplicate bare no auth", wantedId, [counterModel("other", wantedId), wanted], []],
  [
    "literal slash",
    "vendor/model",
    [counterModel(parentProvider, "vendor/model"), counterModel("other", "vendor/model")],
    [parentProvider, "other"],
  ],
  [
    "literal colon",
    "vendor/model:exacto",
    [
      counterModel(parentProvider, "vendor/model:exacto"),
      counterModel(parentProvider, "vendor/model"),
    ],
    [parentProvider],
  ],
  [
    "literal valid colon suffix",
    "vendor/model:high",
    [
      counterModel(parentProvider, "vendor/model:high"),
      counterModel(parentProvider, "vendor/model"),
    ],
    [parentProvider],
  ],
  [
    "missing valid colon literal",
    "vendor/model:high",
    [counterModel(parentProvider, "vendor/model")],
    [parentProvider],
  ],
  [
    "missing invalid colon literal",
    "vendor/model:exacto",
    [counterModel(parentProvider, "vendor/model")],
    [parentProvider],
  ],
  [
    "suffix after literal colon",
    "vendor/model:exacto:high",
    [counterModel(parentProvider, "vendor/model:exacto")],
    [parentProvider],
  ],
  [
    "self-provider slash literal",
    `${parentProvider}/${wantedId}`,
    [wanted, counterModel(parentProvider, `${parentProvider}/${wantedId}`)],
    [parentProvider],
  ],
  [
    "missing suffix no match",
    "absent:high",
    [counterModel(parentProvider, "unrelated")],
    [parentProvider],
  ],
];
describe("182 historical counterexample rows re-expressed at injected child boundary", () => {
  for (const sourceVersion of ["0.83.0", "0.85.1"]) {
    for (const [name, id, models, authProviders] of counterexamples) {
      for (const variant of [
        "canonical only",
        "bare only",
        "provider + canonical",
        "provider + bare",
        "provider + canonical + thinking off",
      ]) {
        it(`${sourceVersion} provenance: ${name}; ${variant}`, async () => {
          const intent = { provider: parentProvider, id };
          const f = fixture({ models, authProviders, intent });
          const requestedThinking = variant.endsWith("thinking off") ? ("off" as const) : undefined;
          const terminal = await runSdkChildProvider(
            {
              ...envelope,
              expectedSdkVersion: sourceVersion,
              model: intent,
              ...(requestedThinking === undefined ? {} : { requestedThinking }),
            },
            { ...f.sdk, VERSION: sourceVersion },
            f.ai,
            f.sink,
            new AbortController().signal,
            Date.now() + 10000,
          );
          const admitted =
            models.some((m) => m.provider === parentProvider && m.id === id) &&
            authProviders.includes(parentProvider);
          assert.equal(terminal.outcome, admitted ? "success" : "failure");
          assert.equal(f.lookups(), 1);
          assert.equal(f.calls(), admitted ? 1 : 0);
          if (admitted) {
            assert.equal(
              f.session()?.model,
              models.find((m) => m.provider === parentProvider && m.id === id),
            );
            assert.equal(f.session()?.thinkingLevel, requestedThinking);
          } else if (terminal.outcome === "failure")
            assert.equal(terminal.failureKind, "provider_or_model_unavailable");
        });
      }
    }
    it(`${sourceVersion} provenance: unmatched scope never selects saved default`, async () => {
      const intent = { provider: parentProvider, id: "absent" };
      const f = fixture({
        models: [counterModel(parentProvider, "unrelated"), counterModel("other", "saved")],
        authProviders: [parentProvider, "other"],
        intent,
      });
      const terminal = await runSdkChildProvider(
        { ...envelope, model: intent, expectedSdkVersion: sourceVersion },
        { ...f.sdk, VERSION: sourceVersion },
        f.ai,
        f.sink,
        new AbortController().signal,
        Date.now() + 10000,
      );
      assert.equal(terminal.outcome, "failure");
      assert.equal(f.calls(), 0);
      assert.equal(f.session(), undefined);
    });
  }
});
