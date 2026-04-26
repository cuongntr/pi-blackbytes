import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HttpFetchOptions, HttpResult } from "../../_shared/http.js";
import { executeWebsearchFetch } from "../fetch.js";
import { executeWebsearchSearch } from "../search.js";

// --- helpers ---

function makeOkResult(data: unknown, headers: Headers = new Headers()): HttpResult {
  return { ok: true, status: 200, data, headers };
}

function makeErrorResult(error: string, status?: number): HttpResult {
  return { ok: false, error, status };
}

type MockFetch = (opts: HttpFetchOptions) => Promise<HttpResult>;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withConfig(config: unknown, fn: (agentDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-test-"));
  const originalAgentDir = process.env.PI_AGENT_DIR;
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ blackbytes: config }));
    process.env.PI_AGENT_DIR = dir;
    await fn(dir);
  } finally {
    restoreEnv("PI_AGENT_DIR", originalAgentDir);
    await rm(dir, { recursive: true });
  }
}

async function withoutWebEnv(fn: () => Promise<void>): Promise<void> {
  const originalExa = process.env.EXA_API_KEY;
  const originalTavily = process.env.TAVILY_API_KEY;
  try {
    delete process.env.EXA_API_KEY;
    delete process.env.TAVILY_API_KEY;
    await fn();
  } finally {
    restoreEnv("EXA_API_KEY", originalExa);
    restoreEnv("TAVILY_API_KEY", originalTavily);
  }
}

// --- web_search tests ---

