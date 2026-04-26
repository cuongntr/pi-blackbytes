import { stat } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fg from "fast-glob";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { makeRenderCall, str } from "../_shared/call-render.js";
import { registerTool } from "../_shared/register-tool.js";
import { type ToolResultStats, renderStatsResult } from "../_shared/stats-render.js";
import { type TextToolResult, textResult } from "../_shared/text-result.js";

const DISPLAY_LIMIT = 25;
const CANDIDATE_SCAN_LIMIT = 1000;
const TIMEOUT_MS = 60_000;

interface GlobParams {
  pattern: string;
  path?: string;
}

async function collectGlobCandidates(
  pattern: string,
  cwd: string,
): Promise<{
  files: string[];
  scanTruncated: boolean;
}> {
  const stream = fg.stream(pattern, {
    cwd,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**"],
  }) as AsyncIterable<string>;

  const files: string[] = [];
  let scanTruncated = false;
  for await (const entry of stream) {
    files.push(String(entry));
    if (files.length >= CANDIDATE_SCAN_LIMIT) {
      scanTruncated = true;
      break;
    }
  }
  return { files, scanTruncated };
}

export async function executeGlob(params: GlobParams): Promise<TextToolResult> {
  const { pattern, path: cwd } = params;

  try {
    const basePath = cwd ?? process.cwd();
    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        reject(new Error("glob timed out after 60s"));
      }, TIMEOUT_MS);
      t.unref?.();
    });

    const { files: matches, scanTruncated } = await Promise.race([
      collectGlobCandidates(pattern, basePath),
      timeoutPromise,
    ]);

    // Sort by mtime descending (most recent first), then keep the rendered output compact.
    // The scan is capped before statting to avoid thousands of concurrent fs.stat calls.
    const withMtime = await Promise.all(
      matches.map(async (file) => {
        try {
          const s = await stat(file);
          return { file, mtime: s.mtimeMs };
        } catch {
          return { file, mtime: 0 };
        }
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);

    if (withMtime.length === 0) {
      return textResult("(no matches)", { summary: "no matches" } satisfies ToolResultStats);
    }

    const displayed = withMtime.slice(0, DISPLAY_LIMIT).map((x) => x.file);
    const foundLabel = scanTruncated
      ? `Found at least ${withMtime.length} files (scan capped for safety).`
      : `Found ${withMtime.length} file${withMtime.length === 1 ? "" : "s"}.`;
    const header = [
      foundLabel,
      `Pattern: ${pattern}`,
      `Base path: ${basePath}`,
      scanTruncated
        ? `Showing newest ${displayed.length} from the first ${withMtime.length} discovered match(es).`
        : `Showing newest ${displayed.length} of ${withMtime.length}.`,
    ];

    if (withMtime.length > DISPLAY_LIMIT) {
      header.push(
        scanTruncated
          ? "Additional matches were not scanned; narrow pattern/path for a complete newest-first list."
          : `Omitted ${withMtime.length - DISPLAY_LIMIT} older match(es); narrow pattern/path for more.`,
      );
    }

    return textResult(`${header.join("\n")}\n\n${displayed.join("\n")}`, {
      summary: foundLabel,
    } satisfies ToolResultStats);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${message}`);
  }
}

export function registerGlobTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.GLOB, {
    name: TOOL_NAMES.GLOB,
    promptSnippet: "Fast file pattern matching with glob patterns like **/*.ts",
    description:
      "Fast file pattern matching. Supports glob patterns like **/*.js or src/**/*.ts. Returns a compact status summary with the newest matching file paths (display-limited).",
    parameters: Type.Object({
      pattern: Type.String({
        description: "Glob pattern (e.g. **/*.ts, src/**/*.js)",
      }),
      path: Type.Optional(
        Type.String({
          description: "Base directory to search in (defaults to cwd)",
        }),
      ),
    }),
    execute: executeGlob,
    renderCall: makeRenderCall("📂", "glob", (args, theme) => {
      const pattern = str(args.pattern);
      const path = str(args.path);
      const parts: string[] = [];
      if (pattern) parts.push(theme.fg("accent", pattern));
      if (path) parts.push(theme.fg("toolOutput", `in ${path}`));
      return parts.join(" ");
    }),
    renderResult: renderStatsResult,
  });
}
