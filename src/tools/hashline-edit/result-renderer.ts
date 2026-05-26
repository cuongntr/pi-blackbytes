import { type Theme, keyText } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { DiffData } from "./diff-preview.js";

interface RenderableResult {
  readonly content: ReadonlyArray<{ type: string; text?: string }>;
  readonly details?: unknown;
}

interface RenderOptions {
  readonly expanded: boolean;
  readonly isPartial?: boolean;
  readonly width?: number;
}

interface RenderContext {
  readonly isError?: boolean;
}

interface DetailsShape {
  readonly summary?: string;
  readonly fullText?: string;
  readonly diffData?: DiffData;
}

const PARTIAL_LABEL = "Editing...";

/**
 * Renderer for `hashline_edit` tool results.
 *
 * - Partial (running): muted `Editing...` (preserves the legacy
 *   `buildStatsRenderResult({ partial: "Editing..." })` behaviour).
 * - Collapsed (success): `✓ <summary> · ctrl+o to expand`.
 * - Collapsed (error): `✗ <summary> · ctrl+o to expand`.
 * - Expanded (success with diffData): header + blank line + inline diff
 *   rendered with `▌- ` / `▌+ ` gutter markers in error / success colours.
 *   Falls back to plain `fullText` when no `diffData` is present (e.g.
 *   delete, rename-only, or a no-op edit).
 * - Expanded (error): plain `fullText` in the standard error colour.
 */
export function renderHashlineEditResult(
  result: RenderableResult,
  options: RenderOptions,
  theme: Theme,
  context?: RenderContext,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("muted", PARTIAL_LABEL), 0, 0);
  }

  const details = (result.details as DetailsShape | undefined) ?? undefined;
  const summary = details?.summary ?? "";
  const fullText = details?.fullText ?? getContentText(result);
  const isError = context?.isError ?? false;

  if (!options.expanded) {
    return renderCollapsed(summary, isError, theme);
  }

  // Expanded path
  if (isError) {
    return new Text(theme.fg("error", fullText), 0, 0);
  }

  if (!details?.diffData || details.diffData.ranges.length === 0) {
    // No structured diff — show full text as-is.
    return new Text(theme.fg("toolOutput", fullText), 0, 0);
  }

  return renderExpandedDiff(summary, details.diffData, options.width, theme);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function renderCollapsed(summary: string, isError: boolean, theme: Theme): Text {
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const parts: string[] = [icon];
  if (summary) parts.push(theme.fg(isError ? "error" : "muted", summary));
  const key = keyText("app.tools.expand") || "ctrl+o";
  parts.push(theme.fg("accent", `${key} to expand`));
  return new Text(parts.join(theme.fg("muted", " · ")), 0, 0);
}

function renderExpandedDiff(
  summary: string,
  diffData: DiffData,
  width: number | undefined,
  theme: Theme,
): Text {
  const lines: string[] = [];
  const icon = theme.fg("success", "✓");
  lines.push(`${icon} ${theme.fg("muted", summary)}`);
  lines.push("");
  for (let r = 0; r < diffData.ranges.length; r++) {
    if (r > 0) lines.push("");
    const range = diffData.ranges[r];
    for (const old of range.oldLines) {
      const clamped = clampToWidth(old, width);
      lines.push(theme.fg("error", `▌- ${clamped}`));
    }
    for (const added of range.newLines) {
      const clamped = clampToWidth(added, width);
      lines.push(theme.fg("success", `▌+ ${clamped}`));
    }
  }
  return new Text(lines.join("\n"), 0, 0);
}

/**
 * Truncate a line so it fits within `width` columns, accounting for the
 * 3-character `▌- ` / `▌+ ` gutter prefix. No wrap, no ANSI awareness in v1.
 *
 * Local helper (10 lines) because `clampLinesToWidth` is NOT exported from
 * `src/sub-agents/format.ts` (verified during spec polish).
 */
export function clampToWidth(line: string, width: number | undefined): string {
  const GUTTER = 3;
  if (!width || width <= GUTTER + 1) return line;
  const budget = width - GUTTER;
  if (line.length <= budget) return line;
  return `${line.slice(0, budget - 1)}…`;
}

function getContentText(result: RenderableResult): string {
  return result.content
    .filter(
      (p): p is { type: string; text: string } => p.type === "text" && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("");
}