describe("web_search", () => {
  describe("exa provider", () => {
    it("returns formatted results from Exa by default", async () => {
      await withoutWebEnv(async () => {
        await withConfig({ websearch: { exa_api_key: "test-key" } }, async () => {
          let capturedOpts: HttpFetchOptions | undefined;
          const mockFetch: MockFetch = async (opts) => {
            capturedOpts = opts;
            return makeOkResult({
              results: [
                { title: "Test Page", url: "https://example.com", text: "A snippet about tests." },
              ],
            });
          };

          const result = await executeWebsearchSearch(
            { query: "test query", numResults: 1 },
            mockFetch,
          );

          assert.equal(capturedOpts?.url, "https://api.exa.ai/search");
          assert.equal(capturedOpts?.headers?.["x-api-key"], "test-key");
          assert.ok(result.content[0].text.includes("Test Page"), "Should include title");
          assert.ok(result.content[0].text.includes("https://example.com"), "Should include url");
          assert.ok(
            result.content[0].text.includes("A snippet about tests."),
            "Should include snippet",
          );
        });
      });
    });

    it("uses EXA_API_KEY when config key is missing", async () => {
      const originalExa = process.env.EXA_API_KEY;
      try {
        process.env.EXA_API_KEY = "env-exa-key";
        await withConfig({}, async () => {
          let capturedOpts: HttpFetchOptions | undefined;
          const mockFetch: MockFetch = async (opts) => {
            capturedOpts = opts;
            return makeOkResult({ results: [] });
          };

          await executeWebsearchSearch({ query: "test" }, mockFetch);
          assert.equal(capturedOpts?.headers?.["x-api-key"], "env-exa-key");
        });
      } finally {
        restoreEnv("EXA_API_KEY", originalExa);
      }
    });

    it("prefers config key over EXA_API_KEY", async () => {
      const originalExa = process.env.EXA_API_KEY;
      try {
        process.env.EXA_API_KEY = "env-exa-key";
        await withConfig({ websearch: { exa_api_key: "config-exa-key" } }, async () => {
          let capturedOpts: HttpFetchOptions | undefined;
          const mockFetch: MockFetch = async (opts) => {
            capturedOpts = opts;
            return makeOkResult({ results: [] });
          };

          await executeWebsearchSearch({ query: "test" }, mockFetch);
          assert.equal(capturedOpts?.headers?.["x-api-key"], "config-exa-key");
        });
      } finally {
        restoreEnv("EXA_API_KEY", originalExa);
      }
    });

    it("calls Exa without x-api-key header when API key is missing", async () => {
      await withoutWebEnv(async () => {
        await withConfig({ websearch: { provider: "exa" } }, async () => {
          let capturedOpts: HttpFetchOptions | undefined;
          const mockFetch: MockFetch = async (opts) => {
            capturedOpts = opts;
            return makeOkResult({ results: [] });
          };

          await executeWebsearchSearch({ query: "test" }, mockFetch);

          assert.equal(capturedOpts?.url, "https://api.exa.ai/search");
          assert.equal(capturedOpts?.headers?.["x-api-key"], undefined);
        });
      });
    });
  });

  describe("tavily provider", () => {
    it("returns formatted results from Tavily", async () => {
      await withoutWebEnv(async () => {
        await withConfig(
          { websearch: { provider: "tavily", tavily_api_key: "test-key" } },
          async () => {
            let capturedOpts: HttpFetchOptions | undefined;
            const mockFetch: MockFetch = async (opts) => {
              capturedOpts = opts;
              return makeOkResult({
                results: [
                  {
                    title: "Tavily Result",
                    url: "https://tavily.com/page",
                    content: "Some content.",
                  },
                ],
              });
            };

            const result = await executeWebsearchSearch({ query: "tavily query" }, mockFetch);

            assert.equal(capturedOpts?.url, "https://api.tavily.com/search");
            assert.equal(capturedOpts?.headers?.Authorization, "Bearer test-key");
            assert.ok(result.content[0].text.includes("Tavily Result"), "Should include title");
            assert.ok(
              result.content[0].text.includes("https://tavily.com/page"),
              "Should include url",
            );
            assert.ok(result.content[0].text.includes("Some content."), "Should include snippet");
          },
        );
      });
    });

    it("returns error when tavily API key is missing", async () => {
      await withoutWebEnv(async () => {
        await withConfig({ websearch: { provider: "tavily" } }, async () => {
          const mockFetch: MockFetch = async () => makeOkResult({});

          const result = await executeWebsearchSearch({ query: "test" }, mockFetch);

          assert.ok(
            result.content[0].text.includes("Tavily API key is missing"),
            result.content[0].text,
          );
        });
      });
    });
  });

  it("returns error on API failure", async () => {
    await withoutWebEnv(async () => {
      await withConfig({ websearch: { provider: "exa", exa_api_key: "test-key" } }, async () => {
        const mockFetch: MockFetch = async () =>
          makeErrorResult("Network error: connection refused");

        const result = await executeWebsearchSearch({ query: "fail" }, mockFetch);
        assert.ok(result.content[0].text.includes("Error from Exa API"), result.content[0].text);
      });
    });
  });
});

// --- web_fetch tests ---

