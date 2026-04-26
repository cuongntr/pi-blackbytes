import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HttpFetchOptions, HttpResult } from "../http.js";
import { McpError, McpHttpClient, parseSSEEvents } from "../mcp-http-client.js";

// ── Helpers ─────────────────────────────────────────────────────

type MockHandler = (body: Record<string, unknown>, opts: HttpFetchOptions) => HttpResult;

/**
 * Creates an McpHttpClient with a mock fetch function.
 * The handler receives the parsed request body and full options.
 */
function makeClient(handler: MockHandler, endpoint = "https://mock.test"): McpHttpClient {
  const fetchFn = async (opts: HttpFetchOptions): Promise<HttpResult> => {
    const body = opts.body as Record<string, unknown>;
    return handler(body, opts);
  };
  return new McpHttpClient({ endpoint, fetchFn });
}

/** Standard successful init response in SSE format. */
function initResponse(id: number): HttpResult {
  return {
    ok: true,
    status: 200,
    data: sseWrap({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "0.0.0" },
      },
    }),
    headers: new Headers(),
  };
}

/** Notification accepted response. */
function notificationResponse(): HttpResult {
  return { ok: true, status: 202, data: "", headers: new Headers() };
}

/** Wrap a JSON-RPC response as an SSE payload. */
function sseWrap(obj: unknown): string {
  return `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
}

// ─── parseSSEEvents ─────────────────────────────────────────────

describe("parseSSEEvents", () => {
  it("parses a standard SSE message", () => {
    const text = 'event: message\ndata: {"id":1}\n\n';
    const events = parseSSEEvents(text);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "message");
    assert.equal(events[0].data, '{"id":1}');
  });

  it("handles \\r\\n line endings", () => {
    const text = 'event: message\r\ndata: {"id":1}\r\n\r\n';
    const events = parseSSEEvents(text);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, '{"id":1}');
  });

  it("joins multiple data lines with newline", () => {
    const text = "data: line1\ndata: line2\n\n";
    const events = parseSSEEvents(text);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, "line1\nline2");
  });

  it("ignores comments", () => {
    const text = ': this is a comment\ndata: {"ok":true}\n\n';
    const events = parseSSEEvents(text);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, '{"ok":true}');
  });

  it("defaults event type to message", () => {
    const text = "data: hello\n\n";
    const events = parseSSEEvents(text);
    assert.equal(events[0].type, "message");
  });

  it("handles final event without trailing blank line", () => {
    const text = 'data: {"id":1}';
    const events = parseSSEEvents(text);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, '{"id":1}');
  });

  it("parses multiple events", () => {
    const text = "data: first\n\ndata: second\n\n";
    const events = parseSSEEvents(text);
    assert.equal(events.length, 2);
    assert.equal(events[0].data, "first");
    assert.equal(events[1].data, "second");
  });

  it("handles optional space after colon", () => {
    const text = "data:no-space\n\ndata: with-space\n\n";
    const events = parseSSEEvents(text);
    assert.equal(events[0].data, "no-space");
    assert.equal(events[1].data, "with-space");
  });
});

// ─── McpHttpClient ──────────────────────────────────────────────

describe("McpHttpClient", () => {
  it("performs init handshake then calls tool", async () => {
    const calls: string[] = [];

    const client = makeClient((body) => {
      const method = body.method as string;
      calls.push(method);

      if (method === "initialize") return initResponse(body.id as number);
      if (method === "notifications/initialized") return notificationResponse();
      if (method === "tools/call") {
        return {
          ok: true,
          status: 200,
          data: sseWrap({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: "hello" }],
              isError: false,
            },
          }),
          headers: new Headers(),
        };
      }
      return { ok: false, error: "unknown" };
    });

    const result = await client.callTool("myTool", { key: "val" });

    assert.deepEqual(calls, ["initialize", "notifications/initialized", "tools/call"]);
    assert.equal(result.content[0].text, "hello");
    assert.equal(result.isError, false);
  });

  it("only initializes once for multiple calls", async () => {
    let initCount = 0;

    const client = makeClient((body) => {
      const method = body.method as string;
      if (method === "initialize") {
        initCount++;
        return initResponse(body.id as number);
      }
      if (method === "notifications/initialized") return notificationResponse();
      return {
        ok: true,
        status: 200,
        data: sseWrap({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [], isError: false },
        }),
        headers: new Headers(),
      };
    });

    await client.callTool("a", {});
    await client.callTool("b", {});
    await client.callTool("c", {});

    assert.equal(initCount, 1);
  });

  it("captures and sends Mcp-Session-Id", async () => {
    let sessionIdSent: string | undefined;

    const client = makeClient((body, opts) => {
      const method = body.method as string;
      sessionIdSent = opts.headers?.["Mcp-Session-Id"];

      if (method === "initialize") {
        return {
          ok: true,
          status: 200,
          data: sseWrap({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "mock", version: "0.0.0" },
            },
          }),
          headers: new Headers({ "mcp-session-id": "sess-42" }),
        };
      }
      if (method === "notifications/initialized") return notificationResponse();
      return {
        ok: true,
        status: 200,
        data: sseWrap({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [], isError: false },
        }),
        headers: new Headers(),
      };
    });

    await client.callTool("test", {});
    assert.equal(sessionIdSent, "sess-42");
  });

  it("handles JSON response (non-SSE)", async () => {
    const client = makeClient((body) => {
      const method = body.method as string;
      if (method === "initialize") {
        // Return plain JSON instead of SSE
        return {
          ok: true,
          status: 200,
          data: {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "mock", version: "0.0.0" },
            },
          },
          headers: new Headers(),
        };
      }
      if (method === "notifications/initialized") return notificationResponse();
      return {
        ok: true,
        status: 200,
        data: {
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "json-mode" }], isError: false },
        },
        headers: new Headers(),
      };
    });

    const result = await client.callTool("test", {});
    assert.equal(result.content[0].text, "json-mode");
  });

  it("throws McpError on HTTP failure", async () => {
    const client = makeClient(() => ({
      ok: false,
      error: "HTTP 500: Internal Server Error",
      status: 500,
    }));

    await assert.rejects(
      () => client.callTool("test", {}),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.ok(err.message.includes("500"));
        return true;
      },
    );
  });

  it("throws McpError on JSON-RPC error", async () => {
    const client = makeClient((body) => {
      const method = body.method as string;
      if (method === "initialize") return initResponse(body.id as number);
      if (method === "notifications/initialized") return notificationResponse();
      return {
        ok: true,
        status: 200,
        data: sseWrap({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32602, message: "Invalid params" },
        }),
        headers: new Headers(),
      };
    });

    await assert.rejects(
      () => client.callTool("test", {}),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.ok(err.message.includes("Invalid params"));
        assert.equal(err.rpcCode, -32602);
        return true;
      },
    );
  });

  it("throws McpError on truncated body", async () => {
    const client = makeClient(() => ({
      ok: true,
      status: 200,
      data: "truncated...",
      headers: new Headers(),
      bodyTruncated: true,
    }));

    await assert.rejects(
      () => client.callTool("test", {}),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.ok(err.message.includes("maximum body size"));
        return true;
      },
    );
  });

  it("resets on 404 with active session and re-initializes on next call", async () => {
    let initCount = 0;
    let callCount = 0;

    const client = makeClient((body) => {
      callCount++;
      const method = body.method as string;

      if (method === "initialize") {
        initCount++;
        return initResponse(body.id as number);
      }
      if (method === "notifications/initialized") return notificationResponse();

      // First tools/call succeeds with a session, second returns 404,
      // third (after re-init) succeeds again.
      if (callCount <= 3) {
        return {
          ok: true,
          status: 200,
          data: sseWrap({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [], isError: false },
          }),
          headers: new Headers({ "mcp-session-id": "sess-1" }),
        };
      }
      if (callCount === 4) {
        return { ok: false, error: "HTTP 404: Not Found", status: 404 };
      }
      // After re-init (callCount 5=init, 6=notif), callCount 7=tools/call
      return {
        ok: true,
        status: 200,
        data: sseWrap({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "recovered" }], isError: false },
        }),
        headers: new Headers(),
      };
    });

    // First call works (init + notification + tools/call = 3 calls)
    await client.callTool("test", {});
    assert.equal(initCount, 1);

    // Second call gets 404 — throws and resets session
    await assert.rejects(() => client.callTool("test", {}));

    // Third call should re-initialize and succeed
    const result = await client.callTool("test", {});
    assert.equal(initCount, 2);
    assert.equal(result.content[0].text, "recovered");
  });

  it("serializes concurrent initialization", async () => {
    let initCount = 0;

    const client = makeClient((body) => {
      const method = body.method as string;
      if (method === "initialize") {
        initCount++;
        return initResponse(body.id as number);
      }
      if (method === "notifications/initialized") return notificationResponse();
      return {
        ok: true,
        status: 200,
        data: sseWrap({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [], isError: false },
        }),
        headers: new Headers(),
      };
    });

    // Fire 3 concurrent calls
    await Promise.all([
      client.callTool("a", {}),
      client.callTool("b", {}),
      client.callTool("c", {}),
    ]);

    assert.equal(initCount, 1);
  });

  it("passes tool name and arguments correctly", async () => {
    let capturedParams: Record<string, unknown> = {};

    const client = makeClient((body) => {
      const method = body.method as string;
      if (method === "initialize") return initResponse(body.id as number);
      if (method === "notifications/initialized") return notificationResponse();
      capturedParams = (body.params ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        data: sseWrap({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [], isError: false },
        }),
        headers: new Headers(),
      };
    });

    await client.callTool("searchGitHub", {
      query: "test",
      language: ["TypeScript"],
    });

    assert.equal(capturedParams.name, "searchGitHub");
    assert.deepEqual((capturedParams.arguments as Record<string, unknown>).query, "test");
    assert.deepEqual((capturedParams.arguments as Record<string, unknown>).language, [
      "TypeScript",
    ]);
  });
});
