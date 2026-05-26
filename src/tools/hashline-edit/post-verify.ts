import { readFileSync } from "node:fs";

export interface VerifyOk {
  ok: true;
}

export interface VerifyMismatch {
  ok: false;
  /** Compact diff context (~200 chars) around the first divergence point. */
  diffContext: string;
}

export type VerifyResult = VerifyOk | VerifyMismatch;

const DIFF_WINDOW = 80;

/**
 * Read the file back from disk and compare byte-for-byte against the bytes
 * the caller intended to write. The comparison is against the SAME post-
 * BOM/CRLF-restoration string passed to `writeFileAtomically`, so encoding
 * round-trip is part of the check.
 *
 * On mismatch, returns a compact context block locating the first divergence
 * (line/column) plus a short window of bytes on each side so the human can
 * spot what went wrong without printing the entire file.
 *
 * `readFn` is an injectable seam used only by tests — production callers omit
 * it and the default `fs.readFileSync` is used.
 */
export function verifyPersistedContent(
  canonicalPath: string,
  intendedResult: string,
  readFn: (path: string) => string = (p) => readFileSync(p, "utf8"),
): VerifyResult {
  const actual = readFn(canonicalPath);
  if (actual === intendedResult) return { ok: true };
  return { ok: false, diffContext: buildDiffContext(intendedResult, actual) };
}

function buildDiffContext(intended: string, actual: string): string {
  const divergeAt = firstDivergenceIndex(intended, actual);
  const { line, column } = locateLineColumn(intended, divergeAt);
  const intendedWin = sliceWindow(intended, divergeAt, DIFF_WINDOW);
  const actualWin = sliceWindow(actual, divergeAt, DIFF_WINDOW);
  return [
    `First divergence at line ${line}, column ${column} (byte offset ${divergeAt})`,
    `Intended: ${intendedWin}`,
    `Actual  : ${actualWin}`,
    `Intended length: ${intended.length}, actual length: ${actual.length}`,
  ].join("\n");
}

function firstDivergenceIndex(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  }
  return n; // one is a prefix of the other
}

function locateLineColumn(s: string, idx: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < idx && i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function sliceWindow(s: string, idx: number, radius: number): string {
  const start = Math.max(0, idx - radius);
  const end = Math.min(s.length, idx + radius);
  // Escape newlines/CR for single-line display
  return JSON.stringify(s.slice(start, end));
}
