import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { HttpFetchOptions, HttpResult } from "../../_shared/http.js";
import { executeWebsearchFetch } from "../fetch.js";
import { executeWebsearchSearch } from "../search.js";

// --- helpers ---

function makeOkResult(data: unknown): HttpResult {
  return { ok: true, status: 200, data, headers: new Headers() };
}

function makeErrorResult(error: string): HttpResult {
  return { ok: false, error };
}

type MockFetch = (opts: HttpFetchOptions) => Promise<HttpResult>;

// Mock loadBlackbytesConfig
const mockLoadConfig = mock.fn<() => Promise<unknown>>();

// We patch the loader via the module system: instead, we pass a config factory to the execute functions.
// Since the execute functions call loadBlackbytesConfig() internally, we need to mock it.
// We'll use globalThis patching approach or restructure... but since it's imported, we mock it via
// node:test mock.module. Let's instead re-export and test via the internal exported functions
// with dependency injection (config + fetchFn).

// Actually the simplest approach: test the function by mocking both globalThis.fetch
// (which httpFetch calls) AND the settings file (via PI_AGENT_DIR env).

// Better: the execute functions accept a fetchFn but still call loadBlackbytesConfig.
// We'll use PI_AGENT_DIR to point to a temp config file.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withConfig(config: unknown, fn: (agentDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-test-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ blackbytes: config }));
    const original = process.env.PI_AGENT_DIR;
    process.env.PI_AGENT_DIR = dir;
    try {
      await fn(dir);
    } finally {
      process.env.PI_AGENT_DIR = original;
    }
  } finally {
    await rm(dir, { recursive: true });
  }
}

// --- web_search tests ---

describe("web_search", () => {
  describe("exa provider", () => {
    it("returns formatted results from Exa", async () => {
      await withConfig({ websearch: { provider: "exa", exa_api_key: "test-key" } }, async () => {
        const mockFetch: MockFetch = async (_opts) =>
          makeOkResult({
            results: [
              { title: "Test Page", url: "https://example.com", text: "A snippet about tests." },
            ],
          });

        const result = await executeWebsearchSearch(
          { query: "test query", numResults: 1 },
          mockFetch,
        );

        assert.ok(result.content.includes("Test Page"), "Should include title");
        assert.ok(result.content.includes("https://example.com"), "Should include url");
        assert.ok(result.content.includes("A snippet about tests."), "Should include snippet");
      });
    });

    it("returns error when exa_api_key is missing", async () => {
      await withConfig({ websearch: { provider: "exa" } }, async () => {
        const mockFetch: MockFetch = async () => makeOkResult({});

        const result = await executeWebsearchSearch({ query: "test" }, mockFetch);

        assert.ok(result.content.includes("exa_api_key is missing"), result.content);
      });
    });
  });

  describe("tavily provider", () => {
    it("returns formatted results from Tavily", async () => {
      await withConfig(
        { websearch: { provider: "tavily", tavily_api_key: "test-key" } },
        async () => {
          const mockFetch: MockFetch = async (_opts) =>
            makeOkResult({
              results: [
                {
                  title: "Tavily Result",
                  url: "https://tavily.com/page",
                  content: "Some content.",
                },
              ],
            });

          const result = await executeWebsearchSearch({ query: "tavily query" }, mockFetch);

          assert.ok(result.content.includes("Tavily Result"), "Should include title");
          assert.ok(result.content.includes("https://tavily.com/page"), "Should include url");
          assert.ok(result.content.includes("Some content."), "Should include snippet");
        },
      );
    });

    it("returns error when tavily_api_key is missing", async () => {
      await withConfig({ websearch: { provider: "tavily" } }, async () => {
        const mockFetch: MockFetch = async () => makeOkResult({});

        const result = await executeWebsearchSearch({ query: "test" }, mockFetch);

        assert.ok(result.content.includes("tavily_api_key is missing"), result.content);
      });
    });
  });

  it("returns error when websearch config is missing", async () => {
    await withConfig({}, async () => {
      const mockFetch: MockFetch = async () => makeOkResult({});

      const result = await executeWebsearchSearch({ query: "test" }, mockFetch);

      assert.ok(result.content.includes("websearch is not configured"), result.content);
    });
  });

  it("returns error on API failure", async () => {
    await withConfig({ websearch: { provider: "exa", exa_api_key: "test-key" } }, async () => {
      const mockFetch: MockFetch = async () => makeErrorResult("Network error: connection refused");

      const result = await executeWebsearchSearch({ query: "fail" }, mockFetch);
      assert.ok(result.content.includes("Error from Exa API"), result.content);
    });
  });
});

// --- web_fetch tests ---

describe("web_fetch", () => {
  it("fetches and returns content from a URL", async () => {
    const mockFetch: MockFetch = async (_opts) =>
      makeOkResult("<html><body>Hello world</body></html>");

    const result = await executeWebsearchFetch({ url: "https://example.com" }, mockFetch);

    assert.ok(result.content.includes("Hello world"), "Should include page content");
  });

  it("upgrades http:// to https://", async () => {
    let capturedUrl = "";
    const mockFetch: MockFetch = async (opts) => {
      capturedUrl = opts.url;
      return makeOkResult("page content");
    };

    await executeWebsearchFetch({ url: "http://example.com/page" }, mockFetch);

    assert.ok(capturedUrl.startsWith("https://"), `Expected https://, got: ${capturedUrl}`);
    assert.equal(capturedUrl, "https://example.com/page");
  });

  it("returns error on fetch failure", async () => {
    const mockFetch: MockFetch = async () => makeErrorResult("Timeout");

    const result = await executeWebsearchFetch({ url: "https://example.com" }, mockFetch);
    assert.ok(result.content.includes("Error fetching URL"), result.content);
  });

  it("passes timeout in milliseconds to httpFetch", async () => {
    let capturedOpts: HttpFetchOptions | undefined;
    const mockFetch: MockFetch = async (opts) => {
      capturedOpts = opts;
      return makeOkResult("ok");
    };

    await executeWebsearchFetch({ url: "https://example.com", timeout: 30 }, mockFetch);

    assert.equal(capturedOpts?.timeoutMs, 30000);
  });
});
