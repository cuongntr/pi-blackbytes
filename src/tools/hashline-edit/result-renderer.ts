import { type Theme, keyText } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isBoxedToolCallsEnabled } from "../_shared/boxed-config.js";
import { renderBoxedToolResult } from "../_shared/boxed-render.js";
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
const BOXED_RESULT_BASE = { seamTop: true, bgToken: "toolPendingBg" } as const;
const BOXED_RESULT_SUCCESS = { seamTop: true, bgToken: "toolSuccessBg" } as const;
const BOXED_RESULT_ERROR = { seamTop: true, bgToken: "toolErrorBg" } as const;

export function renderHashlineEditResult(
  result: RenderableResult,
  options: RenderOptions,
  theme: Theme,
  context?: RenderContext,
) {
  if (options.isPartial) {
    const text = new Text(theme.fg("muted", PARTIAL_LABEL), 0, 0);
    return isBoxedToolCallsEnabled()
      ? renderBoxedToolResult(theme, text, {
          ...BOXED_RESULT_BASE,
          isPartial: true,
        })
      : text;
  }

  const details = (result.details as DetailsShape | undefined) ?? undefined;
  const summary = details?.summary ?? "";
  const fullText = details?.fullText ?? getContentText(result);
  const isError = context?.isError ?? false;

  const resultBase = isError ? BOXED_RESULT_ERROR : BOXED_RESULT_SUCCESS;

  if (!options.expanded) {
    const text = renderCollapsed(summary, isError, theme);
    return isBoxedToolCallsEnabled()
      ? renderBoxedToolResult(theme, text, { ...resultBase, isError })
      : text;
  }

  if (isError) {
    const text = new Text(theme.fg("error", fullText), 0, 0);
    return isBoxedToolCallsEnabled()
      ? renderBoxedToolResult(theme, text, { ...resultBase, isError })
      : text;
  }

  if (!details?.diffData || details.diffData.ranges.length === 0) {
    const text = new Text(theme.fg("toolOutput", fullText), 0, 0);
    return isBoxedToolCallsEnabled() ? renderBoxedToolResult(theme, text, resultBase) : text;
  }

  const text = renderExpandedDiff(summary, details.diffData, options.width, theme);
  return isBoxedToolCallsEnabled() ? renderBoxedToolResult(theme, text, resultBase) : text;
}

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
