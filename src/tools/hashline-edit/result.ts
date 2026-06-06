import type { ToolResultStats } from "../_shared/stats-render.js";
import { type DiffData, computeChangedRanges, renderEditPreview } from "./diff-preview.js";

export interface SuccessResult {
  success: true;
  message: string;
  diffData?: DiffData;
}

export interface ErrorResult {
  success: false;
  error: string;
}

export type ToolResult = SuccessResult | ErrorResult;

const HASHLINE_ERROR_COMPACT_CHARS = 1_200;
const HASHLINE_ERROR_SUMMARY_CHARS = 160;
const HASHLINE_ERROR_COMPACT_MARKER =
  "\n\n[Output shortened. Expand the tool result with ctrl+o for full details.]\n\n";

function compactHashlineError(error: string): string {
  if (error.length <= HASHLINE_ERROR_COMPACT_CHARS) return error;

  const keepChars = Math.max(
    0,
    HASHLINE_ERROR_COMPACT_CHARS - HASHLINE_ERROR_COMPACT_MARKER.length,
  );
  const headChars = Math.ceil(keepChars / 2);
  const tailChars = keepChars - headChars;
  const head = error.slice(0, headChars).trimEnd();
  const tail = tailChars > 0 ? error.slice(-tailChars).trimStart() : "";
  return `${head}${HASHLINE_ERROR_COMPACT_MARKER}${tail}`;
}

function summarizeHashlineError(error: string): string {
  const firstLine = error.split("\n", 1)[0]?.trim() || "hashline_edit failed";
  if (firstLine.length <= HASHLINE_ERROR_SUMMARY_CHARS) return firstLine;
  return `${firstLine.slice(0, HASHLINE_ERROR_SUMMARY_CHARS - 1)}…`;
}

export function buildSuccessResult(
  baseMessage: string,
  oldLines: string[],
  newLines: string[],
): SuccessResult {
  const ranges = computeChangedRanges(oldLines, newLines);
  if (ranges.length === 0) {
    return { success: true, message: baseMessage };
  }
  const preview = renderEditPreview(newLines, ranges);
  return {
    success: true,
    message: preview ? `${baseMessage}\n\n${preview}` : baseMessage,
    diffData: { ranges },
  };
}

export function buildHashlineErrorResult(error: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  details: ToolResultStats;
} {
  const compact = compactHashlineError(error);
  return {
    isError: true,
    content: [{ type: "text", text: compact }],
    details: {
      summary: summarizeHashlineError(error),
      fullText: error,
    } satisfies ToolResultStats,
  };
}
