import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { makeRenderCall, str } from "../_shared/call-render.js";
import { registerTool } from "../_shared/register-tool.js";
import { type ToolResultStats, buildStatsRenderResult } from "../_shared/stats-render.js";
import { type TextToolResult, textResult } from "../_shared/text-result.js";

type OutputMode = "content" | "files_with_matches" | "count";

const RG_TIMEOUT_MS = 60_000;
const RG_MAX_OUTPUT_BYTES = 256 * 1024;
const RG_SAFETY_ARGS = [
  "--no-follow",
  "--color=never",
  "--max-depth",
  "20",
  "--max-filesize",
  "10M",
  "--max-columns",
  "1000",
] as const;

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
  const { pattern, include, output_mode, path: searchPath, context } = params;
  const mode = output_mode ?? "files_with_matches";
  const args: string[] = [...RG_SAFETY_ARGS];

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

  // head_limit is applied after parsing output so it behaves as a global
  // rendered-result cap. ripgrep's --max-count is per-file and would make
  // count mode incorrect.

  args.push("--", pattern);

  if (searchPath) {
    args.push(searchPath);
  }

  return args;
}

function truncateLines(output: string, headLimit?: number): string {
  if (headLimit == null || headLimit <= 0) return output;
  const lines = output.split("\n");
  if (lines.length <= headLimit) return output;
  return `${lines.slice(0, headLimit).join("\n")}\n[Output truncated to ${headLimit} line(s). Narrow the search for more.]`;
}

function appendBounded(current: string, chunk: Buffer): { text: string; truncated: boolean } {
  const incoming = chunk.toString("utf8");
  if (current.length + incoming.length <= RG_MAX_OUTPUT_BYTES) {
    return { text: current + incoming, truncated: false };
  }
  const remaining = Math.max(0, RG_MAX_OUTPUT_BYTES - current.length);
  return { text: current + incoming.slice(0, remaining), truncated: true };
}

function spawnRg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(`rg timed out after ${RG_TIMEOUT_MS}ms`));
    }, RG_TIMEOUT_MS);
    timeout.unref?.();

    proc.stdout.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      const next = appendBounded(stdout, chunk);
      stdout = next.text;
      stdoutTruncated = next.truncated;
      if (stdoutTruncated) proc.kill("SIGTERM");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderrTruncated) return;
      const next = appendBounded(stderr, chunk);
      stderr = next.text;
      stderrTruncated = next.truncated;
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0 || code === 1 || stdoutTruncated) {
        // code 1 means no matches, which is fine. stdoutTruncated means we
        // intentionally stopped after the safety cap and return the bounded data.
        const marker = stdoutTruncated ? "\n[Output truncated due to 256KB safety limit.]" : "";
        resolve(`${stdout.trimEnd()}${marker}`);
      } else {
        reject(new Error(stderr.trimEnd() || `rg exited with code ${code}`));
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
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
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

function renderGrepResult(output: string): TextToolResult<ToolResultStats> {
  const resultText = output || "(no matches)";
  const summary =
    resultText === "(no matches)"
      ? "no matches"
      : (() => {
          const lines = resultText.split("\n").filter((l) => l.trim() && !l.startsWith("["));
          return `${lines.length} line${lines.length !== 1 ? "s" : ""}`;
        })();
  return textResult(resultText, { summary } satisfies ToolResultStats);
}

async function executeGrep(params: GrepParams): Promise<TextToolResult> {
  // Validate regex up front
  try {
    new RegExp(params.pattern);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Error: Invalid regex pattern: ${msg}`);
  }

  // Try ripgrep first
  try {
    const args = buildRgArgs(params);
    const output = truncateLines(await spawnRg(args), params.head_limit);
    return renderGrepResult(output);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // If rg binary not found or spawn error, fall back to Node
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      try {
        const output = await nodeFallbackGrep(params);
        return renderGrepResult(output);
      } catch (fallbackErr: unknown) {
        const fallbackMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return textResult(`Error: ${fallbackMsg}`);
      }
    }
    return textResult(`Error: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGrepTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.GREP, {
    name: TOOL_NAMES.GREP,
    promptSnippet: "Search file contents using regular expressions with safety limits",
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
    renderCall: makeRenderCall("🔍", "grep", (args, theme) => {
      const pattern = str(args.pattern);
      const path = str(args.path);
      const include = str(args.include);
      const parts: string[] = [];
      if (pattern) parts.push(theme.fg("accent", `/${pattern}/`));
      if (path) parts.push(theme.fg("toolOutput", `in ${path}`));
      if (include) parts.push(theme.fg("muted", `(${include})`));
      return parts.join(" ");
    }),
    renderResult: buildStatsRenderResult({ partial: "Searching..." }),
  });
}
