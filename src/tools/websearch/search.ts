import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadBlackbytesConfig } from "../../config/loader.js";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { makeRenderCall, str, truncate } from "../_shared/call-render.js";
import { type HttpFetchOptions, httpFetch } from "../_shared/http.js";
import { registerTool } from "../_shared/register-tool.js";
import { type ToolResultStats, buildStatsRenderResult } from "../_shared/stats-render.js";
import { type TextToolResult, textResult } from "../_shared/text-result.js";
import { providerApiKey, resolveWebProviderConfig } from "./provider-config.js";

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
  summary?: string;
  highlights?: string[];
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  snippet?: string;
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}

function compactSnippet(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

type FetchFn = (opts: HttpFetchOptions) => ReturnType<typeof httpFetch>;

export async function executeWebsearchSearch(
  params: { query: string; numResults?: number; category?: "people" | "company" },
  fetchFn: FetchFn = httpFetch,
): Promise<TextToolResult> {
  const { query, numResults = 10, category } = params;
  const config = resolveWebProviderConfig(await loadBlackbytesConfig());
  const apiKey = providerApiKey(config);

  if (!apiKey && config.provider === "tavily") {
    return textResult(
      "Error: Tavily API key is missing. Set blackbytes.websearch.tavily_api_key or TAVILY_API_KEY.",
    );
  }

  if (config.provider === "exa") {
    const body: Record<string, unknown> = {
      query,
      numResults,
      contents: { highlights: { maxCharacters: 1000 } },
    };
    if (category) body.category = category;

    const result = await fetchFn({
      url: "https://api.exa.ai/search",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
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
      snippet: compactSnippet(r.text ?? r.summary ?? r.snippet ?? r.highlights?.join(" [...] ")),
    }));

    const text = formatResults(rawResults);
    const summary =
      rawResults.length === 0
        ? "no results"
        : `${rawResults.length} result${rawResults.length !== 1 ? "s" : ""}`;
    return textResult(text, { summary } satisfies ToolResultStats);
  }

  const body: Record<string, unknown> = { query, max_results: numResults };

  const result = await fetchFn({
    url: "https://api.tavily.com/search",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  if (!result.ok) {
    return textResult(`Error from Tavily API: ${result.error}`);
  }

  const data = result.data as { results?: TavilyResult[] };
  const rawResults: SearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title ?? "(no title)",
    url: r.url ?? "",
    snippet: compactSnippet(r.content ?? r.raw_content ?? r.snippet),
  }));

  const text = formatResults(rawResults);
  const summary =
    rawResults.length === 0
      ? "no results"
      : `${rawResults.length} result${rawResults.length !== 1 ? "s" : ""}`;
  return textResult(text, { summary } satisfies ToolResultStats);
}

export function registerWebsearchSearchTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.WEB_SEARCH, {
    name: TOOL_NAMES.WEB_SEARCH,
    promptSnippet: "Search the web for any topic and get clean, ready-to-use content",
    description:
      "Search the web for any topic. Defaults to Exa, or uses Tavily when configured. API keys are read from blackbytes.websearch first, then EXA_API_KEY/TAVILY_API_KEY.",
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
    renderCall: makeRenderCall("🌐", "web_search", (args, theme) => {
      const q = str(args.query);
      return q ? theme.fg("accent", `"${truncate(q, 60)}"`) : "";
    }),
    renderResult: buildStatsRenderResult({ partial: "Searching..." }),
  });
}
