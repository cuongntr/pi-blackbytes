import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { httpFetch, redactHeaders, redactUrl } from "../http.js";

function makeResponse(
  status: number,
  body: string,
  statusText = "OK",
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("httpFetch", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it("successful GET request returns parsed JSON", async () => {
    globalThis.fetch = mock.fn(async () => makeResponse(200, JSON.stringify({ hello: "world" })));

    const result = await httpFetch({ url: "https://example.com/api" });

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("Expected ok");
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { hello: "world" });
  });

  it("defaults method to GET when no body", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return makeResponse(200, "{}");
    }) as typeof globalThis.fetch;

    await httpFetch({ url: "https://example.com" });
    assert.equal(capturedInit?.method, "GET");
  });

  it("defaults method to POST when body is provided", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return makeResponse(200, "{}");
    }) as typeof globalThis.fetch;

    await httpFetch({ url: "https://example.com", body: { foo: "bar" } });
    assert.equal(capturedInit?.method, "POST");
  });

  it("timeout returns error result", async () => {
    globalThis.fetch = mock.fn(
      () =>
        new Promise<Response>((_, reject) => {
          // Never resolves — wait for abort
          setTimeout(() => {
            const err = new DOMException("The operation was aborted.", "AbortError");
            reject(err);
          }, 50);
        }),
    );

    const result = await httpFetch({
      url: "https://example.com",
      timeoutMs: 10,
    });

    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Expected error");
    assert.match(result.error, /timed out/);
  });

  it("network error returns error result", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await httpFetch({ url: "https://example.com" });

    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Expected error");
    assert.match(result.error, /Network error/);
  });

  it("non-2xx response returns error with status", async () => {
    globalThis.fetch = mock.fn(async () =>
      makeResponse(404, "Not Found", "Not Found", { Location: "/login" }),
    );

    const result = await httpFetch({ url: "https://example.com" });

    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Expected error");
    assert.equal(result.status, 404);
    assert.match(result.error, /HTTP 404/);
    assert.equal(result.headers?.get("location"), "/login");
  });

  it("passes the redirect mode to native fetch", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return makeResponse(200, "{}");
    }) as typeof globalThis.fetch;

    await httpFetch({ url: "https://example.com", redirect: "manual" });
    assert.equal(capturedInit?.redirect, "manual");
  });

  it("AbortSignal cancellation returns abort error", async () => {
    const controller = new AbortController();

    globalThis.fetch = mock.fn(
      () =>
        new Promise<Response>((_, reject) => {
          setTimeout(() => {
            const err = new DOMException("Aborted", "AbortError");
            reject(err);
          }, 50);
        }),
    );

    controller.abort();
    const result = await httpFetch({
      url: "https://example.com",
      signal: controller.signal,
      timeoutMs: 5000,
    });

    assert.equal(result.ok, false);
  });

  it("non-JSON body falls back to raw text", async () => {
    globalThis.fetch = mock.fn(
      async () => new Response("plain text", { status: 200, statusText: "OK" }),
    );

    const result = await httpFetch({ url: "https://example.com" });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("Expected ok");
    assert.equal(result.data, "plain text");
  });
});

describe("redactHeaders", () => {
  it("redacts built-in sensitive headers case-insensitively", () => {
    const headers = {
      Authorization: "Bearer token123",
      "x-api-key": "secret",
      "api-key": "another-secret",
      "Content-Type": "application/json",
    };

    const redacted = redactHeaders(headers);

    assert.equal(redacted.Authorization, "[REDACTED]");
    assert.equal(redacted["x-api-key"], "[REDACTED]");
    assert.equal(redacted["api-key"], "[REDACTED]");
    assert.equal(redacted["Content-Type"], "application/json");
  });

  it("redacts custom keys", () => {
    const headers = {
      "x-custom-token": "mysecret",
      "other-header": "value",
    };

    const redacted = redactHeaders(headers, ["x-custom-token"]);
    assert.equal(redacted["x-custom-token"], "[REDACTED]");
    assert.equal(redacted["other-header"], "value");
  });
});

describe("redactUrl", () => {
  it("redacts query params matching sensitive keys", () => {
    const url = "https://example.com/api?api-key=secret&foo=bar";
    const redacted = redactUrl(url);
    const parsed = new URL(redacted);
    assert.equal(parsed.searchParams.get("api-key"), "[REDACTED]");
    assert.equal(parsed.searchParams.get("foo"), "bar");
  });

  it("redacts custom query param keys", () => {
    const url = "https://example.com?token=abc&name=john";
    const redacted = redactUrl(url, ["token"]);
    const parsed = new URL(redacted);
    assert.equal(parsed.searchParams.get("token"), "[REDACTED]");
    assert.equal(parsed.searchParams.get("name"), "john");
  });

  it("returns unchanged url if invalid", () => {
    const url = "not-a-valid-url";
    assert.equal(redactUrl(url), url);
  });
});
