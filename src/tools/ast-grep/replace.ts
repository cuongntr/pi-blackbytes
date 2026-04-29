import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { makeRenderCall, str, truncate } from "../_shared/call-render.js";
import { registerTool } from "../_shared/register-tool.js";
import { type ToolResultStats, buildStatsRenderResult } from "../_shared/stats-render.js";
import { AST_GREP_LANGUAGES, detectBinary, runAstGrep } from "./helpers.js";

interface MatchWithRewrite {
  file?: string;
  range?: { start?: { line?: number; column?: number } };
  text?: string;
  replacement?: string;
  [key: string]: unknown;
}

function buildJsonArgs(params: {
  pattern: string;
  rewrite: string;
  lang: string;
  paths?: string[];
  globs?: string[];
}): string[] {
  const args: string[] = [
    "run",
    "--pattern",
    params.pattern,
    "--rewrite",
    params.rewrite,
    "--lang",
    params.lang,
    "--json=compact",
  ];

  if (params.globs && params.globs.length > 0) {
    for (const g of params.globs) {
      args.push("--globs", g);
    }
  }

  if (params.paths && params.paths.length > 0) {
    args.push(...params.paths);
  }

  return args;
}

function buildApplyArgs(params: {
  pattern: string;
  rewrite: string;
  lang: string;
  paths?: string[];
  globs?: string[];
}): string[] {
  const args = buildJsonArgs(params).filter((arg) => !arg.startsWith("--json"));
  args.push("--update-all");
  return args;
}

function parseMatches(stdout: string): MatchWithRewrite[] | string {
  try {
    if (!stdout.trim()) return [];
    return JSON.parse(stdout) as MatchWithRewrite[];
  } catch {
    return `Error parsing ast-grep output: ${stdout}`;
  }
}

export function registerAstGrepReplaceTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.AST_REPLACE, {
    name: TOOL_NAMES.AST_REPLACE,
    promptSnippet: "Replace code patterns across filesystem with AST-aware rewriting",
    description:
      "Replace code patterns across filesystem with AST-aware rewriting. Dry-run by default. Use meta-variables in rewrite to preserve matched content. Example: pattern='console.log($MSG)' rewrite='logger.info($MSG)'",
    parameters: Type.Object({
      pattern: Type.String({
        description:
          "AST pattern to match. Use meta-variables: $VAR (single node), $$$ (multiple nodes).",
      }),
      rewrite: Type.String({
        description:
          "Replacement pattern. Reference meta-variables from pattern to preserve matched content.",
      }),
      lang: Type.Union(
        AST_GREP_LANGUAGES.map((l) => Type.Literal(l)),
        { description: "Target programming language for AST parsing." },
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Specific file or directory paths to search.",
        }),
      ),
      globs: Type.Optional(
        Type.Array(Type.String(), {
          description: "Glob patterns to filter files (e.g. ['**/*.ts']).",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description: "When true (default), preview changes without writing to disk.",
          default: true,
        }),
      ),
    }),
    execute: async (params: {
      pattern: string;
      rewrite: string;
      lang: string;
      paths?: string[];
      globs?: string[];
      dryRun?: boolean;
    }) => {
      const dryRun = params.dryRun !== false; // default true

      const binaryResult = detectBinary();
      if (!binaryResult.found) {
        return {
          content: [{ type: "text", text: `Error: ${binaryResult.error}` }],
          isError: true,
        };
      }

      // ast-grep ignores or conflicts with --update-all when --json is present.
      // Always run a JSON pass first for a reliable preview/count, then run a
      // separate non-JSON --update-all pass for the actual write.
      const previewResult = runAstGrep(binaryResult.bin, buildJsonArgs(params));

      if (!previewResult.ok) {
        return {
          content: [{ type: "text", text: `Error running ast-grep: ${previewResult.error}` }],
          isError: true,
        };
      }

      const parsed = parseMatches(previewResult.stdout);
      if (typeof parsed === "string") {
        return {
          content: [{ type: "text", text: parsed }],
          isError: true,
        };
      }
      const matches = parsed;

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: "No matches found." }],
          details: { summary: "no matches" } satisfies ToolResultStats,
        };
      }

      if (dryRun) {
        const lines: string[] = [`Dry run — ${matches.length} replacement(s) would be made:\n`];
        for (const m of matches) {
          const file = m.file ?? "<unknown>";
          const startLine = (m.range?.start?.line ?? 0) + 1;
          lines.push(`${file}:${startLine}`);
          if (m.text) lines.push(`  - ${m.text.trimEnd()}`);
          if (m.replacement) lines.push(`  + ${m.replacement.trimEnd()}`);
          lines.push("");
        }
        lines.push("Re-run with dryRun: false to apply changes.");
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            summary: `${matches.length} replacement${matches.length !== 1 ? "s" : ""} (dry run)`,
          } satisfies ToolResultStats,
        };
      }

      const applyResult = runAstGrep(binaryResult.bin, buildApplyArgs(params));
      if (!applyResult.ok) {
        const detail = applyResult.stderr ? `\n${applyResult.stderr}` : "";
        return {
          content: [
            {
              type: "text",
              text: `Error applying ast-grep replacements: ${applyResult.error}${detail}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Applied ${matches.length} replacement(s) successfully.`,
          },
        ],
        details: {
          summary: `${matches.length} replacement${matches.length !== 1 ? "s" : ""} applied`,
        } satisfies ToolResultStats,
      };
    },
    renderCall: makeRenderCall("✏️", "ast_replace", (args, theme) => {
      const pattern = str(args.pattern);
      const rewrite = str(args.rewrite);
      const lang = str(args.lang);
      const dryRun = args.dryRun !== false;
      const parts: string[] = [];
      if (pattern) parts.push(theme.fg("accent", `'${truncate(pattern, 30)}'`));
      if (rewrite) parts.push(theme.fg("toolOutput", `→ '${truncate(rewrite, 30)}'`));
      if (lang) parts.push(theme.fg("muted", `[${lang}]`));
      if (dryRun) parts.push(theme.fg("warning", "dry-run"));
      return parts.join(" ");
    }),
    renderResult: buildStatsRenderResult({ partial: "Replacing..." }),
  });
}
