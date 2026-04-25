import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { type HttpFetchOptions, httpFetch } from "../_shared/http.js";
import { registerTool } from "../_shared/register-tool.js";
import { type TextToolResult, textResult } from "../_shared/text-result.js";

type FetchFn = (opts: HttpFetchOptions) => ReturnType<typeof httpFetch>;

export async function executeWebsearchFetch(
  params: { url: string; timeout?: number },
  fetchFn: FetchFn = httpFetch,
): Promise<TextToolResult> {
  let { url } = params;
  const { timeout } = params;

  // Upgrade http:// to https://
  if (url.startsWith("http://")) {
    url = `https://${url.slice("http://".length)}`;
  }

  const result = await fetchFn({
    url,
    method: "GET",
    timeoutMs: timeout !== undefined ? timeout * 1000 : undefined,
  });

  if (!result.ok) {
    const status = result.status !== undefined ? `error HTTP ${result.status}` : "error";
    return textResult(`Fetched ${url}: ${status} (${result.error})`);
  }

  return textResult(`Fetched ${url}: HTTP ${result.status}`);
}

export function registerWebsearchFetchTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.WEB_FETCH, {
    name: TOOL_NAMES.WEB_FETCH,
    description:
      "Fetch a URL and report the final URL and HTTP status. Automatically upgrades http:// to https://.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (max 120)" })),
    }),
    execute: (params: { url: string; timeout?: number }) => executeWebsearchFetch(params),
  });
}
