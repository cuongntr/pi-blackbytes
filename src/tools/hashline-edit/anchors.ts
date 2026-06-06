import { computeCID } from "../../utils/cid.js";
import type { Edit } from "./schema.js";

const ANCHOR_RE = /^(\d+)#([ZPMQVRWSNKTXJBYH]{2})$/;

export function parseAnchor(anchor: string): { lineNum: number; cid: string } | null {
  const m = ANCHOR_RE.exec(anchor.trim());
  if (!m) return null;
  return { lineNum: Number.parseInt(m[1], 10), cid: m[2] };
}

export function rangeForEdit(edit: Edit): { start: number; end: number } | null {
  if (edit.op !== "replace" || !edit.pos) return null;
  const start = parseAnchor(edit.pos)?.lineNum;
  const end = edit.end ? parseAnchor(edit.end)?.lineNum : start;
  if (start === undefined || end === undefined) return null;
  return { start, end };
}

/** Format a file's lines into LINE#ID annotated text for error messages. */
export function annotateLines(lines: string[]): string {
  return lines
    .map((line, idx) => {
      const lineNum = idx + 1;
      const cid = computeCID(lineNum, line);
      return `${lineNum}#${cid}|${line}`;
    })
    .join("\n");
}

export function annotateLineContext(lines: string[], centerLine: number, radius = 3): string {
  const start = Math.max(1, centerLine - radius);
  const end = Math.min(lines.length, centerLine + radius);
  return annotateLines(lines.slice(start - 1, end));
}
