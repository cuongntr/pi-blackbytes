import { computeCID } from "../../utils/cid.js";

/**
 * Default context lines on each side of a changed range when rendering
 * Updated anchors. Matches `git diff -U3` convention.
 */
export const DEFAULT_CONTEXT_RADIUS = 3;

/**
 * Maximum number of diff lines (sum of `-` and `+` lines across all ranges)
 * to keep before truncating with a middle-cut elision marker.
 */
export const MAX_DIFF_LINES = 50;

/**
 * A single changed region, expressed in both the pre-edit (`old*`) and
 * post-edit (`new*`) coordinate systems. Both bounds are inclusive and
 * 1-based; an empty range (pure-insert or pure-delete on one side) uses
 * `start = end + 1` with an empty slice.
 */
export interface ChangedRange {
  oldStart: number;
  oldEnd: number;
  oldLines: string[];
  newStart: number;
  newEnd: number;
  newLines: string[];
}

/**
 * Structured diff payload exposed via `details.diffData`. Consumed by the
 * TUI renderer (T9) to show an inline diff in expanded view without
 * re-deriving from the assistant text.
 */
export interface DiffData {
  ranges: ChangedRange[];
}

/**
 * Compute changed ranges between `oldLines` and `newLines` using a simple
 * prefix/suffix trim. Returns a single coarse range covering everything
 * between the longest common prefix and longest common suffix.
 *
 * Rationale: we do NOT run LCS / Myers. The spec calls for ranges derived
 * from edits, but a snapshot-based prefix/suffix trim is also deterministic,
 * O(N+M), and adequate for v1. Multi-range splitting on identical interior
 * runs is a future enhancement (tracked in spec § Risks).
 */
export function computeChangedRanges(oldLines: string[], newLines: string[]): ChangedRange[] {
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldChangedLen = oldLines.length - prefix - suffix;
  const newChangedLen = newLines.length - prefix - suffix;

  if (oldChangedLen <= 0 && newChangedLen <= 0) {
    return [];
  }

  const oldSlice = oldLines.slice(prefix, prefix + oldChangedLen);
  const newSlice = newLines.slice(prefix, prefix + newChangedLen);

  return [
    {
      oldStart: prefix + 1,
      oldEnd: prefix + oldChangedLen,
      oldLines: oldSlice,
      newStart: prefix + 1,
      newEnd: prefix + newChangedLen,
      newLines: newSlice,
    },
  ];
}

/**
 * Render the "Updated anchors" block: for each changed range, emit
 * `LINE#CID|content` for the new lines plus `contextRadius` lines of
 * unchanged context on each side (when available).
 *
 * Blank line between range blocks for visual separation.
 */
export function renderUpdatedAnchors(
  newLines: string[],
  ranges: ChangedRange[],
  contextRadius: number = DEFAULT_CONTEXT_RADIUS,
): string {
  if (ranges.length === 0) return "";
  const blocks: string[] = [];
  for (const r of ranges) {
    const from = Math.max(1, r.newStart - contextRadius);
    const to = Math.min(newLines.length, r.newEnd + contextRadius);
    const lines: string[] = [];
    for (let i = from; i <= to; i++) {
      const content = newLines[i - 1];
      lines.push(`${i}#${computeCID(i, content)}|${content}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/**
 * Render the "Diff preview" block: for each changed range, emit `-` lines
 * for removed content and `+` lines for added content.
 *
 * Format choices:
 * - Removed: `- <oldLineNo>| <content>` — NO `#CID`, so the line cannot
 *   match the strict-patch regex `/^\d+#[A-Z]{2}\|/` from T1 even if a
 *   model copies the line verbatim into a later `lines` payload.
 * - Added:   `+ <newLineNo>#<CID>| <content>` — full anchor so the model
 *   can lift it directly into a follow-up edit.
 *
 * Total output is capped at `MAX_DIFF_LINES`; overflow produces a middle-cut
 * elision marker so both head and tail remain visible.
 */
export function renderDiffPreview(ranges: ChangedRange[]): string {
  if (ranges.length === 0) return "";
  const rendered: string[] = [];
  for (const r of ranges) {
    for (let i = 0; i < r.oldLines.length; i++) {
      const lineNo = r.oldStart + i;
      rendered.push(`- ${lineNo}| ${r.oldLines[i]}`);
    }
    for (let i = 0; i < r.newLines.length; i++) {
      const lineNo = r.newStart + i;
      const cid = computeCID(lineNo, r.newLines[i]);
      rendered.push(`+ ${lineNo}#${cid}| ${r.newLines[i]}`);
    }
  }
  if (rendered.length <= MAX_DIFF_LINES) {
    return rendered.join("\n");
  }
  // Middle-cut: keep head + tail, drop interior.
  const half = Math.floor(MAX_DIFF_LINES / 2);
  const head = rendered.slice(0, half);
  const tail = rendered.slice(rendered.length - half);
  const elided = rendered.length - head.length - tail.length;
  return [...head, `[… ${elided} lines elided …]`, ...tail].join("\n");
}

/**
 * Convenience: render both blocks separated by headings, suitable for
 * appending to a success message. Returns an empty string when there are
 * no changed ranges (no-op edits — rare but possible if a `replace_text`
 * substitutes identical content).
 */
export function renderEditPreview(
  newLines: string[],
  ranges: ChangedRange[],
  contextRadius: number = DEFAULT_CONTEXT_RADIUS,
): string {
  if (ranges.length === 0) return "";
  const anchors = renderUpdatedAnchors(newLines, ranges, contextRadius);
  const diff = renderDiffPreview(ranges);
  const parts: string[] = [];
  if (anchors) parts.push(`--- Updated anchors ---\n${anchors}`);
  if (diff) parts.push(`--- Diff preview ---\n${diff}`);
  return parts.join("\n\n");
}
