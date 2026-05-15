import { type Theme, keyText } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export interface ToolResultStats {
  readonly summary: string;
  readonly fullText?: string;
}

interface RenderableResult {
  readonly content: ReadonlyArray<{ type: string; text?: string }>;
  readonly details?: unknown;
}

interface RenderOptions {
  readonly expanded: boolean;
}

function getContentText(result: RenderableResult): string {
  return result.content
    .filter(
      (p): p is { type: string; text: string } => p.type === "text" && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("");
}

/**
 * Build an enhanced renderResult function for extension tools.
 * Adds ✓/✗ status icon and partial (running) state support.
 */
export function buildStatsRenderResult(opts: { readonly partial: string }) {
  return (
    result: RenderableResult,
    options: { readonly expanded: boolean; readonly isPartial?: boolean },
    theme: Theme,
    context?: { readonly isError?: boolean },
  ): Text => {
    if (options.expanded) {
      const fullText =
        (result.details as ToolResultStats | undefined)?.fullText || getContentText(result);
      return new Text(theme.fg("toolOutput", fullText), 0, 0);
    }

    if (options.isPartial) {
      return new Text(theme.fg("muted", opts.partial), 0, 0);
    }

    // Collapsed: "✓ summary · ctrl+o to expand" or "✗ summary · ctrl+o to expand"
    const stats = result.details as ToolResultStats | undefined;
    const summary = stats?.summary || "";
    const isError = context?.isError ?? false;
    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

    const parts: string[] = [icon];
    if (summary) parts.push(theme.fg(isError ? "error" : "muted", summary));

    const key = keyText("app.tools.expand") || "ctrl+o";
    parts.push(theme.fg("accent", `${key} to expand`));

    return new Text(parts.join(theme.fg("muted", " · ")), 0, 0);
  };
}

export function renderStatsResult(
  result: RenderableResult,
  options: RenderOptions,
  theme: Theme,
): Text {
  if (options.expanded) {
    const fullText =
      (result.details as ToolResultStats | undefined)?.fullText || getContentText(result);
    return new Text(theme.fg("toolOutput", fullText), 0, 0);
  }

  const stats = result.details as ToolResultStats | undefined;
  const summary = stats?.summary || "";
  const parts: string[] = [];
  if (summary) parts.push(theme.fg("muted", summary));

  const key = keyText("app.tools.expand") || "ctrl+o";
  parts.push(theme.fg("accent", `${key} to expand`));

  return new Text(parts.join(theme.fg("muted", " · ")), 0, 0);
}
