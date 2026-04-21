import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HttpResult } from "../../_shared/http.js";
import { executeGrepAppSearch } from "../search.js";

function makeOkFetch(data: unknown) {
  return async (): Promise<HttpResult> => ({
    ok: true,
    status: 200,
    data,
    headers: new Headers(),
  });
}

function makeErrorFetch(error: string) {
  return async (): Promise<HttpResult> => ({
    ok: false,
    error,
  });
}

function makeCaptureFetch(data: unknown) {
  let capturedUrl = "";
  const fetchFn = async (opts: { url: string }): Promise<HttpResult> => {
    capturedUrl = opts.url;
    return { ok: true, status: 200, data, headers: new Headers() };
  };
  return { fetchFn, getCapturedUrl: () => capturedUrl };
}

// ─── gh_search ─────────────────────────────────────────────────

describe("executeGrepAppSearch", () => {
  it("returns formatted results on successful search", async () => {
    const fetchFn = makeOkFetch({
      hits: {
        hits: [
          {
            repo: { name: "facebook/react" },
            file: { name: "src/hooks/useState.js" },
            lines: {
              "42": "  const [state, setState] = useState(initialValue);",
              "43": "  return [state, setState];",
            },
          },
        ],
      },
    });

    const result = await executeGrepAppSearch({ query: "useState(" }, fetchFn);

    assert.ok(result.content[0].text.includes("facebook/react"));
    assert.ok(result.content[0].text.includes("useState.js"));
    assert.ok(result.content[0].text.includes("useState(initialValue)"));
    assert.ok(result.content[0].text.includes("42"));
  });

  it("constructs URL with correct query parameters", async () => {
    const { fetchFn, getCapturedUrl } = makeCaptureFetch({
      hits: { hits: [] },
    });

    await executeGrepAppSearch(
      {
        query: "useEffect(",
        language: ["TypeScript", "TSX"],
        matchCase: true,
        useRegexp: true,
        repo: "vercel/next.js",
        path: "src/",
      },
      fetchFn,
    );

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get("q"), "useEffect(");
    assert.equal(url.searchParams.get("case"), "true");
    assert.equal(url.searchParams.get("regexp"), "true");
    assert.equal(url.searchParams.get("repo"), "vercel/next.js");
    assert.equal(url.searchParams.get("path"), "src/");
    const langs = url.searchParams.getAll("lang[]");
    assert.ok(langs.includes("TypeScript"));
    assert.ok(langs.includes("TSX"));
  });

  it("returns no results message when hits array is empty", async () => {
    const fetchFn = makeOkFetch({ hits: { hits: [] } });

    const result = await executeGrepAppSearch({ query: "very_unlikely_pattern_xyz_123" }, fetchFn);

    assert.ok(result.content[0].text.includes("No results found"));
  });

  it("returns error message on API failure", async () => {
    const fetchFn = makeErrorFetch("HTTP 429: Too Many Requests");

    const result = await executeGrepAppSearch({ query: "useState(" }, fetchFn);

    assert.ok(result.content[0].text.includes("Error searching GitHub"));
    assert.ok(result.content[0].text.includes("429"));
  });
});
