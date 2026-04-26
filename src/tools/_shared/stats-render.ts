import { type Theme, keyText } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

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
