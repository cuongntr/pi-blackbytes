import { type Theme, keyText } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { isBoxedToolCallsEnabled } from "../tools/_shared/boxed-config.js";
import { renderBoxedToolResult } from "../tools/_shared/boxed-render.js";
import { SPINNER_TICK_MS, formatCost, formatDuration, getSpinnerFrame } from "./format.js";
import { getAgentIcon } from "./icons.js";
import type { ToolHistoryEntry } from "./progress-reporter.js";

export type { ToolHistoryEntry };

/**
 * Shape of the `details` payload emitted by sub-agent progress updates and
 * the final tool result. Kept structurally compatible across runner.ts /
 * register.ts so the renderer can be used in both partial and final states.
 */
export interface SubAgentRenderDetails {
  readonly agent?: string;
  readonly status?: "starting" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
  readonly model?: string;
  readonly cwd?: string;
  readonly allowedTools?: readonly string[];
  readonly elapsedMs?: number;
  readonly outputChars?: number;
  readonly outputPreview?: string;
  readonly attemptedModels?: readonly string[];
  readonly currentTool?: string;
  readonly toolCallCount?: number;
  readonly toolHistory?: readonly ToolHistoryEntry[];
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly total?: number;
    readonly cost?: number;
  };
}

interface RenderResult {
  readonly content: ReadonlyArray<{ type: string; text?: string }>;
  readonly details?: SubAgentRenderDetails;
}

interface RenderOptions {
  readonly expanded: boolean;
  readonly isPartial: boolean;
}

interface RenderState {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
  // Live inner component, kept stable across redraws independently of
  // context.lastComponent (which becomes the outer box once we wrap it).
  component?: SubAgentResultComponent;
}

function statusColor(
  status: SubAgentRenderDetails["status"],
): "success" | "error" | "warning" | "muted" | "accent" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
    case "timed_out":
      return "warning";
    case "running":
      return "accent";
    default:
      return "muted";
  }
}

