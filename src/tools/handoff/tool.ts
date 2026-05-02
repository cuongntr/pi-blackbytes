import { type EnabledSet, getEnabledSet } from "../../config/enabled-set.js";
import { redactSecrets } from "../../shared/redact.js";
import {
  PI_BUILTIN_TOOLS,
  finalizeNestedTools,
  resolveToolStrategy,
} from "../../sub-agents/delegable-tools.js";
import { runNestedPi } from "../../sub-agents/runner.js";
import type { DelegateResult } from "../../sub-agents/types.js";
import type { ToolResultStats } from "../_shared/stats-render.js";
import { type TextToolResult, textResult } from "../_shared/text-result.js";

const HANDOFF_DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes
const PRIOR_SUMMARY_CAP = 4_096;
const AUTO_DISTILL_CAP = 4_096;
const AUTO_DISTILL_MESSAGES = 10;
const AUTO_DISTILL_PER_MESSAGE_CAP = 400;

export interface HandoffParams {
  goal: string;
  mode?: string;
  /**
   * Optional caller-supplied summary of prior work to seed the new thread.
   * Capped at 4 KB and run through `redactSecrets` before being passed on.
   *
   * If omitted and a `sessionManager` is reachable through `ctx`, the tool
   * auto-distills the last 10 messages of the current session branch (also
   * capped at 4 KB and redacted). When both are present, the auto-distilled
   * summary is appended after the caller-supplied one.
   */
  prior_summary?: string;
}

/**
 * Minimal shape we need from the host's session manager. Declared
 * structurally so tests can stub it without pulling in the full Pi types.
 */
export interface HandoffSessionManagerLike {
  getBranch?: (fromId?: string) => unknown[];
  getEntries?: () => unknown[];
}

export interface HandoffSpawnOptions {
  /** Override for tests — defaults to runNestedPi from sub-agents/runner.js. */
  spawn?: typeof runNestedPi;
  /** Override for tests — defaults to () => new Date().toISOString(). */
  now?: () => string;
  /** Override for tests — defaults to process.cwd(). */
  cwd?: () => string;
  /** Forwarded to runNestedPi so user cancellation aborts the nested session. */
  signal?: AbortSignal;
  /**
   * Optional read-only session accessor. When provided, the last
   * AUTO_DISTILL_MESSAGES message entries are summarized into the nested
   * prompt under "## Auto-distilled prior summary".
   */
  sessionManager?: HandoffSessionManagerLike;
  /**
   * Override for tests — defaults to the session's `getEnabledSet()`.
   * When `getEnabledSet()` throws (uninitialized), falls back to an empty set
   * which results in an empty `--tools` allowlist for the nested Pi. Production
   * paths always go through `session_start` first, so the fallback is for
   * isolated unit tests only.
   */
  getEnabledSetFn?: () => EnabledSet;
}

/**
 * Compute the allowlist propagated to the nested Pi session. This is the
 * fix for a previously-discovered boundary issue: passing `allowedTools: []`
 * to `runNestedPi()` caused the runner to omit `--tools`, which made the
 * nested Pi default to its full built-in tool surface, **bypassing** the
 * parent's `disabled_tools` config. The new behavior mirrors how
 * `general.ts` derives its allowlist: take the parent's enabled extension
 * tools (minus `delegate_*`) plus Pi built-ins, then run them through
 * `finalizeNestedTools` with `full-access` mutability so `disabled_tools`
 * propagates and the result is deterministically ordered.
 */
function computeHandoffAllowedTools(getEnabledSetFn?: () => EnabledSet): readonly string[] {
  let enabledSet: EnabledSet;
  try {
    enabledSet = (getEnabledSetFn ?? getEnabledSet)();
  } catch {
    // Uninitialized enabled-set (test isolation, edge cases) — fall through
    // with an empty fallback. The runner will then omit `--tools`. This is
    // accepted ONLY for non-production code paths.
    return [];
  }
  const candidate = [
    ...resolveToolStrategy({ kind: "all-except-delegates" }, enabledSet.tools),
    ...PI_BUILTIN_TOOLS,
  ];
  const finalized = finalizeNestedTools({
    tools: candidate,
    globalDisabled: enabledSet.disabledTools,
    mutability: "full-access",
    mode: "lenient",
    context: "handoff",
  });
  return finalized.tools;
}

const HANDOFF_SYSTEM_PROMPT =
  "You are a fresh nested Pi session continuing work that was handed off from a parent thread. " +
  "The parent thread context is NOT carried over — only the goal, mode, prior summary, and " +
  "working directory below are available. Treat the goal as a self-contained brief and proceed " +
  "to completion using the tools available in this nested session. If the goal is ambiguous, " +
  "ask one precise clarifying question instead of guessing.";

