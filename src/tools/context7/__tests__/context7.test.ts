import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HttpResult } from "../../_shared/http.js";
import { executeQueryDocs } from "../query.js";
import { executeResolveLibraryId } from "../resolve.js";

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

// ─── docs_resolve ────────────────────────────────────────────

describe("executeResolveLibraryId", () => {
  it("returns best match library ID on success", async () => {
    const fetchFn = makeOkFetch({
      results: [
        {
          id: "/vercel/next.js",
          name: "Next.js",
          description: "The React Framework",
        },
        { id: "/vercel/swr", name: "SWR" },
      ],
    });

    const result = await executeResolveLibraryId(
      { libraryName: "Next.js", query: "How to use server components" },
      fetchFn,
    );

    assert.ok(result.content[0].text.includes("/vercel/next.js"));
    assert.ok(result.content[0].text.includes("Next.js"));
    assert.ok(result.content[0].text.includes("The React Framework"));
  });

  it("returns message when no results found", async () => {
    const fetchFn = makeOkFetch({ results: [] });

    const result = await executeResolveLibraryId(
      { libraryName: "nonexistent-xyz-lib", query: "anything" },
      fetchFn,
    );

    assert.ok(result.content[0].text.includes("No libraries found"));
    assert.ok(result.content[0].text.includes("nonexistent-xyz-lib"));
  });

  it("handles array response format", async () => {
    const fetchFn = makeOkFetch([{ id: "/facebook/react", name: "React" }]);

    const result = await executeResolveLibraryId({ libraryName: "React", query: "hooks" }, fetchFn);

    assert.ok(result.content[0].text.includes("/facebook/react"));
  });

  it("returns error message on API failure", async () => {
    const fetchFn = makeErrorFetch("HTTP 503: Service Unavailable");

    const result = await executeResolveLibraryId({ libraryName: "React", query: "hooks" }, fetchFn);

    assert.ok(result.content[0].text.includes("Error resolving library ID"));
    assert.ok(result.content[0].text.includes("503"));
  });
});

// ─── docs_query ────────────────────────────────────────────────────

describe("executeQueryDocs", () => {
  it("returns formatted documentation on success", async () => {
    const fetchFn = makeOkFetch({
      snippets: [
        {
          title: "Server Components",
          content: "Server Components allow you to render on the server.",
          code: "export default function Page() { return <div>Hello</div>; }",
        },
      ],
    });

    const result = await executeQueryDocs(
      { libraryId: "/vercel/next.js", query: "server components" },
      fetchFn,
    );

    assert.ok(result.content[0].text.includes("Server Components"));
    assert.ok(result.content[0].text.includes("server"));
  });

  it("returns error for invalid libraryId format", async () => {
    const fetchFn = makeOkFetch({});

    const result = await executeQueryDocs(
      { libraryId: "vercel/next.js", query: "routing" },
      fetchFn,
    );

    assert.ok(result.content[0].text.includes("Invalid libraryId"));
    assert.ok(result.content[0].text.includes("/org/project"));
  });

  it("handles string content response", async () => {
    const fetchFn = makeOkFetch({ content: "# Next.js docs\n\nSome content here." });

    const result = await executeQueryDocs(
      { libraryId: "/vercel/next.js", query: "routing" },
      fetchFn,
    );

    assert.ok(result.content[0].text.includes("Next.js docs"));
  });

  it("returns error message on API failure", async () => {
    const fetchFn = makeErrorFetch("HTTP 404: Not Found");

    const result = await executeQueryDocs(
      { libraryId: "/vercel/next.js", query: "routing" },
      fetchFn,
    );

    assert.ok(result.content[0].text.includes("Error querying docs"));
    assert.ok(result.content[0].text.includes("404"));
  });
});
