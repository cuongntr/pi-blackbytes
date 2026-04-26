import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getEnabledSet } from "../config/enabled-set.js";
import { getLogger } from "../shared/logger.js";
import type { SubAgentDeclaration } from "./declaration.js";
import { finalizeNestedTools } from "./delegable-tools.js";
import { type FallbackResult, executeWithFallback, formatAttempts } from "./fallback.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { buildSubAgentRenderResult } from "./render.js";
import { type SpawnFn, formatDelegateFailure, redactDelegateText, runNestedPi } from "./runner.js";
import { getAgentSnapshotFor } from "./snapshot.js";
import type { PiSessionEvent } from "./types.js";

type SubAgentProgressStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

interface SubAgentProgressUsage {
  readonly input?: number;
  readonly output?: number;
  readonly total?: number;
  readonly cost?: number;
}

interface SubAgentProgressDetails {
  readonly agent: string;
  readonly status: SubAgentProgressStatus;
  readonly model?: string;
  readonly cwd?: string;
  readonly allowedTools: readonly string[];
  readonly elapsedMs: number;
  readonly outputChars: number;
  readonly outputPreview?: string;
  readonly attemptedModels?: readonly string[];
  readonly currentTool?: string;
  readonly usage?: SubAgentProgressUsage;
}

type AgentToolUpdate = (update: {
  content: Array<{ type: "text"; text: string }>;
  details: SubAgentProgressDetails;
}) => void;

const MAX_PROGRESS_PREVIEW_CHARS = 8_192;
const TRUNCATION_MARKER = "\n[... truncated ...]\n";

function isAgentToolUpdate(value: unknown): value is AgentToolUpdate {
  return typeof value === "function";
}

function appendBoundedRaw(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= MAX_PROGRESS_PREVIEW_CHARS) return combined;

  const keepChars = MAX_PROGRESS_PREVIEW_CHARS - TRUNCATION_MARKER.length;
  const headChars = Math.floor(keepChars / 2);
  const tailChars = keepChars - headChars;
  return combined.slice(0, headChars) + TRUNCATION_MARKER + combined.slice(-tailChars);
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatProgressSummary(details: SubAgentProgressDetails): string {
  const status = details.status;
  const captured =
    details.outputChars > 0
      ? `, ${details.outputChars.toLocaleString("en-US")} chars captured`
      : "";
  return `Sub-agent ${details.agent} ${status} (${formatElapsed(details.elapsedMs)}${captured})`;
}

