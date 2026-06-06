import { parseAnchor, rangeForEdit } from "./anchors.js";
import { ERROR_CODES, formatError, stripLineIdPrefixLegacy, validateLines } from "./errors.js";
import type { Edit } from "./schema.js";

export function detectOverlappingReplaceRanges(edits: Edit[]): string | null {
  const ranges = edits
    .map((edit, index) => {
      const range = rangeForEdit(edit);
      return range ? { ...range, index } : null;
    })
    .filter((range): range is { start: number; end: number; index: number } => range !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1];
    const curr = ranges[i];
    if (curr.start <= prev.end) {
      return `Overlapping replace edits detected: edit ${prev.index + 1} (lines ${prev.start}-${prev.end}) overlaps edit ${curr.index + 1} (lines ${curr.start}-${curr.end})`;
    }
  }
  return null;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. Empty needle returns 0. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  // split-based count is O(n) and handles non-overlapping matches correctly
  return haystack.split(needle).length - 1;
}

/** Return the 1-based line numbers where the first `limit` occurrences of `needle` start. */
export function locateOccurrenceLines(haystack: string, needle: string, limit: number): number[] {
  const lines: number[] = [];
  let pos = 0;
  while (lines.length < limit) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    // line number = 1 + count of \n before idx
    let line = 1;
    for (let i = 0; i < idx; i++) if (haystack.charCodeAt(i) === 10) line++;
    lines.push(line);
    pos = idx + needle.length;
  }
  return lines;
}

/**
 * Detect overlap between text-edit match spans and anchored-edit line ranges.
 * Returns a human-readable description of the first overlap, or null.
 *
 * Text-edit span: [line of first char of oldText, line of last char of oldText].
 * Anchored span: [pos.line, end.line ?? pos.line] for replace; pos.line only
 * for append/prepend (treated as zero-width).
 */
export function detectTextAnchorOverlap(allEdits: Edit[], fileLines: string[]): string | null {
  const haystack = fileLines.join("\n");
  const textSpans: Array<{ idx: number; start: number; end: number }> = [];
  for (let i = 0; i < allEdits.length; i++) {
    const e = allEdits[i];
    if (e.op !== "replace_text") continue;
    const old = e.oldText ?? "";
    if (old === "") continue;
    const at = haystack.indexOf(old);
    if (at === -1) continue; // will be caught later as E_NO_MATCH
    let startLine = 1;
    for (let k = 0; k < at; k++) if (haystack.charCodeAt(k) === 10) startLine++;
    let endLine = startLine;
    for (let k = at; k < at + old.length; k++) if (haystack.charCodeAt(k) === 10) endLine++;
    textSpans.push({ idx: i, start: startLine, end: endLine });
  }
  if (textSpans.length === 0) return null;

  for (let i = 0; i < allEdits.length; i++) {
    const e = allEdits[i];
    if (e.op === "replace_text") continue;
    if (!e.pos) continue;
    const posParsed = parseAnchor(e.pos);
    if (!posParsed) continue;
    const start = posParsed.lineNum;
    const endParsed = e.end ? parseAnchor(e.end) : null;
    const end = endParsed ? endParsed.lineNum : start;
    for (const span of textSpans) {
      if (span.end >= start && span.start <= end) {
        return `edits[${span.idx}] (replace_text, lines ${span.start}-${span.end}) overlaps edits[${i}] (${e.op}, lines ${start}-${end})`;
      }
    }
  }
  return null;
}

/**
 * Normalise alias ops introduced in T8 to canonical ops.
 *
 * `insert_after` → `append` (anchored: pos required)
 * `insert_before` → `prepend` (anchored: pos required)
 * `replace_range` → `replace` (anchored: pos AND end required)
 *
 * Returns the canonical edit on success, or an error string on validation
 * failure (missing required anchor on an alias). Canonical ops pass through
 * unchanged.
 */
export function normalizeEdit(edit: Edit, index: number): Edit | { error: string } {
  switch (edit.op) {
    case "insert_after":
      if (!edit.pos) {
        return {
          error: formatError(
            ERROR_CODES.E_BAD_REF,
            `edits[${index}].insert_after requires a 'pos' anchor (use 'append' without pos for EOF inserts)`,
          ),
        };
      }
      return { ...edit, op: "append" };
    case "insert_before":
      if (!edit.pos) {
        return {
          error: formatError(
            ERROR_CODES.E_BAD_REF,
            `edits[${index}].insert_before requires a 'pos' anchor (use 'prepend' without pos for BOF inserts)`,
          ),
        };
      }
      return { ...edit, op: "prepend" };
    case "replace_range":
      if (!edit.pos || !edit.end) {
        return {
          error: formatError(
            ERROR_CODES.E_BAD_REF,
            `edits[${index}].replace_range requires both 'pos' and 'end' anchors`,
          ),
        };
      }
      return { ...edit, op: "replace" };
    default:
      return edit;
  }
}

export function normalizeLines(
  input: string | string[] | null | undefined,
  strictPatch: boolean,
): string[] | null | { error: string } {
  if (input === null || input === undefined) return null;
  const arr = Array.isArray(input) ? input : [input];
  if (strictPatch) {
    const problem = validateLines(arr);
    if (problem) {
      return {
        error: formatError(
          ERROR_CODES.E_INVALID_PATCH,
          `lines[${problem.index}] starts with a LINE#ID prefix, which should not be included in patch content`,
          `Offending line: ${problem.preview}\n\nHint: drop the leading "LINE#ID|" — the tool only expects raw content. To restore the legacy silent-strip behaviour, set hashline_edit.strict_patch=false in ~/.pi/agent/settings.json.`,
        ),
      };
    }
    return arr;
  }
  return arr.map(stripLineIdPrefixLegacy);
}
