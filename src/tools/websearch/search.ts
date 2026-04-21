import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadBlackbytesConfig } from "../../config/loader.js";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { type HttpFetchOptions, httpFetch } from "../_shared/http.js";
import { registerTool } from "../_shared/register-tool.js";
import { type TextToolResult, textResult } from "../_shared/text-result.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
  snippet?: string;
  highlights?: string[];
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}

type FetchFn = (opts: HttpFetchOptions) => ReturnType<typeof httpFetch>;

export async function executeWebsearchSearch(
  params: { query: string; numResults?: number; category?: "people" | "company" },
  fetchFn: FetchFn = httpFetch,
): Promise<TextToolResult> {
  const { query, numResults = 10, category } = params;

  const config = await loadBlackbytesConfig();

  if (!config.websearch) {
    return textResult(
      "Error: websearch is not configured. Add a 'websearch' section to your blackbytes config.",
    );
  }

  const { provider } = config.websearch;

  if (provider === "exa") {
    const apiKey = config.websearch.exa_api_key;
    if (!apiKey) {
      return textResult("Error: exa_api_key is missing from websearch config.");
    }

    const body: Record<string, unknown> = { query, numResults };
    if (category) body.category = category;

    const result = await fetchFn({
      url: "https://api.exa.ai/search",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body,
    });

    if (!result.ok) {
      return textResult(`Error from Exa API: ${result.error}`);
    }

    const data = result.data as { results?: ExaResult[] };
    const rawResults: SearchResult[] = (data.results ?? []).map((r) => ({
      title: r.title ?? "(no title)",
      url: r.url ?? "",
      snippet: r.text ?? r.snippet ?? r.highlights?.[0] ?? "",
    }));

    return textResult(formatResults(rawResults));
  }
  // tavily
  const apiKey = config.websearch.tavily_api_key;
  if (!apiKey) {
    return textResult("Error: tavily_api_key is missing from websearch config.");
  }

  const body: Record<string, unknown> = { query, max_results: numResults, api_key: apiKey };

  const result = await fetchFn({
    url: "https://api.tavily.com/search",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!result.ok) {
    return textResult(`Error from Tavily API: ${result.error}`);
  }

  const data = result.data as { results?: TavilyResult[] };
  const rawResults: SearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title ?? "(no title)",
    url: r.url ?? "",
    snippet: r.content ?? r.snippet ?? "",
  }));

  return textResult(formatResults(rawResults));
}

export function registerWebsearchSearchTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.WEB_SEARCH, {
    name: TOOL_NAMES.WEB_SEARCH,
    description:
      "Search the web for any topic. Returns a list of relevant results with titles, URLs, and snippets. Supports Exa and Tavily providers.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      numResults: Type.Optional(
        Type.Number({ description: "Number of results to return (default 10)" }),
      ),
      category: Type.Optional(
        Type.Union([Type.Literal("people"), Type.Literal("company")], {
          description: "Optional category filter: 'people' or 'company'",
        }),
      ),
    }),
    execute: (params: { query: string; numResults?: number; category?: "people" | "company" }) =>
      executeWebsearchSearch(params),
  });
}
