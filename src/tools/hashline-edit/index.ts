import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { computeCID } from "../../utils/cid.js";
import { makeRenderCall, str } from "../_shared/call-render.js";
import { registerTool } from "../_shared/register-tool.js";
import type { ToolResultStats } from "../_shared/stats-render.js";
import { annotateLineContext, annotateLines, parseAnchor } from "./anchors.js";
import type { DiffData } from "./diff-preview.js";
import { ERROR_CODES, formatError } from "./errors.js";
import { resolveWriteTarget, writeFileAtomically } from "./fs-write.js";
import { verifyPersistedContent } from "./post-verify.js";
import { renderHashlineEditResult } from "./result-renderer.js";
import { type ToolResult, buildHashlineErrorResult, buildSuccessResult } from "./result.js";
import { type Edit, type HashlineEditInput, HashlineEditSchema } from "./schema.js";
import {
  countOccurrences,
  detectOverlappingReplaceRanges,
  detectTextAnchorOverlap,
  locateOccurrenceLines,
  normalizeEdit,
  normalizeLines,
} from "./validate.js";

export interface ApplyHashlineEditsOptions {
  /** When true (default), reject `lines` payloads that contain `LINE#ID|` prefixes with E_INVALID_PATCH. */
  strictPatch?: boolean;
  /**
   * INTERNAL test hook: override the post-verify read. Production callers
   * never set this; the default is `fs.readFileSync(path, "utf8")`.
   */
  __verifyReadFn?: (path: string) => string;
  /**
   * INTERNAL test hook: called instead of `writeFileAtomically` during the
   * rollback path. Throwing simulates a rollback failure (e.g. EROFS).
   * Production callers never set this.
   */
  __rollbackWriteFn?: (path: string, content: string) => void;
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

export function applyHashlineEdits(
  input: HashlineEditInput,
  options: ApplyHashlineEditsOptions = {},
): ToolResult {
  const strictPatch = options.strictPatch ?? true;
  try {
    const { filePath, edits: rawEdits, delete: doDelete, rename } = input;

    // Normalise alias ops (insert_after / insert_before / replace_range)
    // BEFORE any downstream processing so the rest of the executor only sees
    // canonical ops.
    const edits: Edit[] = [];
    for (let i = 0; i < rawEdits.length; i++) {
      const normalized = normalizeEdit(rawEdits[i], i);
      if ("error" in normalized) {
        return { success: false, error: normalized.error };
      }
      edits.push(normalized);
    }

    // -- delete shortcut --
    if (doDelete) {
      if (edits.length > 0) {
        return {
          success: false,
          error: formatError(ERROR_CODES.E_INVALID_PATCH, "delete=true requires edits to be empty"),
        };
      }
      try {
        unlinkSync(filePath);
        return { success: true, message: `Deleted ${filePath}` };
      } catch (e) {
        return {
          success: false,
          error: formatError(
            ERROR_CODES.E_WRITE_FAILED,
            `Failed to delete file: ${filePath}`,
            String(e),
          ),
        };
      }
    }

    // -- read file --
    let rawContent: string;
    try {
      rawContent = readFileSync(filePath, "utf8");
    } catch (_e) {
      return {
        success: false,
        error: formatError(ERROR_CODES.E_NOT_FOUND, `File not found: ${filePath}`),
      };
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
    // Snapshot the original lines BEFORE any mutation so we can produce a
    // post-edit diff preview / Updated anchors response. `oldLines` is held
    // only in this stack frame; the array is small (~file size) and ephemeral.
    const oldLines = [...fileLines];

    // -- partition: text edits run first, then anchored ops --
    const textEdits: Edit[] = [];
    const otherEdits: Edit[] = [];
    for (const edit of edits) {
      if (edit.op === "replace_text") {
        textEdits.push(edit);
      } else {
        otherEdits.push(edit);
      }
    }

    // -- check text/anchored overlap BEFORE mutating --
    const tx = detectTextAnchorOverlap(edits, fileLines);
    if (tx) {
      return { success: false, error: formatError(ERROR_CODES.E_OVERLAP, tx) };
    }

    // -- apply text edits sequentially, rebuilding fileLines after each --
    for (let i = 0; i < textEdits.length; i++) {
      const edit = textEdits[i];
      const oldText = edit.oldText ?? "";
      const newText = edit.newText ?? "";
      if (oldText === "") {
        return {
          success: false,
          error: formatError(
            ERROR_CODES.E_NO_MATCH,
            `edits[${edits.indexOf(edit)}].replace_text: oldText must be a non-empty string`,
          ),
        };
      }
      const haystack = fileLines.join("\n");
      const count = countOccurrences(haystack, oldText);
      if (count === 0) {
        return {
          success: false,
          error: formatError(
            ERROR_CODES.E_NO_MATCH,
            `edits[${edits.indexOf(edit)}].replace_text: oldText not found in file`,
            `First 80 chars: ${oldText.slice(0, 80).replace(/\n/g, "\\n")}`,
          ),
        };
      }
      if (count > 1) {
        const lines = locateOccurrenceLines(haystack, oldText, 3);
        return {
          success: false,
          error: formatError(
            ERROR_CODES.E_MULTI_MATCH,
            `edits[${edits.indexOf(edit)}].replace_text: oldText matches ${count} times (must be unique)`,
            `First matches on lines: ${lines.join(", ")}\nHint: include more surrounding context in oldText to disambiguate.`,
          ),
        };
      }
      const updated = haystack.replace(oldText, newText);
      fileLines.length = 0;
      fileLines.push(...updated.split("\n"));
    }

    // -- validate anchors (against post-text-edit snapshot) --
    for (const edit of otherEdits) {
      for (const anchorKey of ["pos", "end"] as const) {
        const anchorStr = edit[anchorKey];
        if (!anchorStr) continue;
        const parsed = parseAnchor(anchorStr);
        if (!parsed) {
          return {
            success: false,
            error: formatError(
              ERROR_CODES.E_BAD_REF,
              `Invalid anchor format: "${anchorStr}". Expected LINE#ID like "10#VK"`,
            ),
          };
        }
        const { lineNum, cid } = parsed;
        if (lineNum < 1 || lineNum > fileLines.length) {
          return {
            success: false,
            error: formatError(
              ERROR_CODES.E_OUT_OF_RANGE,
              `>>> mismatch: anchor "${anchorStr}" line ${lineNum} is out of range (file has ${fileLines.length} lines)`,
              `Current file:\n${annotateLines(fileLines)}`,
            ),
          };
        }
        const actualLine = fileLines[lineNum - 1];
        const expectedCID = computeCID(lineNum, actualLine);
        if (cid !== expectedCID) {
          return {
            success: false,
            error: formatError(
              ERROR_CODES.E_HASH_MISMATCH,
              `>>> mismatch: anchor "${anchorStr}" — expected CID ${expectedCID} for line ${lineNum} but got ${cid}`,
              `Nearby current lines:\n${annotateLineContext(fileLines, lineNum)}`,
            ),
          };
        }
      }
    }

    for (const edit of otherEdits) {
      if (edit.op === "replace" && edit.pos && edit.end) {
        const start = parseAnchor(edit.pos)!.lineNum;
        const end = parseAnchor(edit.end)!.lineNum;
        if (start > end) {
          return {
            success: false,
            error: formatError(
              ERROR_CODES.E_BAD_REF,
              `Invalid range: start line ${start} cannot be greater than end line ${end}`,
            ),
          };
        }
      }
    }

    const overlapError = detectOverlappingReplaceRanges(otherEdits);
    if (overlapError) {
      return {
        success: false,
        error: formatError(ERROR_CODES.E_OVERLAP, overlapError),
      };
    }

    // -- separate anchored edits from BOF/EOF edits --
    type AnchoredEdit = Edit & { _lineNum: number };
    const anchoredEdits: AnchoredEdit[] = [];
    const bofEdits: Edit[] = [];
    const eofEdits: Edit[] = [];

    for (const edit of otherEdits) {
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
      const insertionLines = normalizeLines(edit.lines, strictPatch);
      if (insertionLines !== null && !Array.isArray(insertionLines)) {
        return { success: false, error: insertionLines.error };
      }
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
      const normalized = normalizeLines(edit.lines, strictPatch);
      if (normalized !== null && !Array.isArray(normalized)) {
        return { success: false, error: normalized.error };
      }
      const insertWith = normalized ?? [];
      fileLines.splice(0, 0, ...insertWith);
    }

    // Apply EOF (append without pos)
    for (const edit of eofEdits) {
      const normalized = normalizeLines(edit.lines, strictPatch);
      if (normalized !== null && !Array.isArray(normalized)) {
        return { success: false, error: normalized.error };
      }
      const insertWith = normalized ?? [];
      fileLines.push(...insertWith);
    }

    // Reconstruct content
    let result = fileLines.join("\n");
    if (trailingNewline) result += "\n";
    if (hasCRLF) result = result.replace(/\n/g, "\r\n");
    if (hasBOM) result = `\uFEFF${result}`;

    const targetPath = rename ?? filePath;
    const isRename = Boolean(rename) && rename !== filePath;
    try {
      const target = resolveWriteTarget(targetPath);
      if (target.isNonRegularFile) {
        return {
          success: false,
          error: formatError(
            ERROR_CODES.E_WRITE_FAILED,
            `Refusing to write: ${targetPath} resolves to a non-regular file`,
            `Canonical path: ${target.canonicalPath}`,
          ),
        };
      }

      // -- capture rollback bytes BEFORE writing (post-verify only) --
      // For the no-rename case the rollback bytes are the source file's
      // original disk contents (rawContent + BOM if any). For the rename
      // case we need the rename target's prior bytes — which may differ
      // from the source file when the target pre-existed — so we read
      // them up-front. If the rename target did not exist, the proper
      // rollback is to unlink the just-written file (priorTargetBytes
      // stays null).
      let priorTargetBytes: string | null = null;
      let priorTargetExisted = false;
      if (input.postEditVerify) {
        if (isRename) {
          try {
            priorTargetBytes = readFileSync(target.canonicalPath, "utf8");
            priorTargetExisted = true;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            priorTargetExisted = false;
          }
        } else {
          priorTargetBytes = hasBOM ? `\uFEFF${rawContent}` : rawContent;
          priorTargetExisted = true;
        }
      }

      writeFileAtomically(target.canonicalPath, target.hardLinkCount, target.mode, result);

      // -- optional post-write verification (T7) --
      if (input.postEditVerify) {
        const verify = verifyPersistedContent(target.canonicalPath, result, options.__verifyReadFn);
        if (!verify.ok) {
          let rollbackError: string | null = null;
          try {
            if (priorTargetExisted && priorTargetBytes !== null) {
              if (options.__rollbackWriteFn) {
                options.__rollbackWriteFn(target.canonicalPath, priorTargetBytes);
              } else {
                writeFileAtomically(
                  target.canonicalPath,
                  target.hardLinkCount,
                  target.mode,
                  priorTargetBytes,
                );
              }
            } else {
              // Target did not exist before — restore non-existence.
              unlinkSync(target.canonicalPath);
            }
          } catch (rollbackErr) {
            rollbackError = String(rollbackErr);
          }
          const rollbackNote = rollbackError
            ? `Rollback failed; file may be partially corrupted, inspect manually. (${rollbackError})`
            : priorTargetExisted
              ? "Rolled back to pre-edit content."
              : "Rolled back by removing the newly-created file.";
          const context = `${verify.diffContext}\n${rollbackNote}`;
          return {
            success: false,
            error: formatError(
              ERROR_CODES.E_VERIFY_FAILED,
              `Post-write verification failed for ${targetPath}`,
              context,
            ),
          };
        }
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return {
        success: false,
        error: formatError(
          ERROR_CODES.E_WRITE_FAILED,
          `Failed to write ${targetPath}${code ? ` (${code})` : ""}`,
          String(e),
        ),
      };
    }

    if (rename && rename !== filePath) {
      try {
        unlinkSync(filePath);
      } catch {
        // already written to new path, old path may not exist
      }
      return buildSuccessResult(`File edited and renamed to ${rename}`, oldLines, fileLines);
    }

    const lineCount = fileLines.length;
    return buildSuccessResult(`File updated. ${lineCount} lines.`, oldLines, fileLines);
  } catch (e) {
    // Catch-all: most likely an unexpected filesystem error from writeFileSync.
    return {
      success: false,
      error: formatError(ERROR_CODES.E_WRITE_FAILED, "Unexpected error", String(e)),
    };
  }
}

/**
 * Best-effort canonical path resolution.
 *
 * Returns `fs.realpathSync(p)` when the path exists; falls back to `p` ONLY
 * on `ENOENT` (e.g. a rename target that does not yet exist). All other
 * errors are rethrown so latent permission errors are not silently swallowed.
 *
 * Exported so T3 (atomic write) can reuse the same canonicalisation rules
 * when resolving rename targets.
 */
export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return p;
    throw e;
  }
}

export async function runQueuedHashlineEdit(
  input: HashlineEditInput,
  options: ApplyHashlineEditsOptions = {},
): Promise<ToolResult> {
  const queuePaths = [input.filePath];
  if (input.rename && input.rename !== input.filePath) {
    queuePaths.push(input.rename);
  }

  // Canonicalise each queue key so two concurrent edits that arrive via
  // different symlink paths to the same underlying file serialise on the
  // same `withFileMutationQueue` key. Without this, the queue would key on
  // literal paths and race on the same inode.
  const canonicalQueuePaths = queuePaths.map((p) => safeRealpath(p));
  const sortedQueuePaths = [...new Set(canonicalQueuePaths)].sort();
  let run = async () => applyHashlineEdits(input, options);

  for (const filePath of sortedQueuePaths.reverse()) {
    const next = run;
    run = () => withFileMutationQueue(filePath, next);
  }

  return run();
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export interface RegisterHashlineEditOptions {
  /** Strict patch rejection (default true). When false, restore legacy silent-strip behaviour. */
  strictPatch?: boolean;
}

export function registerHashlineEditTool(
  pi: ExtensionAPI,
  options: RegisterHashlineEditOptions = {},
): void {
  const strictPatch = options.strictPatch ?? true;
  registerTool(pi, TOOL_NAMES.HASHLINE_EDIT, {
    name: TOOL_NAMES.HASHLINE_EDIT,
    promptSnippet: "Edit files using LINE#ID anchors for precise, safe modifications",
    promptGuidelines: [
      "Prefer hashline_edit over edit for all file modifications when available.",
      "Always read the target file first to obtain LINE#ID anchors before editing.",
      "For repeated edits in the same file, re-read to refresh anchors before issuing another hashline_edit call.",
      "Never include a LINE#ID| prefix inside the lines payload — send raw content only. The tool rejects prefixed lines with [E_INVALID_PATCH].",
      "For substring edits (rename identifier, tweak literal) use op:'replace_text' with oldText+newText — the substring must occur exactly once or the call is rejected with [E_NO_MATCH] / [E_MULTI_MATCH].",
    ],
    description:
      "Edit files using LINE#ID format for precise, safe modifications. " +
      "Applies multiple edits bottom-up using anchors like '10#VK'. " +
      "Supports replace, append, prepend operations on single lines or ranges. " +
      "Use lines:null to delete. Omit pos for BOF/EOF insertion. " +
      "All edits in one call reference the original file snapshot — do not adjust for prior edits in the same batch. " +
      "On >>> mismatch errors, copy the updated anchors from the error output and retry. " +
      "Lines must be RAW content; do not include the 'LINE#ID|' prefix — the tool will reject the call with [E_INVALID_PATCH] under default strict mode. " +
      "Op 'replace_text' performs exact-unique substring replacement: provide oldText (LF only, no CRLF; can be multi-line) and newText. Zero or multiple matches are rejected. " +
      "Aliases (clearer intent, identical behaviour): 'insert_after'=append+pos, 'insert_before'=prepend+pos, 'replace_range'=replace+pos+end. Aliases require their anchors and reject with [E_BAD_REF] if missing.",
    parameters: HashlineEditSchema,
    execute: async (_toolCallId: string, input: HashlineEditInput) => {
      const result = await runQueuedHashlineEdit(input, { strictPatch });
      if (result.success) {
        // Summary stays one-line (base message); full text carries the optional
        // diff preview. `diffData` is attached for T9's expanded TUI renderer.
        const summary = result.message.split("\n", 1)[0] ?? result.message;
        return {
          content: [{ type: "text", text: result.message }],
          details: {
            summary,
            fullText: result.message,
            ...(result.diffData ? { diffData: result.diffData } : {}),
          } as ToolResultStats & { diffData?: DiffData },
        };
      }
      return buildHashlineErrorResult(result.error);
    },
    renderCall: makeRenderCall("✎", "hashline_edit", (args, theme) => {
      const filePath = str(args.filePath);
      const edits = Array.isArray(args.edits) ? args.edits.length : 0;
      const parts: string[] = [];
      if (filePath) parts.push(theme.fg("accent", filePath));
      if (edits > 0) parts.push(theme.fg("muted", `(${edits} edit${edits !== 1 ? "s" : ""})`));
      if (args.delete) parts.push(theme.fg("error", "DELETE"));
      const rename = str(args.rename);
      if (rename) parts.push(theme.fg("warning", `→ ${rename}`));
      return parts.join(" ");
    }),
    renderResult: renderHashlineEditResult,
  });
}
