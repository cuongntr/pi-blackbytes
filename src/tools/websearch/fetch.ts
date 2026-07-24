import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DIRECT_REDIRECTS = 5;

type WebFetchFormat = "text" | "markdown" | "html";
type FetchFn = (opts: HttpFetchOptions) => ReturnType<typeof httpFetch>;
export type ResolveHostname = (hostname: string) => Promise<readonly string[]>;

const resolveHostname: ResolveHostname = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

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

function parseIpv4(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").map(Number);
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function parseIpv6(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  let normalized = address.toLowerCase();
  const ipv4Match = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const octets = parseIpv4(ipv4Match[1]);
    if (!octets) return undefined;
    const ipv4Hextets = [
      ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
      ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
    ];
    normalized = `${normalized.slice(0, -ipv4Match[1].length)}${ipv4Hextets
      .map((part) => part.toString(16))
      .join(":")}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const right = halves[1] ? halves[1].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function isBlockedAddress(address: string): boolean {
  if (isBlockedIpv4(address)) return true;
  const parts = parseIpv6(address);
  if (!parts) return false;
  const first = parts[0] ?? 0;
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;

  const ipv4Prefix = parts.slice(0, 6);
  const isCompatible = ipv4Prefix.every((part) => part === 0);
  const isMapped = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (!isCompatible && !isMapped) return false;
  const high = parts[6] ?? 0;
  const low = parts[7] ?? 0;
  return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
}

async function validateDirectDestination(
  url: string,
  resolve: ResolveHostname,
): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Blocked destination: invalid URL ${url}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked destination: unsupported protocol ${parsed.protocol}`;
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
  if (addresses.some(isBlockedAddress)) {
    return `Blocked destination: ${hostname} resolves to a private, loopback, or link-local address`;
  }
  return undefined;
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
  resolve: ResolveHostname,
  fallbackReason?: string,
): Promise<TextToolResult> {
  const format = params.format ?? "markdown";
  const timeoutSeconds = normalizeTimeoutSeconds(params.timeout);
  const normalized = normalizeUrl(requestedUrl);
  if (Array.isArray(normalized)) return textResult(normalized.join("\n"));

  const totalTimeoutMs = timeoutSeconds !== undefined ? timeoutSeconds * 1000 : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + totalTimeoutMs;
  const request = {
    url: normalized,
    method: "GET",
    headers: directHeaders(format),
    timeoutMs: totalTimeoutMs,
    maxBodyBytes: DIRECT_FETCH_MAX_BODY_BYTES,
    redirect: "manual",
  } satisfies HttpFetchOptions;

  let currentUrl = normalized;
  for (let redirects = 0; ; redirects++) {
    let destinationError: string | undefined;
    try {
      destinationError = await validateDirectDestination(currentUrl, resolve);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      destinationError = `Blocked destination: DNS resolution failed (${message})`;
    }
    if (destinationError) {
      const fallbackLine = fallbackReason ? `\nProvider fallback: ${fallbackReason}` : "";
      return textResult(`Fetched ${currentUrl}: error (${destinationError})${fallbackLine}`);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return textResult(
        `Fetched ${currentUrl}: error (Request timed out after ${totalTimeoutMs}ms)`,
      );
    }

    let result = await fetchFn({ ...request, url: currentUrl, timeoutMs: remainingMs });
    if (!result.ok && result.status === 403) {
      const retryRemainingMs = deadline - Date.now();
      if (retryRemainingMs <= 0) {
        return textResult(
          `Fetched ${currentUrl}: error (Request timed out after ${totalTimeoutMs}ms)`,
        );
      }
      result = await fetchFn({
        ...request,
        url: currentUrl,
        headers: directHeaders(format, "bytes"),
        timeoutMs: retryRemainingMs,
      });
    }

    const location = result.headers?.get("location");
    if (
      result.status !== undefined &&
      [301, 302, 303, 307, 308].includes(result.status) &&
      location
    ) {
      if (redirects >= MAX_DIRECT_REDIRECTS) {
        return textResult(`Fetched ${currentUrl}: error (Too many redirects)`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!result.ok) {
      const status = result.status !== undefined ? `error HTTP ${result.status}` : "error";
      const fallbackLine = fallbackReason ? `\nProvider fallback: ${fallbackReason}` : "";
      return textResult(`Fetched ${currentUrl}: ${status} (${result.error})${fallbackLine}`);
    }

    const finalUrl = result.finalUrl ?? currentUrl;
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
  resolve: ResolveHostname = resolveHostname,
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
      resolve,
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
    resolve,
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
