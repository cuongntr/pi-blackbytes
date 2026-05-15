import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadBlackbytesConfig } from "../../config/loader.js";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { makeRenderCall, str, truncate } from "../_shared/call-render.js";
import { compactText } from "../_shared/compact-result.js";
import { type HttpFetchOptions, httpFetch } from "../_shared/http.js";
import { registerTool } from "../_shared/register-tool.js";
import { type ToolResultStats, buildStatsRenderResult } from "../_shared/stats-render.js";
import { type TextToolResult, textResult } from "../_shared/text-result.js";
import { type WebProvider, providerApiKey, resolveWebProviderConfig } from "./provider-config.js";

const DIRECT_FETCH_MAX_BODY_BYTES = 5 * 1024 * 1024;
const PROVIDER_FETCH_MAX_BODY_BYTES = 2 * 1024 * 1024;
const WEB_FETCH_COMPACT_CHARS = 6000;
const MAX_TIMEOUT_SECONDS = 120;

type WebFetchFormat = "text" | "markdown" | "html";
type FetchFn = (opts: HttpFetchOptions) => ReturnType<typeof httpFetch>;

interface FetchParams {
  url: string;
  timeout?: number;
  format?: WebFetchFormat;
  query?: string;
}

interface ExaContentsResult {
  title?: string;
  url?: string;
  id?: string;
  text?: string;
  summary?: string;
  highlights?: string[];
  publishedDate?: string;
  author?: string;
}

interface TavilyExtractResult {
  url?: string;
  raw_content?: string;
  content?: string;
  images?: unknown[];
  favicon?: string;
}

function normalizeTimeoutSeconds(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
  return Math.min(Math.ceil(timeout), MAX_TIMEOUT_SECONDS);
}

function normalizeUrl(url: string): string | string[] {
  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
  if (url.startsWith("https://")) return url;
  return [`Invalid URL: ${url}`, "URL must start with http:// or https://."];
}

function stringifyFetchedData(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/gi, "&");
}

