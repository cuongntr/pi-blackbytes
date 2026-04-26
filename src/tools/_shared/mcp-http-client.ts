/**
 * Minimal MCP Streamable HTTP client.
 *
 * Supports lazy initialization, session tracking, and both JSON / SSE
 * response parsing per the MCP 2025-03-26 transport spec.
 */

import { type HttpFetchOptions, type HttpResult, httpFetch } from "./http.js";

// ── Public types ──────────────────────────────────────────────────

export interface McpClientOptions {
  endpoint: string;
  clientInfo?: { name: string; version: string };
  timeoutMs?: number;
  maxBodyBytes?: number;
  fetchFn?: (opts: HttpFetchOptions) => Promise<HttpResult>;
}

export interface McpContentBlock {
  type: string;
  text?: string;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

// ── Errors ────────────────────────────────────────────────────────

export class McpError extends Error {
  readonly httpStatus?: number;
  readonly rpcCode?: number;

  constructor(message: string, httpStatus?: number, rpcCode?: number) {
    super(message);
    this.name = "McpError";
    this.httpStatus = httpStatus;
    this.rpcCode = rpcCode;
  }
}

// ── Internal types ────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface SSEEvent {
  type: string;
  data: string;
}

// ── SSE parser ────────────────────────────────────────────────────

/**
 * Parse a complete SSE text payload into discrete events.
 *
 * Handles: `\n` and `\r\n`, comments, multiple `data:` lines joined
 * with `\n`, optional single space after the colon, `event:` field,
 * and a final event without a trailing blank line.
 */
export function parseSSEEvents(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  let eventType = "message";
  let dataLines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    // Blank line → dispatch accumulated event
    if (rawLine === "") {
      if (dataLines.length > 0) {
        events.push({ type: eventType, data: dataLines.join("\n") });
        eventType = "message";
        dataLines = [];
      }
      continue;
    }

    // Comment
    if (rawLine.startsWith(":")) continue;

    // Field: value
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx === -1) continue;

    const field = rawLine.slice(0, colonIdx);
    let value = rawLine.slice(colonIdx + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        dataLines.push(value);
        break;
      case "event":
        eventType = value;
        break;
      // Ignore `id`, `retry`, and unknown fields
    }
  }

  // Dispatch final event if stream did not end with a blank line
  if (dataLines.length > 0) {
    events.push({ type: eventType, data: dataLines.join("\n") });
  }

  return events;
}

// ── Client ────────────────────────────────────────────────────────

export class McpHttpClient {
  private readonly endpoint: string;
  private readonly clientInfo: { name: string; version: string };
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly fetchFn: (opts: HttpFetchOptions) => Promise<HttpResult>;

  private sessionId?: string;
  private initialized = false;
  private initPromise?: Promise<void>;
  private nextId = 1;

  constructor(options: McpClientOptions) {
    this.endpoint = options.endpoint;
    this.clientInfo = options.clientInfo ?? {
      name: "pi-blackbytes",
      version: "1.0.0",
    };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
    this.fetchFn = options.fetchFn ?? httpFetch;
  }

  // ── Transport ─────────────────────────────────────────────────

  /**
   * Send a JSON-RPC message and return the parsed response.
   * Returns `null` for notifications (no `id` field).
   */
  private async send(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const result = await this.fetchFn({
      url: this.endpoint,
      method: "POST",
      headers,
      body: request,
      timeoutMs: this.timeoutMs,
      maxBodyBytes: this.maxBodyBytes,
    });

    if (!result.ok) {
      // Session expired — reset so next call will re-initialize
      if (result.status === 404 && this.sessionId) {
        this.reset();
      }
      throw new McpError(`MCP request failed: ${result.error}`, result.status);
    }

    // Capture session ID if server provides one
    const sid = result.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    // Notifications get no JSON-RPC response
    if (request.id === undefined) return null;

    // Only check truncation when we actually need to parse the body
    if (result.bodyTruncated) {
      throw new McpError("MCP response exceeded maximum body size");
    }

    // Parse response — JSON (auto-parsed by httpFetch) or SSE (raw string)
    if (typeof result.data === "string") {
      return this.extractJsonRpcFromSSE(result.data, request.id);
    }
    return result.data as JsonRpcResponse;
  }

  /**
   * Extract the JSON-RPC response matching `requestId` from an SSE payload.
   */
  private extractJsonRpcFromSSE(text: string, requestId: number): JsonRpcResponse {
    const events = parseSSEEvents(text);

    for (const event of events) {
      if (!event.data) continue;
      try {
        const parsed = JSON.parse(event.data) as JsonRpcResponse;
        if (parsed.id === requestId) return parsed;
      } catch {
        /* skip non-JSON events */
      }
    }

    throw new McpError(`No JSON-RPC response for id ${requestId} in SSE stream`);
  }

  // ── Initialization ────────────────────────────────────────────

  /** Ensure the initialization handshake has completed (at most once). */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    // Serialize concurrent first-call initialization
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

  private async doInit(): Promise<void> {
    const resp = await this.send({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: this.clientInfo,
      },
    });

    if (resp?.error) {
      throw new McpError(
        `MCP initialize failed: ${resp.error.message}`,
        undefined,
        resp.error.code,
      );
    }

    // Send `notifications/initialized` (no id → 202 Accepted)
    await this.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    this.initialized = true;
  }

  // ── Public API ────────────────────────────────────────────────

  /** Call a remote MCP tool. Initializes on first use. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    await this.ensureInitialized();

    const resp = await this.send({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });

    if (!resp) {
      throw new McpError("No response from tools/call");
    }

    if (resp.error) {
      throw new McpError(`Tool call failed: ${resp.error.message}`, undefined, resp.error.code);
    }

    return resp.result as McpToolCallResult;
  }

  /** Reset session state — forces re-initialization on next call. */
  reset(): void {
    this.initialized = false;
    this.sessionId = undefined;
    this.initPromise = undefined;
  }
}
