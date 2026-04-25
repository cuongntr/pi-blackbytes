import { type Theme, keyText } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

export interface CompactResultDetails {
  readonly fullText?: string;
  readonly fullChars?: number;
  readonly omittedChars?: number;
}

interface RenderableTextResult {
  readonly content: ReadonlyArray<{ type: string; text?: string }>;
  readonly details?: CompactResultDetails;
}

interface RenderOptions {
  readonly expanded: boolean;
  readonly isPartial?: boolean;
}

function getText(result: RenderableTextResult): string {
  return result.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function compactText(fullText: string, maxChars: number): string {
  if (fullText.length <= maxChars) return fullText;
  const marker = "\n\n[Output shortened. Expand the tool result with ctrl+o for full details.]";
  return `${fullText.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`;
}

export function compactDetails(fullText: string, compactTextValue: string): CompactResultDetails {
  return {
    fullText,
    fullChars: fullText.length,
    omittedChars: Math.max(0, fullText.length - compactTextValue.length),
  };
}

export function renderCompactResult(
  result: RenderableTextResult,
  options: RenderOptions,
  theme: Theme,
): Text {
  const summary = getText(result);
  const details = result.details;
  const fullText = details?.fullText;

  if (options.expanded && fullText) {
    return new Text(theme.fg("toolOutput", fullText), 0, 0);
  }

  let text = theme.fg("toolOutput", summary);
  if (!options.expanded && fullText && fullText !== summary) {
    const key = keyText("app.tools.expand") || "ctrl+o";
    const fullChars = details.fullChars ?? fullText.length;
    text += theme.fg(
      "accent",
      `\n\n${key} to expand full output (${fullChars.toLocaleString("en-US")} chars)`,
    );
  }
  return new Text(text, 0, 0);
}