describe("web_fetch", () => {
  it("uses Exa Contents by default when an API key is available", async () => {
    await withoutWebEnv(async () => {
      await withConfig({ websearch: { exa_api_key: "test-key" } }, async () => {
        let capturedOpts: HttpFetchOptions | undefined;
        const mockFetch: MockFetch = async (opts) => {
          capturedOpts = opts;
          return makeOkResult({
            results: [
              { title: "Fetched Page", url: "https://example.com", text: "Clean Exa text" },
            ],
          });
        };

        const result = await executeWebsearchFetch({ url: "https://example.com" }, mockFetch);

        assert.equal(capturedOpts?.url, "https://api.exa.ai/contents");
        assert.equal(capturedOpts?.headers?.["x-api-key"], "test-key");
        assert.ok(result.content[0].text.includes("via Exa Contents API"));
        assert.ok(result.content[0].text.includes("Clean Exa text"));
      });
    });
  });

  it("uses Tavily Extract when configured", async () => {
    await withoutWebEnv(async () => {
      await withConfig(
        { websearch: { provider: "tavily", tavily_api_key: "test-key" } },
        async () => {
          let capturedOpts: HttpFetchOptions | undefined;
          const mockFetch: MockFetch = async (opts) => {
            capturedOpts = opts;
            return makeOkResult({
              results: [{ url: "https://example.com", raw_content: "Clean Tavily text" }],
            });
          };

          const result = await executeWebsearchFetch({ url: "https://example.com" }, mockFetch);

          assert.equal(capturedOpts?.url, "https://api.tavily.com/extract");
          assert.equal(capturedOpts?.headers?.Authorization, "Bearer test-key");
          assert.ok(result.content[0].text.includes("via Tavily Extract API"));
          assert.ok(result.content[0].text.includes("Clean Tavily text"));
        },
      );
    });
  });

  it("falls back to direct fetch when provider key is missing", async () => {
    await withoutWebEnv(async () => {
      await withConfig({}, async () => {
        const mockFetch: MockFetch = async (_opts) =>
          makeOkResult(
            "<html><body><h1>Hello world</h1></body></html>",
            new Headers({ "content-type": "text/html" }),
          );

        const result = await executeWebsearchFetch({ url: "https://example.com" }, mockFetch);

        assert.ok(result.content[0].text.includes("Fetched https://example.com: HTTP 200"));
        assert.ok(result.content[0].text.includes("Provider fallback"));
        assert.ok(
          result.content[0].text.includes("# Hello world"),
          "Should include markdown content",
        );
      });
    });
  });

  it("upgrades http:// to https:// for direct fallback", async () => {
    await withoutWebEnv(async () => {
      await withConfig({}, async () => {
        let capturedUrl = "";
        const mockFetch: MockFetch = async (opts) => {
          capturedUrl = opts.url;
          return makeOkResult("page content");
        };

        await executeWebsearchFetch({ url: "http://example.com/page" }, mockFetch);

        assert.ok(capturedUrl.startsWith("https://"), `Expected https://, got: ${capturedUrl}`);
        assert.equal(capturedUrl, "https://example.com/page");
      });
    });
  });

  it("returns URL/status/error on direct fetch failure", async () => {
    await withoutWebEnv(async () => {
      await withConfig({}, async () => {
        const mockFetch: MockFetch = async () => makeErrorResult("Timeout");

        const result = await executeWebsearchFetch({ url: "https://example.com" }, mockFetch);
        assert.ok(result.content[0].text.includes("Fetched https://example.com: error (Timeout)"));
      });
    });
  });

  it("passes timeout in milliseconds to direct httpFetch", async () => {
    await withoutWebEnv(async () => {
      await withConfig({}, async () => {
        let capturedOpts: HttpFetchOptions | undefined;
        const mockFetch: MockFetch = async (opts) => {
          capturedOpts = opts;
          return makeOkResult("ok");
        };

        await executeWebsearchFetch({ url: "https://example.com", timeout: 30 }, mockFetch);

        assert.equal(capturedOpts?.timeoutMs, 30000);
      });
    });
  });

  it("sets OpenCode-style direct headers and requested format", async () => {
    await withoutWebEnv(async () => {
      await withConfig({}, async () => {
        let capturedOpts: HttpFetchOptions | undefined;
        const mockFetch: MockFetch = async (opts) => {
          capturedOpts = opts;
          return makeOkResult("<p>Hello</p>", new Headers({ "content-type": "text/html" }));
        };

        const result = await executeWebsearchFetch(
          { url: "https://example.com", format: "text" },
          mockFetch,
        );

        assert.ok(capturedOpts?.headers?.["User-Agent"]?.includes("Chrome/143"));
        assert.ok(capturedOpts?.headers?.Accept?.includes("text/plain"));
        assert.equal(capturedOpts?.headers?.["Accept-Language"], "en-US,en;q=0.9");
        assert.ok(result.content[0].text.includes("Format: text"));
        assert.ok(result.content[0].text.includes("Hello"));
      });
    });
  });
});
