import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isBoxedToolCallsEnabled } from "./boxed-config.js";
import { boxedExpandHint, renderBoxedToolResult } from "./boxed-render.js";
import { getTextOutput } from "./tool-output.js";

export interface ToolResultStats {
  readonly summary: string;
  readonly fullText?: string;
}

interface RenderableResult {
  readonly content: ReadonlyArray<{ type: string; text?: string }>;
  readonly details?: unknown;
}

/**
 * Build an enhanced renderResult function for extension tools.
 * Adds boxed ✓/✗ status, partial state support, and expandable full output.
 */
export function buildStatsRenderResult(opts: { readonly partial: string }) {
  return (
    result: RenderableResult,
    options: { readonly expanded: boolean; readonly isPartial?: boolean },
    theme: Theme,
    context?: { readonly isError?: boolean },
  ) => {
    if (!isBoxedToolCallsEnabled()) {
      return renderUnboxedStatsResult(result, options, theme, context, opts.partial);
    }

    if (options.isPartial) {
      return renderBoxedToolResult(theme, new Text(theme.fg("muted", opts.partial), 0, 0), {
        isPartial: true,
        seamTop: true,
        bgToken: "toolPendingBg",
      });
    }

    const stats = result.details as ToolResultStats | undefined;
    const fullText = stats?.fullText || getTextOutput(result);
    const summary = stats?.summary || "";
    const isError = context?.isError ?? false;

    const resultBg = isError ? "toolErrorBg" : "toolSuccessBg";

    if (options.expanded) {
      return renderBoxedToolResult(
        theme,
        new Text(theme.fg(isError ? "error" : "toolOutput", fullText), 0, 0),
        {
          isError,
          seamTop: true,
          bgToken: resultBg,
        },
      );
    }

    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const parts: string[] = [icon];
    if (summary) parts.push(theme.fg(isError ? "error" : "muted", summary));
    parts.push(boxedExpandHint(theme));
    return renderBoxedToolResult(theme, new Text(parts.join(theme.fg("muted", " · ")), 0, 0), {
      isError,
      seamTop: true,
      bgToken: resultBg,
    });
  };
}

export function renderStatsResult(
  result: RenderableResult,
  options: { expanded: boolean },
  theme: Theme,
) {
  if (!isBoxedToolCallsEnabled()) {
    return renderUnboxedStatsResult(result, options, theme);
  }

  const stats = result.details as ToolResultStats | undefined;
  const fullText = stats?.fullText || getTextOutput(result);
  const summary = stats?.summary || "";
  if (options.expanded) {
    return renderBoxedToolResult(theme, new Text(theme.fg("toolOutput", fullText), 0, 0));
  }
  return renderBoxedToolResult(
    theme,
    new Text(
      [summary ? theme.fg("muted", summary) : "", boxedExpandHint(theme)]
        .filter(Boolean)
        .join(theme.fg("muted", " · ")),
      0,
      0,
    ),
  );
}

function renderUnboxedStatsResult(
  result: RenderableResult,
  options: { readonly expanded: boolean; readonly isPartial?: boolean },
  theme: Theme,
  context?: { readonly isError?: boolean },
  partialLabel?: string,
) {
  if (options.isPartial) {
    return new Text(theme.fg("muted", partialLabel ?? "Working..."), 0, 0);
  }

  const stats = result.details as ToolResultStats | undefined;
  const fullText = stats?.fullText || getTextOutput(result);
  const summary = stats?.summary || "";
  const isError = context?.isError ?? false;

  if (options.expanded) {
    return new Text(theme.fg(isError ? "error" : "toolOutput", fullText), 0, 0);
  }

  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const parts: string[] = [icon];
  if (summary) parts.push(theme.fg(isError ? "error" : "muted", summary));
  parts.push(boxedExpandHint(theme));
  return new Text(parts.join(theme.fg("muted", " · ")), 0, 0);
}
