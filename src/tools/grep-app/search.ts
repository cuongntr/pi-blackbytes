import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { makeRenderCall, str, truncate } from "../_shared/call-render.js";
import {
  type McpContentBlock,
  McpHttpClient,
  type McpToolCallResult,
} from "../_shared/mcp-http-client.js";
import { registerTool } from "../_shared/register-tool.js";
import { type ToolResultStats, renderStatsResult } from "../_shared/stats-render.js";
import { type TextToolResult, textResult } from "../_shared/text-result.js";

const COMPACT_HIT_LIMIT = 5;
const FULL_HIT_LIMIT = 20;

const MCP_ENDPOINT = "https://mcp.grep.app";
const NO_RESULTS_PREFIX = "No results found";

// ── Types ───────────────────────────────────────────────────────

export interface GrepAppParams {
  query: string;
  language?: string[];
  matchCase?: boolean;
  matchWholeWords?: boolean;
  useRegexp?: boolean;
  repo?: string;
  path?: string;
}

/**
 * Narrow function signature for calling the MCP `searchGitHub` tool.
 * Extracted as a seam so unit tests can inject a mock without wiring
 * the full MCP handshake.
 */
export type SearchToolCallFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<McpToolCallResult>;

// ── Singleton client ────────────────────────────────────────────

let defaultClient: McpHttpClient | undefined;

function getDefaultClient(): McpHttpClient {
  if (!defaultClient) {
    defaultClient = new McpHttpClient({ endpoint: MCP_ENDPOINT });
  }
  return defaultClient;
}

/** @internal — only for tests that need to reset module-level state. */
export function _resetDefaultClient(): void {
  defaultClient = undefined;
}

// ── Core logic ──────────────────────────────────────────────────

export async function executeGrepAppSearch(
  params: GrepAppParams,
  callToolFn?: SearchToolCallFn,
): Promise<TextToolResult> {
  const {
    query,
    language,
    matchCase = false,
    matchWholeWords = false,
    useRegexp = false,
    repo,
    path,
  } = params;

  const callTool: SearchToolCallFn = callToolFn ?? ((n, a) => getDefaultClient().callTool(n, a));

  // Build MCP tool arguments — only include truthy optional fields
  const args: Record<string, unknown> = { query };
  if (matchCase) args.matchCase = true;
  if (matchWholeWords) args.matchWholeWords = true;
  if (useRegexp) args.useRegexp = true;
  if (repo) args.repo = repo;
  if (path) args.path = path;
  if (language && language.length > 0) args.language = language;

  let result: McpToolCallResult;
  try {
    result = await callTool("searchGitHub", args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult(`Error searching GitHub: ${message}`);
  }

  // Tool-level error
  if (result.isError) {
    const errText = result.content
      .filter(
        (b): b is McpContentBlock & { text: string } =>
          b.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text)
      .join("\n");
    return textResult(`Error searching GitHub: ${errText || "unknown error"}`);
  }

  // Extract text content blocks — each block is one search result
  const hits = result.content.filter(
    (b): b is McpContentBlock & { text: string } => b.type === "text" && typeof b.text === "string",
  );

  // The MCP server returns a single block "No results found…" instead of
  // an empty array when there are no matches.
  if (hits.length === 0 || (hits.length === 1 && hits[0].text.startsWith(NO_RESULTS_PREFIX))) {
    return textResult(`No results found for query: "${query}"`, {
      summary: "no results",
    } satisfies ToolResultStats);
  }

  const formatHits = (limit: number): string => {
    const selected = hits.slice(0, limit);
    const parts: string[] = [
      `Search results for "${query}" on grep.app (${hits.length} results, showing ${selected.length}):`,
      "",
    ];

    for (const hit of selected) {
      parts.push(hit.text);
      parts.push("");
    }

    if (hits.length > limit) {
      parts.push(`[${hits.length - limit} more result(s) hidden. Expand with ctrl+o for details.]`);
    }

    return parts.join("\n");
  };

  const summaryText = formatHits(COMPACT_HIT_LIMIT);
  const fullText = formatHits(FULL_HIT_LIMIT);
  const stats: ToolResultStats = {
    summary: `${hits.length} result${hits.length !== 1 ? "s" : ""}`,
    fullText,
  };
  return textResult(summaryText, stats);
}

// ── Registration ────────────────────────────────────────────────

export function registerGrepAppSearchTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.GH_SEARCH, {
    name: TOOL_NAMES.GH_SEARCH,
    promptSnippet: "Search code patterns across public GitHub repositories",
    description:
      "Search code patterns across public GitHub repositories using grep.app. Returns matching code snippets with repo, file, and line number context. Use for finding real-world usage examples of APIs, libraries, or patterns.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Code pattern to search for (e.g. 'useState(', 'async function', 'import React from')",
      }),
      language: Type.Optional(
        Type.Array(Type.String(), {
          description: "Filter by programming language(s) (e.g. ['TypeScript', 'Python'])",
        }),
      ),
      matchCase: Type.Optional(
        Type.Boolean({
          description: "Case-sensitive search (default: false)",
        }),
      ),
      matchWholeWords: Type.Optional(
        Type.Boolean({
          description: "Match whole words only (default: false)",
        }),
      ),
      useRegexp: Type.Optional(
        Type.Boolean({
          description: "Interpret query as a regular expression (default: false)",
        }),
      ),
      repo: Type.Optional(
        Type.String({
          description: "Filter by repository (e.g. 'facebook/react', 'vercel/')",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Filter by file path (e.g. 'src/components', 'route.ts')",
        }),
      ),
    }),
    execute: (params: GrepAppParams) => executeGrepAppSearch(params),
    renderCall: makeRenderCall("🔎", "gh_search", (args, theme) => {
      const q = str(args.query);
      const repo = str(args.repo);
      const parts: string[] = [];
      if (q) parts.push(theme.fg("accent", `"${truncate(q, 50)}"`));
      if (repo) parts.push(theme.fg("toolOutput", `in ${repo}`));
      return parts.join(" ");
    }),
    renderResult: renderStatsResult,
  });
}
