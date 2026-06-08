import { type Theme, keyText } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { renderLightweightToolResult } from "../tools/_shared/lightweight-render.js";
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
  // Caching: skip redundant rebuilds when only the spinner ticked
  lastDataHash?: string;
  cachedMetricsText?: string;
  // Expanded-body cache keyed on the *identity* of the emitted details object.
  // progress-reporter.buildDetails() returns a fresh object only on real data
  // change (throttled to 300ms); the 100ms spinner tick re-renders with the
  // same reference, so a reference check is both cheaper and more correct than
  // hashing the 8KB preview + JSON-stringifying the tool history every tick.
  lastExpandedDetailsRef?: SubAgentRenderDetails;
  lastExpandedIsPartial?: boolean;
  cachedExpandedLines?: string[];
}

const MAX_DISPLAY_HISTORY = 30;

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
  seamContext = false,
  display: "full" | "compact" | "minimal" = "full",
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

  // Status indicator: spinner braille while running, terminal glyph otherwise.
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

  // === TIER 1: Identity line (spinner + agent icon + bold name) ===
  // Skip in seam context — the call box above already shows the agent identity.
  if (!seamContext) {
    const agentLabel = details.agent
      ? `${getAgentIcon(details.agent)} ${theme.fg(color, theme.bold(details.agent))}`
      : "";
    const identity =
      statusIndicator && agentLabel
        ? `${statusIndicator} ${agentLabel}`
        : statusIndicator || agentLabel;
    if (identity) {
      component.addChild(new Text(identity, 0, 0));
    }
  }

  // === TIER 2: Metrics line — skipped in "minimal" mode ===
  if (display !== "minimal") {
    const dataHash = `${status}-${Math.floor((elapsedMs ?? 0) / 1000)}-${details.toolCallCount}-${details.currentTool}-${details.outputChars}-${options.expanded}-${details.usage?.cost}`;
    if (dataHash !== state.lastDataHash) {
      state.lastDataHash = dataHash;
      state.cachedMetricsText = buildMetricsLine(
        details,
        elapsedMs,
        status,
        options,
        theme,
        result,
      );
    }
    if (state.cachedMetricsText) {
      component.addChild(new Text(state.cachedMetricsText, 0, 0));
    }
    // Collapsed tool activity — only in "full" mode
    if (display === "full" && !options.expanded && status === "running") {
      for (const line of buildCollapsedToolActivity(details, theme)) {
        component.addChild(new Text(line, 0, 0));
      }
    }
  }

  // === EXPANDED BODY (cached — only rebuilt when the emitted data changes) ===
  // Gate on details object identity: the spinner tick re-renders with the same
  // `details` reference, so we skip rebuilding (and skip the expensive preview
  // hash + tool-history serialization) until progress-reporter emits a new
  // snapshot. isPartial is folded in because it switches the body between the
  // live preview and the final output text.
  if (options.expanded) {
    const expandedDataChanged =
      details !== state.lastExpandedDetailsRef ||
      options.isPartial !== state.lastExpandedIsPartial ||
      state.cachedExpandedLines === undefined;
    if (expandedDataChanged) {
      state.lastExpandedDetailsRef = details;
      state.lastExpandedIsPartial = options.isPartial;
      state.cachedExpandedLines = buildExpandedBody(result, details, options, theme);
    }
    for (const line of state.cachedExpandedLines ?? []) {
      component.addChild(new Text(line, 0, 0));
    }
  }
}

/** Build the metrics line (Tier 2): elapsed · calls · tool · chars · cost · expand hint. */
function buildMetricsLine(
  details: SubAgentRenderDetails,
  elapsedMs: number | undefined,
  status: string,
  options: RenderOptions,
  theme: Theme,
  result: RenderResult,
): string {
  const bits: string[] = [];
  if (elapsedMs !== undefined) {
    bits.push(theme.fg("muted", formatDuration(elapsedMs)));
  }
  if (typeof details.toolCallCount === "number" && details.toolCallCount > 0) {
    bits.push(theme.fg("muted", `${details.toolCallCount} calls`));
  }
  // Collapsed running state renders recent nested tool calls in their own
  // lightweight activity lines, so keep this metrics row focused on summary
  // metadata instead of duplicating the active tool.
  if (typeof details.outputChars === "number" && details.outputChars > 0) {
    bits.push(theme.fg("muted", `${details.outputChars.toLocaleString("en-US")} chars`));
  }
  if (
    !options.expanded &&
    details.usage &&
    typeof details.usage.cost === "number" &&
    details.usage.cost > 0
  ) {
    bits.push(theme.fg("muted", formatCost(details.usage.cost)));
  }
  if (status === "failed") {
    const hint = extractErrorHint(result);
    if (hint) bits.push(theme.fg("error", hint));
  }
  if (!options.expanded) {
    const key = keyText("app.tools.expand") || "ctrl+o";
    bits.push(theme.fg("accent", `${key} to expand`));
  }
  return bits.length > 0 ? `  ${bits.join(theme.fg("muted", " · "))}` : "";
}

