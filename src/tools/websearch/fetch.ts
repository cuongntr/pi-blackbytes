import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { type HttpFetchOptions, httpFetch } from "../_shared/http.js";
import { registerTool } from "../_shared/register-tool.js";

type FetchFn = (opts: HttpFetchOptions) => ReturnType<typeof httpFetch>;

export async function executeWebsearchFetch(
  params: { url: string; timeout?: number },
  fetchFn: FetchFn = httpFetch,
): Promise<{ content: string }> {
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
    return { content: `Error fetching URL: ${result.error}` };
  }

  const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  return { content: text };
}

export function registerWebsearchFetchTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.WEB_FETCH, {
    name: TOOL_NAMES.WEB_FETCH,
    description:
      "Fetch content from a URL and return it as text. Automatically upgrades http:// to https://.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (max 120)" })),
    }),
    execute: (params: { url: string; timeout?: number }) => executeWebsearchFetch(params),
  });
}