function createProgressReporter(opts: {
  readonly agent: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly allowedTools: readonly string[];
  readonly onUpdate?: unknown;
}) {
  const onUpdateRaw = isAgentToolUpdate(opts.onUpdate) ? opts.onUpdate : undefined;
  const startedAt = Date.now();
  let rawPreview = "";
  let outputChars = 0;
  let currentModel = opts.model;
  let currentTool: string | undefined;
  let usage: SubAgentProgressUsage | undefined;
  let onUpdate: AgentToolUpdate | undefined = onUpdateRaw;

  const safeUpdate = (payload: {
    content: Array<{ type: "text"; text: string }>;
    details: SubAgentProgressDetails;
  }) => {
    if (!onUpdate) return;
    try {
      onUpdate(payload);
    } catch (err) {
      // Disable further updates so a buggy host UI cannot keep throwing on every chunk.
      onUpdate = undefined;
      getLogger().warn("Sub-agent progress onUpdate callback threw; disabling progress updates", {
        agent: opts.agent,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const buildDetails = (
    status: SubAgentProgressStatus,
    attemptedModels?: readonly string[],
  ): SubAgentProgressDetails => {
    const preview = rawPreview ? redactDelegateText(rawPreview) : "";
    return {
      agent: opts.agent,
      status,
      model: currentModel,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      elapsedMs: Date.now() - startedAt,
      outputChars,
      outputPreview: preview || undefined,
      attemptedModels,
      currentTool,
      usage,
    };
  };

  const emit = (status: SubAgentProgressStatus, attemptedModels?: readonly string[]) => {
    if (!onUpdate) return;
    const details = buildDetails(status, attemptedModels);
    safeUpdate({
      content: [{ type: "text", text: formatProgressSummary(details) }],
      details,
    });
  };

  const appendDelta = (delta: string) => {
    outputChars += delta.length;
    rawPreview = appendBoundedRaw(rawPreview, delta);
  };

  const isStringRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

  const handleEvent = (event: PiSessionEvent): void => {
    let changed = false;
    switch (event.type) {
      case "message_start": {
        const message = event.message;
        if (isStringRecord(message) && typeof message.model === "string") {
          if (message.model !== currentModel) {
            currentModel = message.model;
            changed = true;
          }
        }
        break;
      }
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (isStringRecord(ame)) {
          const ameType = ame.type;
          if (ameType === "text_delta" && typeof ame.delta === "string") {
            appendDelta(ame.delta);
            changed = true;
          } else if (ameType === "thinking_delta" && typeof ame.delta === "string") {
            // Surface thinking deltas in the same preview so the UI shows
            // progress even before the assistant emits visible text.
            appendDelta(ame.delta);
            changed = true;
          } else if (ameType === "toolcall_end" && isStringRecord(ame.toolCall)) {
            const tc = ame.toolCall as Record<string, unknown>;
            if (typeof tc.name === "string") {
              currentTool = tc.name;
              changed = true;
            }
          }
        }
        break;
      }
      case "message_end": {
        const message = event.message;
        if (isStringRecord(message) && isStringRecord(message.usage)) {
          const u = message.usage as Record<string, unknown>;
          const cost = isStringRecord(u.cost)
            ? (u.cost as Record<string, unknown>).total
            : undefined;
          // Accumulate across turns: message_end fires once per assistant
          // message and a single sub-agent run usually has many turns
          // (think -> tool -> think -> tool -> answer). Replacing on every
          // turn would underreport totals by ~10x.
          const turnInput = typeof u.input === "number" ? u.input : 0;
          const turnOutput = typeof u.output === "number" ? u.output : 0;
          const turnTotal = typeof u.totalTokens === "number" ? u.totalTokens : 0;
          const turnCost = typeof cost === "number" ? cost : 0;
          usage = {
            input: (usage?.input ?? 0) + turnInput,
            output: (usage?.output ?? 0) + turnOutput,
            total: (usage?.total ?? 0) + turnTotal,
            cost: (usage?.cost ?? 0) + turnCost,
          };
          changed = true;
        }
        break;
      }
      case "tool_execution_start": {
        if (typeof event.toolName === "string") {
          currentTool = event.toolName;
          changed = true;
        }
        break;
      }
      case "tool_execution_end": {
        if (currentTool !== undefined) {
          currentTool = undefined;
          changed = true;
        }
        break;
      }
      default:
        // session, agent_start, turn_start, turn_end, agent_end,
        // tool_execution_update, extension_ui_request, etc. -> nothing to do.
        break;
    }
    if (changed) emit("running");
  };

  return {
    start() {
      emit("starting");
    },
    setModel(model: string | undefined) {
      currentModel = model;
    },
    handleEvent,
    finish(status: SubAgentProgressStatus, attemptedModels?: readonly string[]) {
      emit(status, attemptedModels);
    },
  };
}

function statusFromResult(result: FallbackResult): SubAgentProgressStatus {
  if (result.success) return "completed";
  if (result.failureKind === "cancelled") return "cancelled";
  if (result.failureKind === "timed_out") return "timed_out";
  return "failed";
}

export interface RegisterSubAgentOptions {
  /** Override the default spawn function (for testing). */
  spawnFn?: SpawnFn;
}

/**
 * Register a sub-agent with the Pi host based on its declaration.
 * Skips registration silently when the agent is not in the enabled set.
 *
 * This is the generic replacement for per-agent `registerDelegate*Tool()`
 * functions. It resolves prompts, tools, and model overrides from the
 * declaration, then delegates to `runNestedPi()`.
 */
export function registerSubAgent(
  pi: ExtensionAPI,
  declaration: SubAgentDeclaration,
  options?: RegisterSubAgentOptions,
): void {
  if (!getEnabledSet().subAgents.has(declaration.name)) return;

  const { spawnFn } = options ?? {};

  (pi.registerTool as (def: unknown) => void)({
    name: declaration.toolName,
    label: declaration.name,
    description: declaration.description,
    parameters: declaration.parameters,
    renderShell: "default",
    renderResult: buildSubAgentRenderResult(),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: { cwd?: string },
    ) => {
      try {
        const baseSystemPrompt = declaration.systemPrompt;
        if (baseSystemPrompt.trim().length === 0) {
          throw new Error(`Sub-agent "${declaration.name}" has an empty systemPrompt`);
        }

        // Resolve the per-agent snapshot up front so promptMode (which may
        // be overridden via JSON config) can flow into the prompt builder.
        const snapshot = getAgentSnapshotFor(declaration.name);

        // Build the system prompt through the centralised assembler. In static
        // mode (the only currently supported mode) this is a no-op pass-through.
        // append mode throws immediately so callers fail loudly.
        const builtPrompt = buildSystemPrompt({
          basePrompt: baseSystemPrompt,
          declaration: {
            name: declaration.name,
            promptMode: snapshot?.promptMode ?? declaration.promptMode,
          },
        });

        const userPrompt = declaration.buildUserPrompt(params);

        const rawAllowedTools =
          typeof declaration.allowedTools === "function"
            ? [...declaration.allowedTools()]
            : [...declaration.allowedTools];

        const finalized = finalizeNestedTools({
          tools: rawAllowedTools,
          globalDisabled: getEnabledSet().disabledTools,
          mutability: declaration.mutability ?? "read-only",
          mode: declaration.finalizeMode ?? "strict",
          context: `sub-agent ${declaration.name}`,
        });
        const allowedTools = [...finalized.tools];

        if (allowedTools.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Sub-agent "${declaration.name}" has no allowed tools after policy filtering. Check disabled_tools or the agent tool allowlist.`,
              },
            ],
          };
        }

        if (finalized.droppedGlobalDisabled.length > 0) {
          getLogger().warn("Sub-agent dropped globally disabled tools", {
            agent: declaration.name,
            dropped: [...finalized.droppedGlobalDisabled],
          });
        }
        if (finalized.droppedMutability.length > 0) {
          getLogger().warn("Sub-agent dropped mutating tools (read-only policy)", {
            agent: declaration.name,
            dropped: [...finalized.droppedMutability],
          });
        }
        if (finalized.droppedUnknown.length > 0) {
          // strict mode already threw above; this branch is reached only in lenient mode.
          getLogger().warn("Sub-agent dropped unknown / delegate tool names", {
            agent: declaration.name,
            dropped: [...finalized.droppedUnknown],
          });
        }

        // Apply any declaration-level prepend overlay (e.g. General safety).
        let finalSystemPrompt = builtPrompt;
        if (declaration.prependSystemPrompt) {
          try {
            const overlay = await declaration.prependSystemPrompt({
              cwd: ctx?.cwd,
              finalizedTools: allowedTools,
            });
            if (overlay && overlay.length > 0) {
              finalSystemPrompt = `${overlay}\n\n${builtPrompt}`;
            }
          } catch (err) {
            getLogger().warn("Sub-agent prependSystemPrompt builder failed; using base prompt", {
              agent: declaration.name,
              error: (err as Error).message,
            });
          }
        }

        // Centralized per-agent config: snapshot resolved above. Fall back to
        // the legacy dynamic resolver only when the snapshot is unavailable
        // (e.g. older tests that don't init the snapshot).
        const overrides = snapshot
          ? {
              model: snapshot.model,
              reasoningEffort: snapshot.reasoningEffort,
              timeoutMs: snapshot.timeoutMs,
            }
          : ((await declaration.resolveModelOverrides?.()) ?? {});

        const progress = createProgressReporter({
          agent: declaration.name,
          model: overrides.model,
          cwd: ctx?.cwd,
          allowedTools,
          onUpdate,
        });
        progress.start();

        const baseRunOpts = {
          systemPrompt: finalSystemPrompt,
          userPrompt,
          model: overrides.model,
          reasoningEffort: overrides.reasoningEffort,
          timeoutMs: overrides.timeoutMs,
          allowedTools,
          cwd: ctx?.cwd,
          signal,
          onUpdate: (event: PiSessionEvent) => progress.handleEvent(event),
        };

        let result: FallbackResult;
        try {
          if (snapshot) {
            if (
              snapshot.fallbackModels &&
              snapshot.fallbackModels.length > 0 &&
              !snapshot.fallbackEligible
            ) {
              getLogger().warn(
                "Sub-agent has fallbackModels configured but is ineligible; ignoring fallback chain",
                {
                  agent: declaration.name,
                  fallbackModels: [...snapshot.fallbackModels],
                },
              );
            }
            result = await executeWithFallback({
              snapshot,
              runOpts: baseRunOpts,
              runner: (o) => {
                // Reflect the actual model used per attempt in live progress details.
                progress.setModel(o.model);
                return runNestedPi(o, spawnFn);
              },
            });
          } else {
            // Legacy path: no snapshot available (e.g. older tests).
            const r = await runNestedPi(baseRunOpts, spawnFn);
            result = {
              ...r,
              attemptedModels: [
                {
                  model: overrides.model,
                  status: r.success ? "success" : (r.failureKind ?? "failed"),
                  retriable: false,
                  durationMs: 0,
                },
              ],
            };
          }
        } catch (err) {
          // Unexpected throw after progress.start(): emit terminal progress so
          // the host UI does not show this delegate as still running, then rethrow
          // to the outer catch which produces the controlled tool result.
          progress.finish("failed");
          throw err;
        }
        progress.finish(
          statusFromResult(result),
          result.attemptedModels.map((attempt) => attempt.model ?? "(host model)"),
        );

        let text: string;
        if (result.success) {
          // On multi-attempt success, append a brief attempt summary so the
          // caller can see which model finally succeeded.
          if (result.attemptedModels.length > 1) {
            text = `${result.content}\n\n_Attempted models: ${formatAttempts(result.attemptedModels)}_`;
          } else {
            text = result.content;
          }
        } else {
          text = formatDelegateFailure(result);
          if (result.attemptedModels.length > 1) {
            text += `\nAttempted models: ${formatAttempts(result.attemptedModels)}`;
          }
        }
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        // Convert any setup-time error (empty prompt, prompt-builder append throw,
        // strict finalizer rejection, dynamic allowedTools throwing, snapshot lookup,
        // etc.) into a controlled tool result so the host never sees a raw throw.
        const message = err instanceof Error ? err.message : String(err);
        getLogger().warn("Sub-agent delegate execution failed before nested Pi", {
          agent: declaration.name,
          error: message,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Sub-agent "${declaration.name}" failed before nested Pi execution\nDetails:\n${message}`,
            },
          ],
        };
      }
    },
  });
}
