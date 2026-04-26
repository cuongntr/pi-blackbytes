import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpToolCallResult } from "../../_shared/mcp-http-client.js";
import { type SearchToolCallFn, executeGrepAppSearch } from "../search.js";

// ── Helpers ─────────────────────────────────────────────────────

function makeCallTool(result: McpToolCallResult): SearchToolCallFn {
  return async () => result;
}

function makeCaptureCallTool(result: McpToolCallResult) {
  let capturedName = "";
  let capturedArgs: Record<string, unknown> = {};
  const callTool: SearchToolCallFn = async (name, args) => {
    capturedName = name;
    capturedArgs = args;
    return result;
  };
  return {
    callTool,
    getCapturedName: () => capturedName,
    getCapturedArgs: () => capturedArgs,
  };
}

function makeErrorCallTool(message: string): SearchToolCallFn {
  return async () => {
    throw new Error(message);
  };
}

const EMPTY_RESULT: McpToolCallResult = { content: [], isError: false };

// ─── gh_search ──────────────────────────────────────────────────

describe("executeGrepAppSearch", () => {
  it("returns formatted results on successful search", async () => {
    const callTool = makeCallTool({
      content: [
        {
          type: "text",
          text: [
            "Repository: facebook/react",
            "Path: src/hooks/useState.js",
            "URL: https://github.com/facebook/react/blob/main/src/hooks/useState.js",
            "License: MIT",
            "",
            "Snippets:",
            "--- Snippet 1 (Line 42) ---",
            "  const [state, setState] = useState(initialValue);",
            "  return [state, setState];",
          ].join("\n"),
        },
      ],
      isError: false,
    });

    const result = await executeGrepAppSearch({ query: "useState(" }, callTool);

    assert.ok(result.content[0].text.includes("facebook/react"));
    assert.ok(result.content[0].text.includes("useState.js"));
    assert.ok(result.content[0].text.includes("useState(initialValue)"));
    assert.ok(result.content[0].text.includes("42"));
  });

  it("passes correct arguments to searchGitHub MCP tool", async () => {
    const { callTool, getCapturedName, getCapturedArgs } = makeCaptureCallTool(EMPTY_RESULT);

    await executeGrepAppSearch(
      {
        query: "useEffect(",
        language: ["TypeScript", "TSX"],
        matchCase: true,
        matchWholeWords: true,
        useRegexp: true,
        repo: "vercel/next.js",
        path: "src/",
      },
      callTool,
    );

    assert.equal(getCapturedName(), "searchGitHub");

    const args = getCapturedArgs();
    assert.equal(args.query, "useEffect(");
    assert.equal(args.matchCase, true);
    assert.equal(args.matchWholeWords, true);
    assert.equal(args.useRegexp, true);
    assert.equal(args.repo, "vercel/next.js");
    assert.equal(args.path, "src/");
    assert.deepEqual(args.language, ["TypeScript", "TSX"]);
  });

  it("omits falsy optional arguments", async () => {
    const { callTool, getCapturedArgs } = makeCaptureCallTool(EMPTY_RESULT);

    await executeGrepAppSearch({ query: "test" }, callTool);

    const args = getCapturedArgs();
    assert.equal(args.query, "test");
    assert.equal(args.matchCase, undefined);
    assert.equal(args.matchWholeWords, undefined);
    assert.equal(args.useRegexp, undefined);
    assert.equal(args.repo, undefined);
    assert.equal(args.path, undefined);
    assert.equal(args.language, undefined);
  });

  it("returns no results when content is empty", async () => {
    const callTool = makeCallTool(EMPTY_RESULT);

    const result = await executeGrepAppSearch({ query: "very_unlikely_pattern_xyz_123" }, callTool);

    assert.ok(result.content[0].text.includes("No results found"));
  });

  it("returns no results when MCP returns 'No results found' text", async () => {
    const callTool = makeCallTool({
      content: [{ type: "text", text: "No results found for your query." }],
      isError: false,
    });

    const result = await executeGrepAppSearch({ query: "xyz_nonexistent" }, callTool);

    assert.ok(result.content[0].text.includes("No results found"));
  });

  it("returns error message on call failure", async () => {
    const callTool = makeErrorCallTool("MCP request failed: HTTP 500: Internal Server Error");

    const result = await executeGrepAppSearch({ query: "useState(" }, callTool);

    assert.ok(result.content[0].text.includes("Error searching GitHub"));
    assert.ok(result.content[0].text.includes("500"));
  });

  it("returns error message when tool reports isError", async () => {
    const callTool = makeCallTool({
      content: [{ type: "text", text: "Rate limit exceeded" }],
      isError: true,
    });

    const result = await executeGrepAppSearch({ query: "test" }, callTool);

    assert.ok(result.content[0].text.includes("Error searching GitHub"));
    assert.ok(result.content[0].text.includes("Rate limit exceeded"));
  });

  it("limits compact view and provides full view in details", async () => {
    // Create 8 mock results
    const content = Array.from({ length: 8 }, (_, i) => ({
      type: "text" as const,
      text: `Repository: org/repo-${i}\nPath: file-${i}.ts\nSnippets:\n--- Snippet 1 (Line ${i}) ---\ncode ${i}`,
    }));

    const callTool = makeCallTool({ content, isError: false });
    const result = await executeGrepAppSearch({ query: "test" }, callTool);

    // Compact shows 5 results
    const compactText = result.content[0].text;
    assert.ok(compactText.includes("repo-0"));
    assert.ok(compactText.includes("repo-4"));
    assert.ok(!compactText.includes("repo-5"));
    assert.ok(compactText.includes("3 more result(s) hidden"));

    // Full view in details
    const details = result.details as { fullText?: string } | undefined;
    assert.ok(details?.fullText?.includes("repo-7"));
  });
});