const COLLAPSED_ACTIVITY_LIMIT = 3;

function displayNestedToolName(name: string): string {
  if (name.includes("_") || name.length === 0) return name;
  return `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

function buildCollapsedToolActivity(details: SubAgentRenderDetails, theme: Theme): string[] {
  const history = details.toolHistory ?? [];
  if (history.length === 0) return [];

  const displayEntries = history.slice(-COLLAPSED_ACTIVITY_LIMIT);
  const skipped = history.length - displayEntries.length;
  const lines: string[] = [];
  for (const entry of displayEntries) {
    const summary = entry.summary ? `(${theme.fg("muted", entry.summary)})` : "";
    lines.push(`  ${theme.fg("toolTitle", displayNestedToolName(entry.name))}${summary}`);
    lines.push(
      entry.endMs === undefined
        ? `  ${theme.fg("muted", "Running…")}`
        : `  ${theme.fg("muted", formatDuration(entry.endMs - entry.startMs))}`,
    );
  }
  if (skipped > 0) {
    const key = keyText("app.tools.expand") || "ctrl+o";
    const noun = skipped === 1 ? "tool use" : "tool uses";
    lines.push(
      `  ${theme.fg("muted", `… +${skipped} ${noun}`)} ${theme.fg("accent", `(${key} to expand)`)}`,
    );
  }
  return lines;
}

/** Build expanded body sections: Tool Activity timeline + Output + Footer. */
function buildExpandedBody(
  result: RenderResult,
  details: SubAgentRenderDetails,
  options: RenderOptions,
  theme: Theme,
): string[] {
  const lines: string[] = [];

  // Tool Activity section
  if (details.toolHistory && details.toolHistory.length > 0) {
    const history = details.toolHistory;
    const displayEntries =
      history.length > MAX_DISPLAY_HISTORY ? history.slice(-MAX_DISPLAY_HISTORY) : history;
    const skipped = history.length - displayEntries.length;

    lines.push("");
    lines.push(`  ${theme.bold(theme.fg("toolTitle", "📋 Tool Activity"))}`);
    if (skipped > 0) {
      lines.push(theme.fg("muted", `    [+${skipped} earlier calls]`));
    }
    for (const entry of displayEntries) {
      const done = entry.endMs !== undefined;
      const icon = done ? theme.fg("success", "✓") : theme.fg("accent", "▸");
      const dur = done
        ? theme.fg("muted", `(${formatDuration(entry.endMs! - entry.startMs)})`)
        : theme.fg("accent", "(running…)");
      const hint = entry.summary ? ` ${theme.fg("muted", entry.summary)}` : "";
      lines.push(`    ${icon} ${theme.fg("toolTitle", entry.name)}${hint} ${dur}`);
    }
  }

  // Output section
  const finalText = !options.isPartial ? getResultText(result) : "";
  const previewText = options.isPartial ? (details.outputPreview ?? "") : "";
  const bodyText = options.isPartial ? previewText : finalText;
  if (bodyText) {
    lines.push("");
    lines.push(`  ${theme.bold(theme.fg("toolTitle", "📝 Output"))}`);
    for (const textLine of bodyText.split("\n")) {
      lines.push(`    ${theme.fg("toolOutput", textLine)}`);
    }
  } else if (options.isPartial) {
    lines.push("");
    lines.push(`  ${theme.bold(theme.fg("toolTitle", "📝 Output"))}`);
    lines.push(`    ${theme.fg("muted", "(no output captured yet)")}`);
  }

  // Footer
  const footerBits: string[] = [];
  if (details.model) footerBits.push(theme.fg("muted", details.model));
  const toolMix = aggregateToolHistory(details.toolHistory);
  if (toolMix) footerBits.push(theme.fg("muted", `Tools: ${toolMix}`));
  if (details.usage && typeof details.usage.cost === "number" && details.usage.cost > 0) {
    footerBits.push(theme.fg("muted", formatCost(details.usage.cost)));
  }
  if (footerBits.length > 0) {
    lines.push("");
    lines.push(`  ${footerBits.join(theme.fg("muted", " · "))}`);
  }

  return lines;
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
 *
 * @param display - Collapsed display density: "full" (identity + metrics + tool activity),
 *   "compact" (identity + metrics only), or "minimal" (identity line only).
 */
export function buildSubAgentRenderResult(display: "full" | "compact" | "minimal" = "full") {
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
    rebuildSubAgentResultComponent(component, result, options, state, theme, true, display);
    component.invalidate();
    // One continuous frame: the lightweight call line above carries the agent
    // identity, so the result body renders seam-style beneath it.
    return renderLightweightToolResult(theme, component, {
      live: isLive,
    });
  };
}
