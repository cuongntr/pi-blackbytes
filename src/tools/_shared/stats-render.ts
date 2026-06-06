import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { lightweightExpandHint, renderLightweightToolResult } from "./lightweight-render.js";
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
 * Adds ✓/✗ status, partial state support, and expandable full output.
 */
export function buildStatsRenderResult(opts: { readonly partial: string }) {
  return (
    result: RenderableResult,
    options: { readonly expanded: boolean; readonly isPartial?: boolean },
    theme: Theme,
    context?: { readonly isError?: boolean },
  ) => {
    if (options.isPartial) {
      return renderLightweightToolResult(theme, new Text(theme.fg("muted", opts.partial), 0, 0), {
        isPartial: true,
      });
    }

    const stats = result.details as ToolResultStats | undefined;
    const fullText = stats?.fullText || getTextOutput(result);
    const summary = stats?.summary || "";
    const isError = context?.isError ?? false;

    if (options.expanded) {
      return renderLightweightToolResult(
        theme,
        new Text(theme.fg(isError ? "error" : "toolOutput", fullText), 0, 0),
        { isError },
      );
    }

    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const parts: string[] = [icon];
    if (summary) parts.push(theme.fg(isError ? "error" : "muted", summary));
    parts.push(lightweightExpandHint(theme));
    return renderLightweightToolResult(
      theme,
      new Text(parts.join(theme.fg("muted", " · ")), 0, 0),
      { isError },
    );
  };
}
