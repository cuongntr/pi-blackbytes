import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { registerTool } from "../_shared/register-tool.js";
import { AST_GREP_LANGUAGES, detectBinary, runAstGrep } from "./helpers.js";

export function registerAstGrepReplaceTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.AST_REPLACE, {
    name: TOOL_NAMES.AST_REPLACE,
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

      const args: string[] = [
        "run",
        "--pattern",
        params.pattern,
        "--rewrite",
        params.rewrite,
        "--lang",
        params.lang,
        "--json",
      ];

      if (!dryRun) {
        args.push("--update-all");
      }

      if (params.globs && params.globs.length > 0) {
        for (const g of params.globs) {
          args.push("--globs", g);
        }
      }

      if (params.paths && params.paths.length > 0) {
        args.push(...params.paths);
      }

      const result = runAstGrep(binaryResult.bin, args);

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Error running ast-grep: ${result.error}` }],
          isError: true,
        };
      }

      interface MatchWithRewrite {
        file?: string;
        range?: { start?: { line?: number; column?: number } };
        text?: string;
        replacement?: string;
        [key: string]: unknown;
      }

      let matches: MatchWithRewrite[] = [];
      try {
        if (result.stdout.trim()) {
          matches = JSON.parse(result.stdout) as MatchWithRewrite[];
        }
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Error parsing ast-grep output: ${result.stdout}`,
            },
          ],
          isError: true,
        };
      }

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: "No matches found." }],
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
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      return {
        content: [
          {
            type: "text",
            text: `Applied ${matches.length} replacement(s) successfully.`,
          },
        ],
      };
    },
  });
}
