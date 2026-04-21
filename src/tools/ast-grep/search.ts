import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { registerTool } from "../_shared/register-tool.js";
import { AST_GREP_LANGUAGES, detectBinary, runAstGrep } from "./helpers.js";

interface AstGrepMatch {
  file?: string;
  range?: {
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
  };
  text?: string;
  lines?: string;
  [key: string]: unknown;
}

function formatMatches(matches: AstGrepMatch[]): string {
  if (matches.length === 0) {
    return "No matches found.";
  }

  const lines: string[] = [`Found ${matches.length} match(es):\n`];
  for (const m of matches) {
    const file = m.file ?? "<unknown>";
    const startLine = (m.range?.start?.line ?? 0) + 1;
    const startCol = m.range?.start?.column ?? 0;
    const text = m.lines ?? m.text ?? "";
    lines.push(`${file}:${startLine}:${startCol}`);
    if (text) {
      lines.push(text.trimEnd());
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function registerAstGrepSearchTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.AST_SEARCH, {
    name: TOOL_NAMES.AST_SEARCH,
    description:
      "Search code patterns across filesystem using AST-aware matching. Supports 25 languages. Use meta-variables: $VAR (single node), $$$ (multiple nodes). IMPORTANT: Patterns must be complete AST nodes (valid code). Examples: 'console.log($MSG)', 'def $FUNC($$$):', 'async function $NAME($$$)'",
    parameters: Type.Object({
      pattern: Type.String({
        description:
          "AST pattern with meta-variables ($VAR for single node, $$$ for multiple nodes). Must be a complete, valid code construct.",
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
      context: Type.Optional(
        Type.Number({
          description: "Number of context lines to show around each match.",
        }),
      ),
    }),
    execute: async (params: {
      pattern: string;
      lang: string;
      paths?: string[];
      globs?: string[];
      context?: number;
    }) => {
      const binaryResult = detectBinary();
      if (!binaryResult.found) {
        return {
          content: [{ type: "text", text: `Error: ${binaryResult.error}` }],
          isError: true,
        };
      }

      const args: string[] = ["run", "--pattern", params.pattern, "--lang", params.lang, "--json"];

      if (params.context !== undefined) {
        args.push("--context", String(params.context));
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

      let matches: AstGrepMatch[] = [];
      try {
        if (result.stdout.trim()) {
          matches = JSON.parse(result.stdout) as AstGrepMatch[];
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

      return {
        content: [{ type: "text", text: formatMatches(matches) }],
      };
    },
  });
}
