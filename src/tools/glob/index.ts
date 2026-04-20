import { stat } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fg from "fast-glob";
import { registerTool } from "../_shared/register-tool.js";

const RESULT_CAP = 100;
const TIMEOUT_MS = 60_000;

interface GlobParams {
  pattern: string;
  path?: string;
}

async function executeGlob(params: GlobParams): Promise<{ content: string }> {
  const { pattern, path: cwd } = params;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        reject(new Error("glob timed out after 60s"));
      }, TIMEOUT_MS);
      t.unref?.();
    });

    const globPromise = fg(pattern, {
      cwd: cwd ?? process.cwd(),
      absolute: true,
      onlyFiles: true,
      followSymbolicLinks: false,
    });

    const matches: string[] = await Promise.race([globPromise, timeoutPromise]);

    // Sort by mtime descending (most recent first), cap at 100
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
    const capped = withMtime.slice(0, RESULT_CAP).map((x) => x.file);

    return {
      content: capped.length > 0 ? capped.join("\n") : "(no matches)",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}` };
  }
}

export function registerGlobTool(pi: ExtensionAPI): void {
  registerTool(pi, "glob", {
    name: "glob",
    description:
      "Fast file pattern matching. Supports glob patterns like **/*.js or src/**/*.ts. Returns matching file paths sorted by modification time (most recent first), capped at 100 results.",
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
  });
}
