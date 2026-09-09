import type * as AI from "@earendil-works/pi-ai";
import type * as SDK from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../shared/redact.js";
import {
  type ChildEvent,
  type ChildTerminal,
  type LaunchEnvelope,
  chunkChildDelta,
  encodeChildEvent,
} from "./sdk-child-protocol.js";
import { ChildFailure, assertAvailable, installStreamGate, sameTuple } from "./sdk-stream-gate.js";

export type SdkBinding = typeof SDK;
export type AiBinding = Pick<typeof AI, "createAssistantMessageEventStream">;
export interface ChildSink {
  write(frame: Buffer): void;
  flush(): Promise<void>;
}
const metadata = (text: string) => redactSecrets(text).slice(0, 256) || "unknown";

/** SDK event normalization; raw agent_end never grants success. No args/results or queues escape. */
export function normalizeSdkEvent(
  event: SDK.AgentSessionEvent,
  emit: (event: ChildEvent) => void,
  delta: (channel: "text" | "thinking", text: string) => void,
): void {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "message_end":
      emit({ version: 1, type: "progress", event: event.type });
      if (event.type === "message_end" && event.message.role === "assistant") {
        const m = event.message;
        emit({
          version: 1,
          type: "model",
          model: { provider: metadata(m.provider), id: metadata(m.model) },
        });
        emit({
          version: 1,
          type: "usage",
          input: m.usage.input,
          output: m.usage.output,
          total: m.usage.totalTokens,
          cost: m.usage.cost.total,
        });
      }
      break;
    case "message_update": {
      const update = event.assistantMessageEvent;
      // Completed blocks permit redaction across provider delta boundaries, not secret fragments.
      if (update.type === "text_end") delta("text", redactSecrets(update.content));
      if (update.type === "thinking_end") delta("thinking", redactSecrets(update.content));
      if (update.type === "toolcall_end")
        emit({
          version: 1,
          type: "tool",
          phase: "call",
          name: metadata(update.toolCall.name),
          callId: metadata(update.toolCall.id),
        });
      break;
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      emit({
        version: 1,
        type: "tool",
        phase:
          event.type === "tool_execution_start"
            ? "start"
            : event.type === "tool_execution_update"
              ? "update"
              : "end",
        name: metadata(event.toolName),
        callId: metadata(event.toolCallId),
        ...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
      });
      break;
  }
}

/** Unadopted injectable provider. Only the child entry supplies real public SDK bindings.
 * Await operations instead of abandoning late factories: authority is checked after each await;
 * a stalled operation is bounded by the parent's process-group termination/drain.
 */
