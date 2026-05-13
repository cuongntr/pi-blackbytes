import { getLogger } from "../shared/logger.js";
import { redactDelegateText } from "./runner.js";
import type { PiSessionEvent } from "./types.js";

export type SubAgentProgressStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface SubAgentProgressUsage {
  readonly input?: number;
  readonly output?: number;
  readonly total?: number;
  readonly cost?: number;
}

export interface SubAgentProgressDetails {
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
  readonly toolCallCount: number;
  readonly toolHistory: readonly ToolHistoryEntry[];
  readonly usage?: SubAgentProgressUsage;
}

export interface ToolHistoryEntry {
  readonly name: string;
  readonly summary?: string;
  readonly startMs: number;
  readonly endMs?: number;
}

type AgentToolUpdate = (update: {
  content: Array<{ type: "text"; text: string }>;
  details: SubAgentProgressDetails;
}) => void;

const MAX_PROGRESS_PREVIEW_CHARS = 8_192;
const MAX_TOOL_HISTORY = 100;
const MAX_TOOL_ARG_SUMMARY = 50;
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

export interface ProgressReporterOptions {
  readonly agent: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly allowedTools: readonly string[];
  readonly onUpdate?: unknown;
}

export interface ProgressReporter {
  start(): void;
  setModel(model: string | undefined): void;
  handleEvent(event: PiSessionEvent): void;
  finish(status: SubAgentProgressStatus, attemptedModels?: readonly string[]): void;
  getLastDetails(): SubAgentProgressDetails | undefined;
}

export function createProgressReporter(opts: ProgressReporterOptions): ProgressReporter {
  const onUpdateRaw = isAgentToolUpdate(opts.onUpdate) ? opts.onUpdate : undefined;
  const startedAt = Date.now();
  let rawPreview = "";
  let outputChars = 0;
  let currentModel = opts.model;
  let currentTool: string | undefined;
  let toolCallCount = 0;
  const toolHistory: Array<{
    name: string;
    summary?: string;
    startMs: number;
    endMs?: number;
  }> = [];
  const pendingToolArgs = new Map<string, string[]>();
  let usage: SubAgentProgressUsage | undefined;
  let onUpdate: AgentToolUpdate | undefined = onUpdateRaw;
  let lastDetails: SubAgentProgressDetails | undefined;

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
      toolCallCount,
      toolHistory: toolHistory.length > 0 ? [...toolHistory] : [],
      usage,
    };
  };

  const emit = (status: SubAgentProgressStatus, attemptedModels?: readonly string[]) => {
    const details = buildDetails(status, attemptedModels);
    lastDetails = details;
    if (!onUpdate) return;
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

  /** Extract a short human-readable hint from tool arguments. */
  const summarizeToolArgs = (args: Record<string, unknown>): string | undefined => {
    // Try well-known parameter names in priority order
    for (const key of [
      "path",
      "filePath",
      "command",
      "query",
      "pattern",
      "question",
      "task",
      "prompt",
      "url",
      "request",
    ]) {
      const val = args[key];
      if (typeof val === "string" && val.length > 0) {
        return val.length > MAX_TOOL_ARG_SUMMARY
          ? `${val.slice(0, MAX_TOOL_ARG_SUMMARY - 1)}\u2026`
          : val;
      }
    }
    return undefined;
  };

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
              // Capture args summary for the upcoming tool_execution_start
              const args = tc.arguments ?? tc.input;
              if (isStringRecord(args)) {
                const summary = summarizeToolArgs(args as Record<string, unknown>);
                if (summary) {
                  const queue = pendingToolArgs.get(tc.name) ?? [];
                  queue.push(summary);
                  pendingToolArgs.set(tc.name, queue);
                }
              }
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
          toolCallCount++;
          // Resolve args summary: prefer pending from toolcall_end, fallback to event
          const queue = pendingToolArgs.get(event.toolName);
          let summary = queue?.shift();
          if (queue && queue.length === 0) pendingToolArgs.delete(event.toolName);
          if (!summary && isStringRecord(event.arguments)) {
            summary = summarizeToolArgs(event.arguments as Record<string, unknown>);
          }
          toolHistory.push({
            name: event.toolName,
            summary,
            startMs: Date.now() - startedAt,
          });
          // Cap history to avoid unbounded growth
          if (toolHistory.length > MAX_TOOL_HISTORY) toolHistory.shift();
          changed = true;
        }
        break;
      }
      case "tool_execution_end": {
        // Close the most recent open history entry
        for (let i = toolHistory.length - 1; i >= 0; i--) {
          if (toolHistory[i].endMs === undefined) {
            toolHistory[i].endMs = Date.now() - startedAt;
            changed = true;
            break;
          }
        }
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
    getLastDetails(): SubAgentProgressDetails | undefined {
      return lastDetails;
    },
  };
}