function getResultText(result: RenderResult): string {
  // Concatenate all text parts. Pi's tool results may have multiple text
  // parts; returning only the first would silently drop content.
  const parts: string[] = [];
  for (const part of result.content) {
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("");
}

/**
 * Class so we can preserve a single Container instance across redraws
 * (matches the bash tool pattern: `context.lastComponent ?? new ...`).
 */
export class SubAgentResultComponent extends Container {}

export function rebuildSubAgentResultComponent(
  component: SubAgentResultComponent,
  result: RenderResult,
  options: RenderOptions,
  state: RenderState,
  theme: Theme,
): void {
  component.clear();

  const details = result.details ?? {};
  const status = details.status ?? (options.isPartial ? "running" : "completed");
  const color = statusColor(status);
  // Live elapsed: in partial mode always tick from local state so the counter
  // updates smoothly with setInterval; only fall back to the reporter's
  // emit-time elapsedMs after the run finishes.
  const elapsedMs = options.isPartial
    ? state.startedAt !== undefined
      ? Date.now() - state.startedAt
      : details.elapsedMs
    : (details.elapsedMs ??
      (state.startedAt !== undefined
        ? (state.endedAt ?? Date.now()) - state.startedAt
        : undefined));

  // Header: "<status-icon> <agent-icon> <agent> · <elapsed> · <calls> · <tool> · <chars> · $<cost> · ⌃O expand"
  // Model name is intentionally NOT in the header — it moves to the expanded body to reduce noise.
  // Status indicator: spinner braille while running, terminal glyph otherwise.
  // The word "running"/"completed"/etc. is dropped — the icon carries the meaning,
  // matching the convention used by stats-render.ts for other tools.
  const statusIndicator =
    status === "running"
      ? theme.fg("accent", getSpinnerFrame())
      : status === "completed"
        ? theme.fg("success", "✓")
        : status === "failed"
          ? theme.fg("error", "✗")
          : status === "cancelled" || status === "timed_out"
            ? theme.fg("warning", "⚠")
            : "";
  // Agent identity: <icon> <bold name> in the agent's status color so the row
  // is recognisable at a glance even when many delegations run in parallel.
  const agentLabel = details.agent
    ? `${getAgentIcon(details.agent)} ${theme.fg(color, theme.bold(details.agent))}`
    : "";
  // Fuse status + agent into one bit so the " · " separator does not appear
  // between them (we want "⠹ 🔭 explore", not "⠹ · 🔭 explore").
  const identity =
    statusIndicator && agentLabel
      ? `${statusIndicator} ${agentLabel}`
      : statusIndicator || agentLabel;
  const headerBits: string[] = [];
  if (identity) headerBits.push(identity);
  if (elapsedMs !== undefined) {
    headerBits.push(theme.fg("muted", formatDuration(elapsedMs)));
  }
  if (typeof details.toolCallCount === "number" && details.toolCallCount > 0) {
    headerBits.push(theme.fg("muted", `${details.toolCallCount} calls`));
  }
  if (status === "running" && !options.expanded) {
    // When expanded, the tool activity timeline below shows the active /
    // most-recent tool anyway; repeating it in the header is redundant.
    if (details.currentTool) {
      // Active tool: split coloring — icon accent ("in progress"), tool name in
      // toolTitle (recognisable identifier), arg hint muted (supporting detail).
      // Matches the convention used by src/tools/_shared/call-render.ts.
      const toolLabel = details.currentTool;
      const currentEntry =
        details.toolHistory && details.toolHistory.length > 0
          ? details.toolHistory[details.toolHistory.length - 1]
          : undefined;
      const argHint =
        currentEntry && currentEntry.endMs === undefined && currentEntry.summary
          ? currentEntry.summary
          : "";
      const iconAndName = `${theme.fg("accent", "🔧")} ${theme.fg("toolTitle", toolLabel)}`;
      const tail = argHint ? ` ${theme.fg("muted", argHint)}` : "";
      headerBits.push(`${iconAndName}${tail}`);
    } else if (details.toolHistory && details.toolHistory.length > 0) {
      // Between calls (e.g. agent is thinking after a tool completed): keep the
      // last tool visible but muted so the row never goes "silent" while the
      // elapsed counter ticks on. ◷ glyph signals "just finished".
      const last = details.toolHistory[details.toolHistory.length - 1];
      if (last.endMs !== undefined) {
        const hint = last.summary ? ` ${last.summary}` : "";
        headerBits.push(theme.fg("muted", `◷ ${last.name}${hint}`));
      }
    }
  }
  if (typeof details.outputChars === "number" && details.outputChars > 0) {
    headerBits.push(theme.fg("muted", `${details.outputChars.toLocaleString("en-US")} chars`));
  }
  if (
    !options.expanded &&
    details.usage &&
    typeof details.usage.cost === "number" &&
    details.usage.cost > 0
  ) {
    // Cost moves to the expanded footer aggregate when expanded; showing it in
    // both places at once is duplication that the user noticed in v2.8.0.
    headerBits.push(theme.fg("muted", formatCost(details.usage.cost)));
  }
  // Failed state: surface a one-line error hint in red so the user can see
  // *why* the run failed without expanding. First line of the result text,
  // stripped of a leading "Error: " marker and truncated to ~60 chars.
  if (status === "failed") {
    const hint = extractErrorHint(result);
    if (hint) headerBits.push(theme.fg("error", hint));
  }
  if (!options.expanded) {
    // Manual compose instead of keyHint() because keyHint() requires the host
    // theme to be initialized; before that we'd throw. keyText() has a safer
    // fallback ("" → default literal).
    const key = keyText("app.tools.expand") || "ctrl+o";
    headerBits.push(theme.fg("accent", `${key} to expand`));
  }
  component.addChild(new Text(headerBits.join(theme.fg("muted", " · ")), 0, 0));

  // Body: only when expanded. Collapsed view is header-only — the live tail
  // was noisy and the final tail was meaningless.
  if (options.expanded) {
    // Tool activity log: compact timeline of tool calls
    if (details.toolHistory && details.toolHistory.length > 0) {
      const MAX_DISPLAY_HISTORY = 30;
      const history = details.toolHistory;
      const displayEntries =
        history.length > MAX_DISPLAY_HISTORY ? history.slice(-MAX_DISPLAY_HISTORY) : history;
      const skipped = history.length - displayEntries.length;

      const historyLines: string[] = [];
      if (skipped > 0) {
        historyLines.push(theme.fg("muted", `  [+${skipped} earlier calls]`));
      }
      for (const entry of displayEntries) {
        const done = entry.endMs !== undefined;
        const icon = done ? theme.fg("success", "✓") : theme.fg("accent", "▸");
        const dur = done
          ? theme.fg("muted", `(${formatDuration(entry.endMs! - entry.startMs)})`)
          : theme.fg("accent", "(running…)");
        const hint = entry.summary ? ` ${theme.fg("muted", entry.summary)}` : "";
        // Tool name colored with toolTitle (same convention as call-render.ts)
        // makes the activity log scannable when there are many entries.
        historyLines.push(`  ${icon} ${theme.fg("toolTitle", entry.name)}${hint} ${dur}`);
      }
      component.addChild(new Text(`\n${historyLines.join("\n")}`, 0, 0));
    }

    const finalText = !options.isPartial ? getResultText(result) : "";
    const previewText = options.isPartial ? (details.outputPreview ?? "") : "";
    const bodyText = options.isPartial ? previewText : finalText;
    if (bodyText) {
      const styled = bodyText
        .split("\n")
        .map((line) => theme.fg("toolOutput", line))
        .join("\n");
      component.addChild(new Text(`\n${styled}`, 0, 0));
    } else if (options.isPartial) {
      component.addChild(new Text(`\n${theme.fg("muted", "(no output captured yet)")}`, 0, 0));
    }

    // Aggregate footer: model · Tools: 12× read · 8× edit · 4× bash · $0.42
    // Surfaces the model (removed from header in T1) plus a flattened tool-mix
    // summary that complements the chronological timeline above.
    const footerBits: string[] = [];
    if (details.model) footerBits.push(theme.fg("muted", details.model));
    const toolMix = aggregateToolHistory(details.toolHistory);
    if (toolMix) footerBits.push(theme.fg("muted", `Tools: ${toolMix}`));
    if (details.usage && typeof details.usage.cost === "number" && details.usage.cost > 0) {
      footerBits.push(theme.fg("muted", formatCost(details.usage.cost)));
    }
    if (footerBits.length > 0) {
      component.addChild(new Text(`\n${footerBits.join(theme.fg("muted", " · "))}`, 0, 0));
    }
  }
}

/**
 * Pull a single-line error hint from the tool result.
 *
 * On failure the first content text block typically begins with `Error: ...`
 * or a `Sub-agent "xxx" failed ...` preamble; we strip the redundant prefix
 * and clamp to ~60 chars so it fits alongside other header bits.
 */
function extractErrorHint(result: RenderResult): string | undefined {
  const text = result.content?.[0]?.text;
  if (typeof text !== "string" || text.length === 0) return undefined;
  let firstLine = (text.split("\n", 1)[0] ?? "").trim();
  firstLine = firstLine.replace(/^Error:\s*/i, "");
  if (!firstLine) return undefined;
  const MAX = 60;
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX - 1)}\u2026` : firstLine;
}

/**
 * Group tool calls by name and produce a compact `N× name · ...` summary,
 * sorted descending by call count so the most-used tools surface first.
 */
function aggregateToolHistory(history?: readonly ToolHistoryEntry[]): string {
  if (!history || history.length === 0) return "";
  const counts = new Map<string, number>();
  for (const entry of history) {
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB))
    .map(([name, n]) => `${n}× ${name}`)
    .join(" · ");
}

/**
 * Build a `renderResult` function for use in a sub-agent ToolDefinition.
 *
 * The returned callable matches Pi's `renderResult(result, options, theme, ctx)`
 * signature and is responsible for driving the live elapsed-timer redraw loop
 * while the sub-agent is still executing.
 */
export function buildSubAgentRenderResult() {
  return (
    result: RenderResult,
    options: RenderOptions,
    theme: Theme,
    context: {
      readonly state: RenderState;
      readonly lastComponent: unknown;
      readonly invalidate: () => void;
    },
  ) => {
    const state = context.state;
    const isLive =
      options.isPartial ||
      result.details?.status === "starting" ||
      result.details?.status === "running";
    if (state.startedAt === undefined) {
      state.startedAt = Date.now();
    }
    if (isLive && !state.interval) {
      // 100 ms tick drives the braille spinner animation. Same timer also keeps
      // the elapsed counter ticking between tool events.
      state.interval = setInterval(() => context.invalidate(), SPINNER_TICK_MS);
    }
    if (!isLive) {
      state.endedAt ??= Date.now();
      if (state.interval) {
        clearInterval(state.interval);
        state.interval = undefined;
      }
    }
    // Keep a stable inner component identity in state: once wrapped in a box,
    // context.lastComponent is the box, not the SubAgentResultComponent.
    const component = state.component ?? new SubAgentResultComponent();
    state.component = component;
    rebuildSubAgentResultComponent(component, result, options, state, theme);
    component.invalidate();
    if (!isBoxedToolCallsEnabled()) return component;
    // Boxed: one continuous frame with the open-bottom call box above. Keep a
    // uniform pending-tinted background across call + result (status is shown
    // via the ✓/✗/⚠ foreground icon) so the seam never looks colour-split.
    return renderBoxedToolResult(theme, component, {
      seamTop: true,
      live: isLive,
      bgToken: "toolPendingBg",
    });
  };
}
