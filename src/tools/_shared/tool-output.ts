import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface RenderableTextResult {
  readonly content?: ReadonlyArray<{ type: string; text?: string }>;
  readonly details?: unknown;
}

const DEFAULT_MAX_LINE_CHARS = 2000;
const TRUNCATION_NOTICE_RE = /^\[Showing (?:last|lines)\b.*\. Full output: .+\]$/;

export function getTextOutput(result: RenderableTextResult | undefined): string {
  if (!result?.content) return "";
  return result.content
    .filter((block): block is { type: string; text: string } => {
      return block.type === "text" && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("")
    .replace(/\r/g, "");
}

export function countLines(text: string): number {
  const normalized = text.replace(/\r/g, "").replace(/\n+$/g, "");
  if (!normalized) return 0;
  return normalized.split("\n").length;
}

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}_'-]+/gu)?.length ?? 0;
}

export function formatApproxWords(text: string): string {
  const words = countWords(text);
  if (words < 1000) return `✎ ~${words} words`;
  if (words < 10_000) return `✎ ~${(words / 1000).toFixed(1)}k words`;
  return `✎ ~${Math.round(words / 1000)}k words`;
}

export function clampLine(line: string, maxChars = DEFAULT_MAX_LINE_CHARS): string {
  if (maxChars <= 0) return "";
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 14))}… (truncated)`;
}

export function stripTrailingNoticeLines(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !TRUNCATION_NOTICE_RE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function tailPreview(
  text: string,
  maxLines: number,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
): {
  readonly lines: string[];
  readonly omittedLines: number;
} {
  if (maxLines <= 0 || !text) return { lines: [], omittedLines: countLines(text) };

  const normalized = stripTrailingNoticeLines(text);
  if (!normalized) return { lines: [], omittedLines: 0 };

  let seen = 0;
  let start = 0;
  for (let i = normalized.length - 1; i >= 0; i--) {
    if (normalized.charCodeAt(i) === 10) {
      seen++;
      if (seen === maxLines) {
        start = i + 1;
        break;
      }
    }
  }

  const omittedLines = start > 0 ? countLines(normalized.slice(0, start)) : 0;
  const lines = normalized
    .slice(start)
    .split("\n")
    .filter((line, index, arr) => !(index === arr.length - 1 && line === ""))
    .map((line) => clampLine(line, maxLineChars));
  return { lines, omittedLines };
}

export function headTailPreview(
  text: string,
  maxLines: number,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
): {
  readonly headLines: string[];
  readonly tailLines: string[];
  readonly omittedLines: number;
} {
  const normalized = stripTrailingNoticeLines(text);
  if (!normalized || maxLines <= 0) {
    return { headLines: [], tailLines: [], omittedLines: countLines(normalized) };
  }

  const all = normalized.split("\n").map((line) => clampLine(line, maxLineChars));
  if (all.length <= maxLines) {
    return { headLines: all, tailLines: [], omittedLines: 0 };
  }

  const headCount = Math.ceil(maxLines / 2);
  const tailCount = Math.floor(maxLines / 2);
  return {
    headLines: all.slice(0, headCount),
    tailLines: tailCount > 0 ? all.slice(-tailCount) : [],
    omittedLines: all.length - maxLines,
  };
}

export function expandedPreview(
  text: string,
  maxLines: number,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
): {
  readonly lines: string[];
  readonly omittedLines: number;
} {
  const normalized = stripTrailingNoticeLines(text);
  if (!normalized || maxLines <= 0) return { lines: [], omittedLines: countLines(normalized) };
  const all = normalized.split("\n").map((line) => clampLine(line, maxLineChars));
  if (all.length <= maxLines) return { lines: all, omittedLines: 0 };
  return { lines: all.slice(0, maxLines), omittedLines: all.length - maxLines };
}

export function textFromAgentResult(result: AgentToolResult<unknown> | undefined): string {
  return getTextOutput(result as RenderableTextResult | undefined);
}