export async function runSdkChildProvider(
  envelope: LaunchEnvelope,
  sdk: SdkBinding,
  ai: AiBinding,
  sink: ChildSink,
  signal: AbortSignal,
  deadline: number,
): Promise<ChildTerminal> {
  let runtime: SDK.AgentSessionRuntime | undefined;
  let session: SDK.AgentSession | undefined;
  let gate: ReturnType<typeof installStreamGate> | undefined;
  let unsubscribe: (() => void) | undefined;
  let failure: ChildFailure | undefined;
  let runsIdle = false;
  let runtimeDisposed = false;
  const authority = () => {
    if (signal.aborted) throw new ChildFailure("cancelled");
    if (Date.now() >= deadline) throw new ChildFailure("timed_out");
  };
  const recordFailure = (error: unknown, fallback: "setup" | "runtime") => {
    // A swallowed/rejected SDK operation cannot outlive launch authority. Keep the
    // first gate refusal authoritative, including through abort/disposal failures.
    let classified = error instanceof ChildFailure ? error : new ChildFailure(fallback);
    try {
      authority();
    } catch (expired) {
      classified = expired as ChildFailure;
    }
    failure = gate?.failure ?? failure ?? classified;
  };
  const emit = (event: ChildEvent) => sink.write(encodeChildEvent(event));
  const abort = () => {
    gate?.refuse("cancelled");
    void session?.abort().catch(() => {
      recordFailure(undefined, "runtime");
    });
  };
  signal.addEventListener("abort", abort);
  try {
    authority();
    if (sdk.VERSION !== envelope.expectedSdkVersion) throw new ChildFailure("version_mismatch");
    for (const name of [
      "createAgentSessionServices",
      "createAgentSessionFromServices",
      "createAgentSessionRuntime",
    ] as const) {
      if (typeof sdk[name] !== "function") throw new ChildFailure("capability_missing");
    }
    if (
      typeof sdk.SettingsManager?.create !== "function" ||
      typeof sdk.SessionManager?.inMemory !== "function" ||
      typeof ai.createAssistantMessageEventStream !== "function"
    )
      throw new ChildFailure("capability_missing");
    emit({ version: 1, type: "status", stage: "version" });
    const settingsManager = sdk.SettingsManager.create(envelope.cwd, envelope.agentDir, {
      projectTrusted: envelope.projectTrusted,
    });
    const services = await sdk.createAgentSessionServices({
      cwd: envelope.cwd,
      agentDir: envelope.agentDir,
      settingsManager,
      resourceLoaderOptions: {
        noContextFiles: true,
        systemPromptOverride: () => envelope.systemPrompt,
      },
    });
    authority();
    const admitted = services.modelRuntime.getModel(envelope.model.provider, envelope.model.id);
    if (!admitted || !sameTuple(admitted, envelope.model))
      throw new ChildFailure("model_unavailable");
    assertAvailable(services.modelRuntime, envelope.model);
    let created = false;
    runtime = await sdk.createAgentSessionRuntime(
      async ({ sessionManager, sessionStartEvent }) => {
        if (created) {
          gate?.refuse("replacement_refused");
          throw new ChildFailure("replacement_refused");
        }
        created = true;
        authority();
        const result = await sdk.createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: admitted,
          tools: [...envelope.allowedTools],
          ...(envelope.requestedThinking === undefined
            ? {}
            : { thinkingLevel: envelope.requestedThinking }),
        });
        session = result.session;
        return { ...result, services, diagnostics: services.diagnostics };
      },
      {
        cwd: envelope.cwd,
        agentDir: envelope.agentDir,
        sessionManager: sdk.SessionManager.inMemory(envelope.cwd),
      },
    );
    // Own runtime disposal before installing callbacks that can throw. The SDK factory
    // does not bind extensions; the gate is still CLOSED before any startup handler.
    if (!session) throw new ChildFailure("capability_missing");
    // Install even when factory completed late: no late unguarded session or lost cleanup owner.
    gate = installStreamGate(
      session,
      services.modelRuntime,
      admitted,
      envelope,
      ai.createAssistantMessageEventStream,
      authority,
    );
    unsubscribe = session.subscribe((event) => {
      try {
        normalizeSdkEvent(event, emit, (channel, text) => {
          for (const frame of chunkChildDelta(channel, text)) sink.write(frame);
        });
      } catch {
        gate?.refuse("protocol_initialization");
      }
    });
    authority();
    const ownedSession = session;
    const refuseReplacement = async () => {
      gate?.refuse("replacement_refused");
      return { cancelled: true };
    };
    emit({ version: 1, type: "session" });
    await session.bindExtensions({
      mode: "json",
      abortHandler: abort,
      shutdownHandler: abort,
      onError: () =>
        emit({ version: 1, type: "status", stage: "warning", code: "resource_warning" }),
      commandContextActions: {
        waitForIdle: () => ownedSession.waitForIdle(),
        newSession: refuseReplacement,
        fork: refuseReplacement,
        navigateTree: refuseReplacement,
        switchSession: refuseReplacement,
        reload: async () => {
          gate?.refuse("replacement_refused");
        },
      },
    });
    await session.waitForIdle();
    authority();
    gate.open();
    if (services.diagnostics.length || services.resourceLoader.getExtensions().errors.length) {
      emit({ version: 1, type: "status", stage: "warning", code: "resource_warning" });
    }
    emit({ version: 1, type: "status", stage: "admitted" });
    const messageBoundary = session.messages.length;
    const priorAssistants = new Set(session.messages.filter((m) => m.role === "assistant"));
    await session.prompt(envelope.userPrompt);
    await session.waitForIdle();
    gate.check();
    const last = session.messages
      .slice(messageBoundary)
      .reverse()
      .find((m) => m.role === "assistant");
    if (
      gate.forwardedCount === 0 ||
      last?.role !== "assistant" ||
      priorAssistants.has(last) ||
      last.stopReason === "error" ||
      last.stopReason === "aborted"
    )
      throw new ChildFailure("runtime");
    if (last?.role === "assistant") {
      const text = last.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      for (const frame of chunkChildDelta("output", text)) sink.write(frame);
    }
  } catch (error) {
    recordFailure(error, "setup");
  } finally {
    gate?.close();
    try {
      if (session) {
        await session.abort();
        await session.waitForIdle();
      }
      runsIdle = true;
    } catch {
      recordFailure(undefined, "runtime");
    }
    try {
      if (runtime) {
        await runtime.dispose();
        runtimeDisposed = true;
      }
    } catch {
      recordFailure(undefined, "runtime");
    }
    try {
      unsubscribe?.();
    } catch {
      recordFailure(undefined, "runtime");
    }
    signal.removeEventListener("abort", abort);
  }
  failure = gate?.failure ?? failure;
  try {
    authority();
  } catch (error) {
    failure ??= error as ChildFailure;
  }
  if (!runtimeDisposed) failure ??= new ChildFailure("setup");
  const terminal: ChildTerminal = failure
    ? {
        version: 1,
        type: "terminal",
        outcome: "failure",
        refusalLatched: !!gate?.failure,
        failureKind: failure.failureKind,
        code: failure.code,
        settlement: { gateClosed: true, runsIdle, runtimeDisposed },
      }
    : {
        version: 1,
        type: "terminal",
        outcome: "success",
        refusalLatched: false,
        settlement: { gateClosed: true, runsIdle: true, runtimeDisposed: true },
      };
  emit(terminal);
  await sink.flush();
  return terminal;
}