function stripDangerousHtml(text: string): string {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>[\s\S]*?<\/embed>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    stripDangerousHtml(html)
      .replace(/<\/(p|div|section|article|header|footer|main|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function htmlToMarkdown(html: string): string {
  return decodeHtmlEntities(
    stripDangerousHtml(html)
      .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
      .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
      .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
      .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
      .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
      .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(div|section|article|header|footer|main|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function formatDirectContent(rawText: string, contentType: string, format: WebFetchFormat): string {
  if (!/html/i.test(contentType)) return rawText.trim();
  if (format === "html") return rawText.trim();
  if (format === "text") return htmlToText(rawText);
  return htmlToMarkdown(rawText);
}

function acceptHeaderFor(format: WebFetchFormat): string {
  if (format === "markdown") {
    return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
  }
  if (format === "text") {
    return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
  }
  return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
}

function directHeaders(format: WebFetchFormat, userAgent?: string): Record<string, string> {
  return {
    "User-Agent":
      userAgent ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Accept: acceptHeaderFor(format),
    "Accept-Language": "en-US,en;q=0.9",
  };
}

function renderFetchedText(fullText: string): TextToolResult<ToolResultStats> {
  const summary = compactText(fullText, WEB_FETCH_COMPACT_CHARS);
  const stats: ToolResultStats = {
    summary: `${fullText.length.toLocaleString("en-US")} chars`,
    fullText,
  };
  return textResult(summary, stats);
}

function renderProviderText(params: {
  provider: WebProvider;
  requestedUrl: string;
  finalUrl: string;
  title?: string;
  content: string;
  metadata?: string[];
}): TextToolResult {
  const providerName = params.provider === "tavily" ? "Tavily Extract" : "Exa Contents";
  const header = [
    `Fetched ${params.finalUrl}: via ${providerName} API`,
    params.finalUrl !== params.requestedUrl ? `Requested URL: ${params.requestedUrl}` : "",
    params.title ? `Title: ${params.title}` : "",
    ...(params.metadata ?? []),
  ].filter((line) => line.length > 0);
  const fullText = [...header, "", params.content || "(empty response body)"].join("\n");
  return renderFetchedText(fullText);
}

async function fetchDirect(
  requestedUrl: string,
  params: FetchParams,
  fetchFn: FetchFn,
  fallbackReason?: string,
): Promise<TextToolResult> {
  const format = params.format ?? "markdown";
  const timeoutSeconds = normalizeTimeoutSeconds(params.timeout);
  const normalized = normalizeUrl(requestedUrl);
  if (Array.isArray(normalized)) return textResult(normalized.join("\n"));

  const request = {
    url: normalized,
    method: "GET",
    headers: directHeaders(format),
    timeoutMs: timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined,
    maxBodyBytes: DIRECT_FETCH_MAX_BODY_BYTES,
  } satisfies HttpFetchOptions;

  let result = await fetchFn(request);
  if (!result.ok && result.status === 403) {
    result = await fetchFn({ ...request, headers: directHeaders(format, "bytes") });
  }

  if (!result.ok) {
    const status = result.status !== undefined ? `error HTTP ${result.status}` : "error";
    const fallbackLine = fallbackReason ? `\nProvider fallback: ${fallbackReason}` : "";
    return textResult(`Fetched ${normalized}: ${status} (${result.error})${fallbackLine}`);
  }

  const finalUrl = result.finalUrl ?? normalized;
  const contentType = result.headers.get("content-type") ?? "unknown";
  const rawText = stringifyFetchedData(result.data);
  const bodyText = formatDirectContent(rawText, contentType, format);
  const truncation = result.bodyTruncated
    ? `\n[Response body truncated at ${DIRECT_FETCH_MAX_BODY_BYTES.toLocaleString("en-US")} bytes.]`
    : "";
  const fallbackLine = fallbackReason ? `Provider fallback: ${fallbackReason}` : "";
  const fullText = [
    `Fetched ${finalUrl}: HTTP ${result.status}`,
    `Content-Type: ${contentType}`,
    `Format: ${format}`,
    fallbackLine,
    truncation.trim(),
    "",
    bodyText || "(empty response body)",
  ]
    .filter((part, index) => index === 5 || part.length > 0)
    .join("\n");
  return renderFetchedText(fullText);
}

async function fetchWithExa(
  url: string,
  params: FetchParams,
  apiKey: string | undefined,
  fetchFn: FetchFn,
): Promise<TextToolResult | string> {
  const timeoutMs =
    normalizeTimeoutSeconds(params.timeout) !== undefined
      ? normalizeTimeoutSeconds(params.timeout)! * 1000
      : undefined;
  const result = await fetchFn({
    url: "https://api.exa.ai/contents",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: { urls: [url], text: true },
    timeoutMs,
    maxBodyBytes: PROVIDER_FETCH_MAX_BODY_BYTES,
  });

  if (!result.ok) return result.error;
  const data = result.data as { results?: ExaContentsResult[]; statuses?: unknown[] };
  const first = data.results?.[0];
  if (!first) return "Exa Contents returned no extracted result.";

  const content = first.text ?? first.summary ?? first.highlights?.join("\n\n") ?? "";
  const metadata = [
    first.author ? `Author: ${first.author}` : "",
    first.publishedDate ? `Published: ${first.publishedDate}` : "",
  ].filter((line) => line.length > 0);
  return renderProviderText({
    provider: "exa",
    requestedUrl: url,
    finalUrl: first.url ?? first.id ?? url,
    title: first.title,
    content,
    metadata,
  });
}

async function fetchWithTavily(
  url: string,
  params: FetchParams,
  apiKey: string,
  fetchFn: FetchFn,
): Promise<TextToolResult | string> {
  const body: Record<string, unknown> = { urls: url, extract_depth: "basic" };
  if (params.query?.trim()) {
    body.query = params.query;
    body.chunks_per_source = 5;
  }

  const timeoutMs =
    normalizeTimeoutSeconds(params.timeout) !== undefined
      ? normalizeTimeoutSeconds(params.timeout)! * 1000
      : undefined;
  const result = await fetchFn({
    url: "https://api.tavily.com/extract",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    timeoutMs,
    maxBodyBytes: PROVIDER_FETCH_MAX_BODY_BYTES,
  });

  if (!result.ok) return result.error;
  const data = result.data as { results?: TavilyExtractResult[]; failed_results?: unknown[] };
  const first = data.results?.[0];
  if (!first) return "Tavily Extract returned no extracted result.";

  return renderProviderText({
    provider: "tavily",
    requestedUrl: url,
    finalUrl: first.url ?? url,
    content: first.raw_content ?? first.content ?? "",
  });
}

export async function executeWebsearchFetch(
  params: FetchParams,
  fetchFn: FetchFn = httpFetch,
): Promise<TextToolResult> {
  const normalized = normalizeUrl(params.url);
  if (Array.isArray(normalized)) return textResult(normalized.join("\n"));

  const config = resolveWebProviderConfig(await loadBlackbytesConfig());
  const apiKey = providerApiKey(config);
  if (!apiKey && config.provider === "tavily") {
    return fetchDirect(
      params.url,
      params,
      fetchFn,
      "Tavily API key missing; set blackbytes.websearch.tavily_api_key or TAVILY_API_KEY.",
    );
  }

  const providerResult =
    config.provider === "tavily"
      ? await fetchWithTavily(normalized, params, apiKey!, fetchFn)
      : await fetchWithExa(normalized, params, apiKey, fetchFn);

  if (typeof providerResult !== "string") return providerResult;
  return fetchDirect(
    params.url,
    params,
    fetchFn,
    `${config.provider} provider failed: ${providerResult}`,
  );
}

export function registerWebsearchFetchTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.WEB_FETCH, {
    name: TOOL_NAMES.WEB_FETCH,
    promptSnippet: "Fetch a URL through Exa/Tavily extraction with direct HTTP fallback",
    description:
      "Fetch a URL. Defaults to Exa Contents, or uses Tavily Extract when configured; API keys are read from config first, then EXA_API_KEY/TAVILY_API_KEY. Falls back to direct HTTP fetch with OpenCode-style headers, format negotiation, and bounded output.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (max 120)" })),
      format: Type.Optional(
        Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
          description: "Direct fallback output format. Defaults to markdown.",
        }),
      ),
      query: Type.Optional(
        Type.String({ description: "Optional user intent for Tavily chunk reranking." }),
      ),
    }),
    execute: (params: FetchParams) => executeWebsearchFetch(params),
    renderCall: makeRenderCall("📥", "web_fetch", (args, theme) => {
      const url = str(args.url);
      return url ? theme.fg("accent", truncate(url, 80)) : "";
    }),
    renderResult: buildStatsRenderResult({ partial: "Fetching..." }),
  });
}
