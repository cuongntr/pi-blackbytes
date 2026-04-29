import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadBlackbytesConfig } from "../../config/loader.js";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { makeRenderCall, str } from "../_shared/call-render.js";
import { type HttpFetchOptions, httpFetch } from "../_shared/http.js";
import { registerTool } from "../_shared/register-tool.js";
import { type ToolResultStats, buildStatsRenderResult } from "../_shared/stats-render.js";
import { type TextToolResult, textResult } from "../_shared/text-result.js";

export interface ResolveParams {
  libraryName: string;
  query: string;
}

export interface LibraryResult {
  id: string;
  name: string;
  description?: string;
}

export async function executeResolveLibraryId(
  params: ResolveParams,
  fetchFn: (opts: HttpFetchOptions) => ReturnType<typeof httpFetch> = httpFetch,
): Promise<TextToolResult> {
  const { libraryName, query } = params;

  const url = new URL("https://context7.com/api/v1/search");
  url.searchParams.set("query", libraryName);
  if (query.trim()) {
    url.searchParams.set("topic", query);
  }

  const config = await loadBlackbytesConfig();
  const headers = config.context7?.api_key
    ? { Authorization: `Bearer ${config.context7.api_key}` }
    : undefined;

  const result = await fetchFn({ url: url.toString(), headers });

  if (!result.ok) {
    return textResult(`Error resolving library ID: ${result.error}`);
  }

  const data = result.data as Record<string, unknown>;

  // Extract results array from response
  const results: LibraryResult[] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object" && "id" in item) {
        results.push(item as LibraryResult);
      }
    }
  } else if (data && typeof data === "object") {
    // May be wrapped: { results: [...] } or { libraries: [...] }
    const arr =
      (data.results as unknown[]) ??
      (data.libraries as unknown[]) ??
      (data.data as unknown[]) ??
      [];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === "object" && "id" in item) {
          results.push(item as LibraryResult);
        }
      }
    }
  }

  if (results.length === 0) {
    return textResult(`No libraries found for "${libraryName}". Try a different search term.`, {
      summary: "no match",
    } satisfies ToolResultStats);
  }

  // Pick best match — first result is ranked by relevance
  const best = results[0];
  const others = results.slice(1, 4);

  const lines: string[] = [
    `Best match for "${libraryName}" (query: "${query}"):`,
    `  Library ID: ${best.id}`,
    `  Name: ${best.name ?? "(unknown)"}`,
  ];
  if (best.description) {
    lines.push(`  Description: ${best.description}`);
  }
  if (others.length > 0) {
    lines.push("", "Other matches:");
    for (const lib of others) {
      lines.push(`  ${lib.id}  — ${lib.name ?? "(unknown)"}`);
    }
  }

  return textResult(lines.join("\n"), {
    summary: `→ ${best.id}`,
  } satisfies ToolResultStats);
}

export function registerResolveLibraryIdTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.DOCS_RESOLVE, {
    name: TOOL_NAMES.DOCS_RESOLVE,
    promptSnippet: "Resolve a package name to a Context7 library ID for documentation lookup",
    description:
      "Resolves a package/product name to a Context7-compatible library ID. Call this before docs_query to get the correct library ID in /org/project format.",
    parameters: Type.Object({
      libraryName: Type.String({
        description: "Library name to search for (e.g. 'Next.js', 'React', 'Express')",
      }),
      query: Type.String({
        description: "The question or task you need help with, used to rank results by relevance",
      }),
    }),
    execute: (params: ResolveParams) => executeResolveLibraryId(params),
    renderCall: makeRenderCall("📚", "docs_resolve", (args, theme) => {
      const lib = str(args.libraryName);
      return lib ? theme.fg("accent", `"${lib}"`) : "";
    }),
    renderResult: buildStatsRenderResult({ partial: "Resolving..." }),
  });
}
