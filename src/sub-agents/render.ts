import { type Theme, keyText } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
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
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
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

  // Single-line header: "<status> · <elapsed> · <calls> · 🔧 <tool> · <chars> · <model> · $<cost> · ⌃O expand"
  // Everything fits on one row; press Ctrl+O for full output.
  const statusIcon =
    status === "completed"
      ? "✓ "
      : status === "failed"
        ? "✗ "
        : status === "cancelled" || status === "timed_out"
          ? "⚠ "
          : "";
  const headerBits: string[] = [theme.fg(color, theme.bold(`${statusIcon}${status}`))];
  if (elapsedMs !== undefined) {
    headerBits.push(theme.fg("muted", formatDuration(elapsedMs)));
  }
  if (typeof details.toolCallCount === "number" && details.toolCallCount > 0) {
    headerBits.push(theme.fg("muted", `${details.toolCallCount} calls`));
  }
  if (status === "running" && details.currentTool) {
    const toolLabel = details.currentTool;
    const currentEntry =
      details.toolHistory && details.toolHistory.length > 0
        ? details.toolHistory[details.toolHistory.length - 1]
        : undefined;
    const argHint =
      currentEntry && currentEntry.endMs === undefined && currentEntry.summary
        ? ` ${currentEntry.summary}`
        : "";
    headerBits.push(theme.fg("accent", `🔧 ${toolLabel}${argHint}`));
  }
  if (typeof details.outputChars === "number" && details.outputChars > 0) {
    headerBits.push(theme.fg("muted", `${details.outputChars.toLocaleString("en-US")} chars`));
  }
  if (details.model) {
    headerBits.push(theme.fg("muted", details.model));
  }
  if (details.usage && typeof details.usage.cost === "number" && details.usage.cost > 0) {
    headerBits.push(theme.fg("muted", `$${details.usage.cost.toFixed(4)}`));
  }
  if (!options.expanded) {
    // Always show the hint. keyText() may return "" before keybindings are
    // fully loaded; fall back to the default "ctrl+o". Use "accent" so it's
    // visibly distinct from the other muted bits.
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
        historyLines.push(`  ${icon} ${theme.bold(entry.name)}${hint} ${dur}`);
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
  }
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
    if (state.startedAt === undefined) {
      state.startedAt = Date.now();
    }
    if (options.isPartial && !state.interval) {
      state.interval = setInterval(() => context.invalidate(), 1000);
    }
    if (!options.isPartial) {
      state.endedAt ??= Date.now();
      if (state.interval) {
        clearInterval(state.interval);
        state.interval = undefined;
      }
    }
    const component =
      context.lastComponent instanceof SubAgentResultComponent
        ? context.lastComponent
        : new SubAgentResultComponent();
    rebuildSubAgentResultComponent(component, result, options, state, theme);
    component.invalidate();
    return component;
  };
}
