import type { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ChildTerminal, LaunchEnvelope } from "./sdk-child-protocol.js";

type Failure = Extract<ChildTerminal, { outcome: "failure" }>;
export type ChildFailureCode = Exclude<Failure["code"], "resource_warning">;
export class ChildFailure extends Error {
  constructor(readonly code: ChildFailureCode) {
    super(code);
  }
  get failureKind(): Failure["failureKind"] {
    if (this.code === "tool_mismatch") return "invalid_tool_allowlist";
    if (this.code === "model_identity" || this.code === "model_unavailable") {
      return "provider_or_model_unavailable";
    }
    if (this.code === "cancelled" || this.code === "timed_out" || this.code === "killed") {
      return this.code;
    }
    return "failed";
  }
}
type Model = NonNullable<AgentSession["model"]>;
type Stream = AgentSession["agent"]["streamFunction"];
type Catalogue = Pick<ModelRuntime, "getModels" | "getAvailableSnapshot" | "hasConfiguredAuth">;
export function sameTuple(
  model: { provider: string; id: string } | undefined,
  tuple: LaunchEnvelope["model"],
): boolean {
  return model?.provider === tuple.provider && model.id === tuple.id;
}
export function assertAvailable(catalogue: Catalogue, tuple: LaunchEnvelope["model"]): void {
  if (
    !catalogue.getModels().some((m) => sameTuple(m, tuple)) ||
    !catalogue.getAvailableSnapshot().some((m) => sameTuple(m, tuple)) ||
    !catalogue.hasConfiguredAuth(tuple.provider)
  )
    throw new ChildFailure("model_unavailable");
}

/** Captures one admitted object. Public catalogues may legitimately recompose fresh objects.
 * No auth refresh/probe, registry identity, repair, endpoint attestation or wrapper-bypass claim.
 */
export function installStreamGate(
  session: Pick<AgentSession, "model" | "getActiveToolNames"> & {
    agent: Pick<AgentSession["agent"], "streamFunction">;
  },
  catalogue: Catalogue,
  admitted: Model,
  intent: Pick<LaunchEnvelope, "model" | "allowedTools">,
  createErrorStream: typeof createAssistantMessageEventStream,
  assertAuthority: () => void,
) {
  const tuple = Object.freeze({ ...intent.model });
  const tools = new Set(intent.allowedTools);
  const original = session.agent.streamFunction;
  const errorApi = admitted.api;
  let open = false;
  let forwardedCount = 0;
  let failure: ChildFailure | undefined;
  const refuse = (code: ChildFailureCode) => {
    failure ??= new ChildFailure(code);
    open = false;
    return failure;
  };
  const check = (request?: Model) => {
    if (failure) throw failure;
    assertAuthority();
    if (session.agent.streamFunction !== wrapper) throw new ChildFailure("wrapper_ownership");
    if (
      session.model !== admitted ||
      !sameTuple(admitted, tuple) ||
      (request !== undefined && (request !== admitted || !sameTuple(request, tuple)))
    ) {
      throw new ChildFailure("model_identity");
    }
    assertAvailable(catalogue, tuple);
    const active = session.getActiveToolNames();
    if (
      !tools.size ||
      active.length !== tools.size ||
      new Set(active).size !== tools.size ||
      active.some((name) => !tools.has(name) || name.startsWith("delegate_"))
    ) {
      throw new ChildFailure("tool_mismatch");
    }
  };
  const wrapper: Stream = (...args) => {
    try {
      if (args[0] !== admitted) throw new ChildFailure("model_identity");
      check(args[0]);
      if (!open) throw new ChildFailure("gate_closed");
    } catch (error) {
      refuse(error instanceof ChildFailure ? error.code : "runtime");
      // Refusal is a completed public error stream, not a hook throw that Pi may swallow.
      const stream = createErrorStream();
      const message: Parameters<typeof stream.end>[0] = {
        role: "assistant",
        content: [],
        api: errorApi,
        provider: tuple.provider,
        model: tuple.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "Managed child request refused",
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
      return stream;
    }
    forwardedCount++;
    return original.apply(session.agent, args);
  };
  session.agent.streamFunction = wrapper;
  return {
    get forwardedCount() {
      return forwardedCount;
    },
    get failure() {
      return failure;
    },
    refuse,
    close() {
      open = false;
    },
    check() {
      try {
        check();
      } catch (error) {
        throw refuse(error instanceof ChildFailure ? error.code : "runtime");
      }
    },
    open() {
      this.check();
      open = true;
    },
  };
}
