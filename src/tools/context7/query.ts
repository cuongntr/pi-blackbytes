import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadBlackbytesConfig } from "../../config/loader.js";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { makeRenderCall, str, truncate } from "../_shared/call-render.js";
import { compactText } from "../_shared/compact-result.js";
import { type HttpFetchOptions, httpFetch } from "../_shared/http.js";
import { registerTool } from "../_shared/register-tool.js";
import { type ToolResultStats, renderStatsResult } from "../_shared/stats-render.js";
import { type TextToolResult, textResult } from "../_shared/text-result.js";

const DOCS_QUERY_TOKEN_LIMIT = "4000";
const DOCS_QUERY_COMPACT_CHARS = 3500;

function compactDocsResult(fullText: string): TextToolResult<ToolResultStats> {
  const summary = compactText(fullText, DOCS_QUERY_COMPACT_CHARS);
  const stats: ToolResultStats = {
    summary: `${fullText.length.toLocaleString("en-US")} chars`,
    fullText,
  };
  return textResult(summary, stats);
}

export interface QueryDocsParams {
  libraryId: string;
  query: string;
}

export async function executeQueryDocs(
  params: QueryDocsParams,
  fetchFn: (opts: HttpFetchOptions) => ReturnType<typeof httpFetch> = httpFetch,
): Promise<TextToolResult> {
  const { libraryId, query } = params;

  // Validate libraryId format: must start with /
  if (!libraryId.startsWith("/")) {
    return textResult(
      `Invalid libraryId "${libraryId}". Must be in /org/project format (e.g. /vercel/next.js). Use docs_resolve to get the correct ID.`,
    );
  }

  // Strip leading slash for path construction, then re-add
  const url = new URL(`https://context7.com/api/v1${libraryId}`);
  url.searchParams.set("query", query);
  url.searchParams.set("tokens", DOCS_QUERY_TOKEN_LIMIT);

  const config = await loadBlackbytesConfig();
  const headers = config.context7?.api_key
    ? { Authorization: `Bearer ${config.context7.api_key}` }
    : undefined;

  const result = await fetchFn({ url: url.toString(), headers });

  if (!result.ok) {
    return textResult(`Error querying docs for "${libraryId}": ${result.error}`);
  }

  const data = result.data;

  // Format the response
  if (typeof data === "string") {
    const fullText = data || `No documentation found for query: "${query}"`;
    return compactDocsResult(fullText);
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;

    // Handle { snippets: [...] } or { sections: [...] } or { content: string }
    if (typeof obj.content === "string") {
      const fullText = obj.content || `No documentation found for query: "${query}"`;
      return compactDocsResult(fullText);
    }

    const snippets =
      (obj.snippets as unknown[]) ??
      (obj.sections as unknown[]) ??
      (obj.results as unknown[]) ??
      [];

    if (Array.isArray(snippets) && snippets.length > 0) {
      const parts: string[] = [`Documentation for ${libraryId} — query: "${query}"`, ""];
      for (const snippet of snippets) {
        if (snippet && typeof snippet === "object") {
          const s = snippet as Record<string, unknown>;
          if (s.title) parts.push(`## ${s.title}`);
          if (s.content) parts.push(String(s.content));
          if (s.code) parts.push(`\`\`\`\n${String(s.code)}\n\`\`\``);
          parts.push("");
        } else if (typeof snippet === "string") {
          parts.push(snippet, "");
        }
      }
      return compactDocsResult(parts.join("\n"));
    }

    // Fallback: stringify
    return compactDocsResult(JSON.stringify(data, null, 2));
  }

  return textResult(`No documentation found for query: "${query}"`);
}

export function registerQueryDocsTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.DOCS_QUERY, {
    name: TOOL_NAMES.DOCS_QUERY,
    promptSnippet: "Query up-to-date documentation and code examples from Context7",
    description:
      "Retrieves up-to-date documentation and code examples from Context7 for a library. Requires a Context7-compatible library ID in /org/project format — use docs_resolve first if you don't have the ID.",
    parameters: Type.Object({
      libraryId: Type.String({
        description:
          "Context7-compatible library ID in /org/project format (e.g. /vercel/next.js, /facebook/react)",
      }),
      query: Type.String({
        description:
          "The question or task you need help with (e.g. 'How to set up authentication with JWT')",
      }),
    }),
    execute: (params: QueryDocsParams) => executeQueryDocs(params),
    renderCall: makeRenderCall("📖", "docs_query", (args, theme) => {
      const id = str(args.libraryId);
      const q = str(args.query);
      const parts: string[] = [];
      if (id) parts.push(theme.fg("toolOutput", id));
      if (q) parts.push(theme.fg("accent", `"${truncate(q, 50)}"`));
      return parts.join(" ");
    }),
    renderResult: renderStatsResult,
  });
}
