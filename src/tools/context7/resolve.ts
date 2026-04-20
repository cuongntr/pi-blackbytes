import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type HttpFetchOptions, httpFetch } from "../_shared/http.js";
import { registerTool } from "../_shared/register-tool.js";

const TOOL_NAME = "context7_resolve_library_id";

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
): Promise<{ content: string }> {
  const { libraryName, query } = params;

  const url = new URL("https://context7.com/api/v1/search");
  url.searchParams.set("query", libraryName);

  const result = await fetchFn({ url: url.toString() });

  if (!result.ok) {
    return { content: `Error resolving library ID: ${result.error}` };
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
    return {
      content: `No libraries found for "${libraryName}". Try a different search term.`,
    };
  }

  // Pick best match — first result is ranked by relevance
  const best = results[0];
  const others = results.slice(1, 5);

  const lines: string[] = [
    `Best match for "${libraryName}" (query: "${query}"):`,
    `  Library ID: ${best.id}`,
    `  Name: ${best.name}`,
  ];
  if (best.description) {
    lines.push(`  Description: ${best.description}`);
  }
  if (others.length > 0) {
    lines.push("", "Other matches:");
    for (const lib of others) {
      lines.push(`  ${lib.id}  — ${lib.name}`);
    }
  }

  return { content: lines.join("\n") };
}

export function registerResolveLibraryIdTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAME, {
    name: TOOL_NAME,
    description:
      "Resolves a package/product name to a Context7-compatible library ID. Call this before context7_query_docs to get the correct library ID in /org/project format.",
    parameters: Type.Object({
      libraryName: Type.String({
        description: "Library name to search for (e.g. 'Next.js', 'React', 'Express')",
      }),
      query: Type.String({
        description: "The question or task you need help with, used to rank results by relevance",
      }),
    }),
    execute: (params: ResolveParams) => executeResolveLibraryId(params),
  });
}
