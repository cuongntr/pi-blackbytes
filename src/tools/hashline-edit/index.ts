import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { computeCID } from "../../utils/cid.js";
import { registerTool } from "../_shared/register-tool.js";

/** Format a file's lines into LINE#ID annotated text for error messages. */
function annotateLines(lines: string[]): string {
  return lines
    .map((line, idx) => {
      const lineNum = idx + 1;
      const cid = computeCID(lineNum, line);
      return `${lineNum}#${cid}|${line}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Anchor parsing
// ---------------------------------------------------------------------------

const ANCHOR_RE = /^(\d+)#([ZPMQVRWSNKTXJBYH]{2})$/;

function parseAnchor(anchor: string): { lineNum: number; cid: string } | null {
  const m = ANCHOR_RE.exec(anchor.trim());
  if (!m) return null;
  return { lineNum: Number.parseInt(m[1], 10), cid: m[2] };
}

// ---------------------------------------------------------------------------
// Line-content autocorrect
// ---------------------------------------------------------------------------

/** Strip LINE#ID prefixes that users may accidentally include in lines. */
function stripLineIdPrefix(line: string): string {
  // Pattern: "123#AB|..." → "..."
  return line.replace(/^\d+#[A-Z]{2}\|/, "");
}

function normalizeLines(input: string | string[] | null | undefined): string[] | null {
  if (input === null || input === undefined) return null;
  const arr = Array.isArray(input) ? input : [input];
  return arr.map(stripLineIdPrefix);
}

// ---------------------------------------------------------------------------
// TypeBox schema
// ---------------------------------------------------------------------------

const EditSchema = Type.Object({
  op: Type.Union([Type.Literal("replace"), Type.Literal("append"), Type.Literal("prepend")]),
  pos: Type.Optional(Type.String({ description: "LINE#ID anchor e.g. '10#VK'" })),
  end: Type.Optional(Type.String({ description: "End LINE#ID anchor for range ops" })),
  lines: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()])),
});

type Edit = Static<typeof EditSchema>;

const HashlineEditSchema = Type.Object({
  filePath: Type.String({ description: "Absolute path to file" }),
  edits: Type.Array(EditSchema, { description: "Operations to apply" }),
  delete: Type.Optional(Type.Boolean({ description: "Delete the file" })),
  rename: Type.Optional(Type.String({ description: "Rename/move to new path" })),
});

type HashlineEditInput = Static<typeof HashlineEditSchema>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface SuccessResult {
  success: true;
  message: string;
}

interface ErrorResult {
  success: false;
  error: string;
}

type ToolResult = SuccessResult | ErrorResult;

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

export function applyHashlineEdits(input: HashlineEditInput): ToolResult {
  try {
    const { filePath, edits, delete: doDelete, rename } = input;

    // -- delete shortcut --
    if (doDelete) {
      if (edits.length > 0) {
        return { success: false, error: "delete=true requires edits to be empty" };
      }
      try {
        unlinkSync(filePath);
        return { success: true, message: `Deleted ${filePath}` };
      } catch (e) {
        return { success: false, error: `Failed to delete file: ${String(e)}` };
      }
    }

    // -- read file --
    let rawContent: string;
    try {
      rawContent = readFileSync(filePath, "utf8");
    } catch (e) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    // BOM detection
    const hasBOM = rawContent.startsWith("\uFEFF");
    if (hasBOM) rawContent = rawContent.slice(1);

    // CRLF detection
    const hasCRLF = rawContent.includes("\r\n");
    const normalized = hasCRLF ? rawContent.replace(/\r\n/g, "\n") : rawContent;

    // Remove trailing newline for splitting, restore later
    const trailingNewline = normalized.endsWith("\n");
    const contentForSplit = trailingNewline ? normalized.slice(0, -1) : normalized;
    const fileLines = contentForSplit.split("\n");

    // -- validate anchors --
    for (const edit of edits) {
      for (const anchorKey of ["pos", "end"] as const) {
        const anchorStr = edit[anchorKey];
        if (!anchorStr) continue;
        const parsed = parseAnchor(anchorStr);
        if (!parsed) {
          return {
            success: false,
            error: `Invalid anchor format: "${anchorStr}". Expected LINE#ID like "10#VK"`,
          };
        }
        const { lineNum, cid } = parsed;
        if (lineNum < 1 || lineNum > fileLines.length) {
          return {
            success: false,
            error: `>>> mismatch: anchor "${anchorStr}" line ${lineNum} is out of range (file has ${fileLines.length} lines)\n\nCurrent file:\n${annotateLines(fileLines)}`,
          };
        }
        const actualLine = fileLines[lineNum - 1];
        const expectedCID = computeCID(lineNum, actualLine);
        if (cid !== expectedCID) {
          return {
            success: false,
            error: `>>> mismatch: anchor "${anchorStr}" — expected CID ${expectedCID} for line ${lineNum} but got ${cid}\n\nCurrent file:\n${annotateLines(fileLines)}`,
          };
        }
      }
    }

    // -- separate anchored edits from BOF/EOF edits --
    type AnchoredEdit = Edit & { _lineNum: number };
    const anchoredEdits: AnchoredEdit[] = [];
    const bofEdits: Edit[] = [];
    const eofEdits: Edit[] = [];

    for (const edit of edits) {
      if (!edit.pos) {
        if (edit.op === "prepend") {
          bofEdits.push(edit);
        } else {
          // append without pos → EOF
          eofEdits.push(edit);
        }
      } else {
        const parsed = parseAnchor(edit.pos)!;
        anchoredEdits.push({ ...edit, _lineNum: parsed.lineNum });
      }
    }

    // Sort anchored edits bottom-up (descending line number) so earlier
    // edits don't shift indices for later ones
    anchoredEdits.sort((a, b) => b._lineNum - a._lineNum);

    // Apply anchored edits
    for (const edit of anchoredEdits) {
      const { op, _lineNum: lineNum } = edit;
      const insertionLines = normalizeLines(edit.lines);
      const idx = lineNum - 1; // 0-based

      if (op === "replace") {
        if (edit.end) {
          const endParsed = parseAnchor(edit.end)!;
          const endIdx = endParsed.lineNum - 1;
          // Replace range [idx..endIdx] inclusive
          const replaceWith = insertionLines ?? [];
          fileLines.splice(idx, endIdx - idx + 1, ...replaceWith);
        } else {
          // Single-line replace
          const replaceWith = insertionLines ?? [];
          fileLines.splice(idx, 1, ...replaceWith);
        }
      } else if (op === "append") {
        // Insert after idx
        const insertWith = insertionLines ?? [];
        fileLines.splice(idx + 1, 0, ...insertWith);
      } else if (op === "prepend") {
        // Insert before idx
        const insertWith = insertionLines ?? [];
        fileLines.splice(idx, 0, ...insertWith);
      }
    }

    // Apply BOF (prepend without pos) - apply in reverse order to maintain order
    for (const edit of [...bofEdits].reverse()) {
      const insertWith = normalizeLines(edit.lines) ?? [];
      fileLines.splice(0, 0, ...insertWith);
    }

    // Apply EOF (append without pos)
    for (const edit of eofEdits) {
      const insertWith = normalizeLines(edit.lines) ?? [];
      fileLines.push(...insertWith);
    }

    // Reconstruct content
    let result = fileLines.join("\n");
    if (trailingNewline) result += "\n";
    if (hasCRLF) result = result.replace(/\n/g, "\r\n");
    if (hasBOM) result = `\uFEFF${result}`;

    const targetPath = rename ?? filePath;
    writeFileSync(targetPath, result, "utf8");

    if (rename && rename !== filePath) {
      try {
        unlinkSync(filePath);
      } catch {
        // already written to new path, old path may not exist
      }
      return { success: true, message: `File edited and renamed to ${rename}` };
    }

    const lineCount = fileLines.length;
    return { success: true, message: `File updated. ${lineCount} lines.` };
  } catch (e) {
    return { success: false, error: `Unexpected error: ${String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerHashlineEditTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.HASHLINE_EDIT, {
    name: TOOL_NAMES.HASHLINE_EDIT,
    description:
      "Edit files using LINE#ID format for precise, safe modifications. " +
      "Applies multiple edits bottom-up using anchors like '10#VK'. " +
      "Supports replace, append, prepend operations on single lines or ranges.",
    inputSchema: HashlineEditSchema,
    handler: async (input: HashlineEditInput) => {
      const result = applyHashlineEdits(input);
      if (result.success) {
        return { content: [{ type: "text", text: result.message }] };
      }
      return {
        isError: true,
        content: [{ type: "text", text: result.error }],
      };
    },
  });
}
