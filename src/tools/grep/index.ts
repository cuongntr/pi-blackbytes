import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { registerTool } from "../_shared/register-tool.js";

type OutputMode = "content" | "files_with_matches" | "count";

interface GrepParams {
  pattern: string;
  include?: string;
  output_mode?: OutputMode;
  head_limit?: number;
  path?: string;
  context?: number; // lines before/after each match (content mode only)
}

// ---------------------------------------------------------------------------
// ripgrep implementation
// ---------------------------------------------------------------------------

function buildRgArgs(params: GrepParams): string[] {
  const { pattern, include, output_mode, head_limit, path: searchPath, context } = params;
  const mode = output_mode ?? "files_with_matches";
  const args: string[] = [];

  // Output mode flags
  if (mode === "files_with_matches") {
    args.push("--files-with-matches");
  } else if (mode === "count") {
    args.push("--count");
  }
  // "content" mode is the default for rg (shows matching lines)

  // Context lines — only meaningful for content mode
  if (context != null && context > 0 && mode === "content") {
    args.push("--context", String(context));
  }

  if (include) {
    args.push("--glob", include);
  }

  if (head_limit != null) {
    args.push("--max-count", String(head_limit));
  }

  args.push("--", pattern);

  if (searchPath) {
    args.push(searchPath);
  }

  return args;
}

function spawnRg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0 || code === 1) {
        // code 1 means no matches, which is fine
        resolve(Buffer.concat(stdout).toString("utf8").trimEnd());
      } else {
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trimEnd() || `rg exited with code ${code}`,
          ),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Node.js fallback implementation
// ---------------------------------------------------------------------------

async function* walkFiles(dir: string, include?: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[] | undefined;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const globToRegex = (glob: string): RegExp => {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    return new RegExp(`(^|/)${escaped}$`);
  };

  const includeRe = include ? globToRegex(include) : null;

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, include);
    } else if (entry.isFile()) {
      if (!includeRe || includeRe.test(entry.name)) {
        yield fullPath;
      }
    }
  }
}

async function nodeFallbackGrep(params: GrepParams): Promise<string> {
  const { pattern, include, output_mode, head_limit, path: searchPath, context } = params;
  const mode = output_mode ?? "files_with_matches";
  const dir = searchPath ?? process.cwd();

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "m");
  } catch (err: unknown) {
    throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`);
  }

  const resultLines: string[] = [];
  let lineCount = 0;
  const exceeded = () => head_limit != null && lineCount >= head_limit;

  for await (const filePath of walkFiles(dir, include)) {
    if (exceeded()) break;

    let content: string;
    try {
      const s = await stat(filePath);
      if (s.size > 10 * 1024 * 1024) continue; // skip files > 10MB
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const relPath = relative(dir, filePath);
    const lines = content.split("\n");
    const matchingLines: Array<{ lineNum: number; text: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matchingLines.push({ lineNum: i + 1, text: lines[i] });
      }
    }

    if (matchingLines.length === 0) continue;

    if (mode === "files_with_matches") {
      resultLines.push(relPath);
      lineCount++;
    } else if (mode === "count") {
      resultLines.push(`${relPath}:${matchingLines.length}`);
      lineCount++;
    } else {
      // content mode
      const useContext = context != null && context > 0;

      if (useContext) {
        // Add -- separator between files/groups
        if (resultLines.length > 0) {
          resultLines.push("--");
        }

        const matchSet = new Set(matchingLines.map((m) => m.lineNum - 1));
        // Expand each match index by ±context
        const included = new Set<number>();
        for (const idx of matchSet) {
          for (
            let j = Math.max(0, idx - context!);
            j <= Math.min(lines.length - 1, idx + context!);
            j++
          ) {
            included.add(j);
          }
        }

        const sorted = Array.from(included).sort((a, b) => a - b);
        let prevIdx = -2;
        for (const idx of sorted) {
          if (exceeded()) break;
          // Gap between non-contiguous context groups within the same file
          if (prevIdx >= 0 && idx > prevIdx + 1) {
            resultLines.push("--");
          }
          const sep = matchSet.has(idx) ? ":" : "-";
          resultLines.push(`${relPath}${sep}${idx + 1}${sep}${lines[idx]}`);
          lineCount++;
          prevIdx = idx;
        }
      } else {
        for (const { lineNum, text } of matchingLines) {
          if (exceeded()) break;
          resultLines.push(`${relPath}:${lineNum}:${text}`);
          lineCount++;
        }
      }
    }
  }

  return resultLines.join("\n");
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function executeGrep(params: GrepParams): Promise<{ content: string }> {
  // Validate regex up front
  try {
    new RegExp(params.pattern);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: Invalid regex pattern: ${msg}` };
  }

  // Try ripgrep first
  try {
    const args = buildRgArgs(params);
    const output = await spawnRg(args);
    return { content: output || "(no matches)" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // If rg binary not found or spawn error, fall back to Node
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      try {
        const output = await nodeFallbackGrep(params);
        return { content: output || "(no matches)" };
      } catch (fallbackErr: unknown) {
        const fallbackMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return { content: `Error: ${fallbackMsg}` };
      }
    }
    return { content: `Error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGrepTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.GREP, {
    name: TOOL_NAMES.GREP,
    description:
      "Search file contents using regular expressions. Uses ripgrep (rg) when available for speed, falls back to Node.js implementation. Supports content, files_with_matches, and count output modes. Use context to show surrounding lines.",
    parameters: Type.Object({
      pattern: Type.String({
        description: "Regular expression pattern for searching",
      }),
      include: Type.Optional(
        Type.String({
          description: "File glob filter (e.g. *.ts, *.{ts,tsx})",
        }),
      ),
      output_mode: Type.Optional(
        Type.Union(
          [Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")],
          {
            description:
              'Output mode: "content" shows matching lines, "files_with_matches" shows file paths only, "count" shows match counts per file. Defaults to "files_with_matches".',
          },
        ),
      ),
      context: Type.Optional(
        Type.Number({
          description:
            "Number of lines to show before and after each match. Only applies to content mode. Produces rg-style output with '--' separators between non-adjacent groups.",
          minimum: 0,
        }),
      ),
      head_limit: Type.Optional(
        Type.Number({
          description: "Maximum number of lines/results to return",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Directory to search in (defaults to cwd)",
        }),
      ),
    }),
    execute: executeGrep,
  });
}