function buildHandoffUserPrompt(params: {
  goal: string;
  mode?: string;
  callerSummary?: string;
  autoSummary?: string;
  cwd: string;
  timestamp: string;
}): string {
  const lines: string[] = [];
  lines.push(`Handoff context: ${params.goal.trim()}`);
  lines.push("");
  lines.push("## Handoff metadata");
  lines.push(`- timestamp: ${params.timestamp}`);
  lines.push(`- working directory: ${params.cwd}`);
  if (params.mode) {
    lines.push(`- mode hint: ${params.mode}`);
  }
  if (params.callerSummary && params.callerSummary.trim().length > 0) {
    lines.push("");
    lines.push("## Prior thread summary");
    lines.push("");
    lines.push(params.callerSummary.trim());
  }
  if (params.autoSummary && params.autoSummary.trim().length > 0) {
    lines.push("");
    lines.push("## Auto-distilled prior summary (last messages)");
    lines.push("");
    lines.push(params.autoSummary.trim());
  }
  return lines.join("\n");
}

function buildSummary(result: DelegateResult, mode: string | undefined): string {
  const verb = result.success ? "completed" : "failed";
  const modeNote = mode ? ` (${mode})` : "";
  return `handoff ${verb}${modeNote}`;
}

function isStringRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Best-effort auto-distillation of the last N message entries from a Pi
 * session branch. Returns undefined when the session manager is unavailable
 * or yields nothing usable. All output is run through `redactSecrets` and
 * hard-capped at AUTO_DISTILL_CAP characters.
 */
export function autoDistillBranch(sm: HandoffSessionManagerLike): string | undefined {
  let entries: unknown[] = [];
  try {
    if (typeof sm.getBranch === "function") {
      entries = sm.getBranch();
    } else if (typeof sm.getEntries === "function") {
      entries = sm.getEntries();
    }
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries) || entries.length === 0) return undefined;

  const messages = entries.filter(
    (e) => isStringRecord(e) && (e as { type: unknown }).type === "message",
  );
  if (messages.length === 0) return undefined;

  const tail = messages.slice(-AUTO_DISTILL_MESSAGES);
  const lines: string[] = [];

  for (const entry of tail) {
    if (!isStringRecord(entry)) continue;
    const message = entry.message;
    if (!isStringRecord(message)) continue;
    const role = typeof message.role === "string" ? message.role : "unknown";

    let textBody = "";
    const content = message.content;
    if (typeof content === "string") {
      textBody = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (!isStringRecord(part)) continue;
        const partType = part.type;
        if (partType === "text" && typeof part.text === "string") {
          parts.push(part.text);
        } else if (partType === "toolCall" && typeof part.name === "string") {
          parts.push(`[toolCall: ${part.name}]`);
        } else if (partType === "image") {
          parts.push("[image]");
        }
      }
      textBody = parts.join(" ");
    }
    textBody = textBody.replace(/\s+/g, " ").trim();
    if (textBody.length === 0) continue;
    lines.push(`- **${role}**: ${truncate(textBody, AUTO_DISTILL_PER_MESSAGE_CAP)}`);
  }

  if (lines.length === 0) return undefined;
  const distilled = redactSecrets(lines.join("\n").slice(0, AUTO_DISTILL_CAP));
  return distilled.length > 0 ? distilled : undefined;
}

export async function executeHandoff(
  params: HandoffParams,
  options: HandoffSpawnOptions = {},
): Promise<TextToolResult<ToolResultStats>> {
  const goal = (params.goal ?? "").trim();
  if (goal.length === 0) {
    return textResult("Error: handoff requires a non-empty `goal`.", {
      summary: "missing goal",
    });
  }

  const mode = params.mode?.trim() || undefined;
  const priorSummaryRaw = params.prior_summary?.trim();
  const callerSummary = priorSummaryRaw
    ? redactSecrets(priorSummaryRaw.slice(0, PRIOR_SUMMARY_CAP))
    : undefined;
  const autoSummary = options.sessionManager
    ? autoDistillBranch(options.sessionManager)
    : undefined;

  const cwd = (options.cwd ?? (() => process.cwd()))();
  const timestamp = (options.now ?? (() => new Date().toISOString()))();
  const spawn = options.spawn ?? runNestedPi;

  const userPrompt = buildHandoffUserPrompt({
    goal,
    mode,
    callerSummary,
    autoSummary,
    cwd,
    timestamp,
  });

  const allowedTools = [...computeHandoffAllowedTools(options.getEnabledSetFn)];

  const result = await spawn({
    systemPrompt: HANDOFF_SYSTEM_PROMPT,
    userPrompt,
    allowedTools,
    cwd,
    timeoutMs: HANDOFF_DEFAULT_TIMEOUT_MS,
    signal: options.signal,
  });

  const summary = buildSummary(result, mode);
  if (!result.success) {
    const detail = result.details
      ? `${result.content}\n\n${redactSecrets(result.details)}`
      : result.content;
    return textResult(`Handoff failed: ${detail}`, { summary, fullText: detail });
  }

  return textResult(result.content, {
    summary,
    fullText: result.content,
  });
}
