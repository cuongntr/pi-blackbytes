import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { type HttpFetchOptions, httpFetch } from "../_shared/http.js";
import { registerTool } from "../_shared/register-tool.js";

export interface QueryDocsParams {
  libraryId: string;
  query: string;
}

export async function executeQueryDocs(
  params: QueryDocsParams,
  fetchFn: (opts: HttpFetchOptions) => ReturnType<typeof httpFetch> = httpFetch,
): Promise<{ content: string }> {
  const { libraryId, query } = params;

  // Validate libraryId format: must start with /
  if (!libraryId.startsWith("/")) {
    return {
      content: `Invalid libraryId "${libraryId}". Must be in /org/project format (e.g. /vercel/next.js). Use docs_resolve to get the correct ID.`,
    };
  }

  // Strip leading slash for path construction, then re-add
  const url = new URL(`https://context7.com/api/v1${libraryId}`);
  url.searchParams.set("query", query);
  url.searchParams.set("tokens", "10000");

  const result = await fetchFn({ url: url.toString() });

  if (!result.ok) {
    return {
      content: `Error querying docs for "${libraryId}": ${result.error}`,
    };
  }

  const data = result.data;

  // Format the response
  if (typeof data === "string") {
    return { content: data || `No documentation found for query: "${query}"` };
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;

    // Handle { snippets: [...] } or { sections: [...] } or { content: string }
    if (typeof obj.content === "string") {
      return {
        content: obj.content || `No documentation found for query: "${query}"`,
      };
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
      return { content: parts.join("\n") };
    }

    // Fallback: stringify
    return {
      content: JSON.stringify(data, null, 2),
    };
  }

  return { content: `No documentation found for query: "${query}"` };
}

export function registerQueryDocsTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.DOCS_QUERY, {
    name: TOOL_NAMES.DOCS_QUERY,
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
  });
}
