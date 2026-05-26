/**
 * Error code taxonomy for hashline_edit.
 *
 * Every user-facing error from the tool is formatted as `[CODE] message` (with
 * an optional `\n<context>` block) so downstream callers and prompt guidance
 * can branch on the leading code without parsing prose.
 */

export const ERROR_CODES = {
  /** Anchor string did not parse as `LINE#CID`. */
  E_BAD_REF: "E_BAD_REF",
  /** Anchor parsed, but its CID does not match the file's current content. */
  E_HASH_MISMATCH: "E_HASH_MISMATCH",
  /** Anchor's line number is outside the file's range. */
  E_OUT_OF_RANGE: "E_OUT_OF_RANGE",
  /** Payload contains shape we refuse (e.g. accidental `LINE#ID|` prefix in lines). */
  E_INVALID_PATCH: "E_INVALID_PATCH",
  /** Two or more edits target overlapping regions. */
  E_OVERLAP: "E_OVERLAP",
  /** `replace_text.oldText` produced zero matches. (Reserved by T1, wired by T4.) */
  E_NO_MATCH: "E_NO_MATCH",
  /** `replace_text.oldText` produced more than one match. (Reserved by T1, wired by T4.) */
  E_MULTI_MATCH: "E_MULTI_MATCH",
  /** Filesystem write failed (EACCES / ENOSPC / EROFS / EPERM / unexpected). */
  E_WRITE_FAILED: "E_WRITE_FAILED",
  /** Target file does not exist (read path). */
  E_NOT_FOUND: "E_NOT_FOUND",
  /** Post-write integrity check found persisted bytes != intended bytes. (Reserved by T1, wired by T7.) */
  E_VERIFY_FAILED: "E_VERIFY_FAILED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Build a canonical hashline_edit error string.
 *
 * Shape:
 *   - no context  → `"[CODE] message"`
 *   - with context → `"[CODE] message\n<context>"`
 *
 * `context` is opaque — caller controls its internal newlines.
 */
export function formatError(code: ErrorCode, message: string, context?: string): string {
  const head = `[${code}] ${message}`;
  return context ? `${head}\n${context}` : head;
}

// ---------------------------------------------------------------------------
// validateLines — strict patch rejection
// ---------------------------------------------------------------------------

/**
 * Regex that matches an accidentally-included `LINE#ID|` prefix at the start of
 * a content line, e.g. `"42#KQ|some text"`.
 *
 * The CID slot accepts any `[A-Z]{2}` — NOT just the 16-char CID alphabet —
 * because we reject on *shape*, not on alphabet membership. A line starting
 * `42#OL|...` is suspicious regardless of whether `OL` would be a valid CID.
 *
 * The diff-marker heuristic (`/^[+-] /`) is intentionally NOT included: it
 * would false-positive on legitimate Markdown bullets and prose. The
 * `LINE#ID|` prefix is by far the more common model mistake and is the only
 * signal we reject here.
 */
const LINE_ID_PREFIX_RE = /^\d+#[A-Z]{2}\|/;

export interface InvalidLineProblem {
  /** Zero-based index of the offending line inside the `lines` array. */
  index: number;
  /** The offending line, truncated for display. */
  preview: string;
}

/**
 * Return the first problem found in `lines`, or `null` if all lines are clean.
 *
 * Callers map a returned problem to `formatError("E_INVALID_PATCH", ...)`.
 *
 * Performance: O(n) over `lines`, one regex per line — no nested loops.
 */
export function validateLines(lines: readonly string[]): InvalidLineProblem | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (LINE_ID_PREFIX_RE.test(line)) {
      const preview = line.length > 120 ? `${line.slice(0, 117)}…` : line;
      return { index: i, preview };
    }
  }
  return null;
}

/**
 * Legacy behaviour: strip a `LINE#ID|` prefix from a single line.
 *
 * Retained only for the `strict_patch=false` escape hatch — callers should
 * prefer `validateLines` and reject up-front under the default strict mode.
 */
export function stripLineIdPrefixLegacy(line: string): string {
  return line.replace(LINE_ID_PREFIX_RE, "");
}
