import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { registerCleanReadRenderer, renderCompactReadResult } from "../read-renderer.js";

interface RegisteredReadTool {
  readonly renderShell?: string;
  readonly renderCall?: (
    args: Record<string, unknown> | null | undefined,
    theme: Theme,
    context?: unknown,
  ) => Component;
  readonly renderResult: (
    result: { content?: ReadonlyArray<{ type: string; text?: string }>; details?: unknown },
    options: { expanded?: boolean; isPartial?: boolean },
    theme: Theme,
    context?: unknown,
  ) => Component;
}

interface RenderableText {
  readonly render: (width: number) => string[];
}

function theme(): Theme {
  return {
    fg: (token: string, text: string) => `«${token}:${text}»`,
    bg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

function render(value: unknown, width = 100): string {
  return (value as RenderableText).render(width).join("\n");
}

function piCapturingTool(capture: (tool: RegisteredReadTool) => void): ExtensionAPI {
  return {
    registerTool: (tool: RegisteredReadTool) => {
      capture(tool);
    },
  } as unknown as ExtensionAPI;
}

function registerReadTool(input: {
  readonly display?: "compact" | "preview";
  readonly originalRenderResult?: RegisteredReadTool["renderResult"];
}): RegisteredReadTool {
  let registeredTool: RegisteredReadTool | undefined;
  registerCleanReadRenderer(
    piCapturingTool((tool) => {
      registeredTool = tool;
    }),
    "/tmp",
    {
      ui: { read_tool_display: input.display ?? "compact" },
      factory: () => ({
        name: "read",
        execute: () => ({ content: [] }),
        renderResult:
          input.originalRenderResult ??
          (() => {
            throw new Error("original renderer should not be called");
          }),
      }),
    },
  );

  assert.ok(registeredTool);
  return registeredTool;
}

describe("read renderer compact mode", () => {
  it("collapsed result renders as lightweight call/result lines without file contents", () => {
    const tool = registerReadTool({ display: "compact" });
    assert.equal(tool.renderShell, "self");
    assert.equal(render(tool.renderCall?.({ path: "src/a.ts" }, theme()) ?? ""), "");

    const out = render(
      tool.renderResult(
        { content: [{ type: "text", text: "1#AB|hello\n2#CD|world" }] },
        { expanded: false },
        theme(),
        { args: { path: "src/a.ts", offset: 1, limit: 2 } },
      ),
    );

    assert.equal(out.split("\n").length, 2);
    assert.ok(out.startsWith("«success:⏺» "));
    assert.match(out, /⎿/);
    assert.match(out, /read/);
    assert.match(out, /src\/a\.ts/);
    assert.match(out, /1-2/);
    assert.match(out, /2 lines read/);
    assert.doesNotMatch(out, /hello/);
    assert.doesNotMatch(out, /world/);
    assert.doesNotMatch(out, /1#AB/);
    assert.doesNotMatch(out, /┌|└|│/);
    assert.doesNotMatch(out, /bg:/);
  });

  it("does not render invalid non-positive ranges in the compact target", () => {
    const out = render(
      renderCompactReadResult(
        { content: [{ type: "text", text: "hello" }] },
        { expanded: false },
        theme(),
        { args: { path: "src/a.ts", offset: 0, limit: 0 } },
      ),
    );

    assert.match(out, /src\/a\.ts/);
    assert.doesNotMatch(out, /:0/);
  });

  it("renders cwd itself as dot instead of an empty target", () => {
    const out = render(
      renderCompactReadResult(
        { content: [{ type: "text", text: "hello" }] },
        { expanded: false },
        theme(),
        { args: { path: "/tmp" } },
        "/tmp",
      ),
    );

    assert.match(out, /«accent:\.»/);
    assert.doesNotMatch(out, /read\(«accent:»\)/);
  });

  it("expanded result delegates to Pi's renderer after stripping anchors", () => {
    const tool = registerReadTool({
      display: "compact",
      originalRenderResult: (result) => new Text(result.content?.[0]?.text ?? "", 0, 0),
    });

    const out = render(
      tool.renderResult(
        { content: [{ type: "text", text: "1#AB|hello\n2#CD|world" }] },
        { expanded: true },
        theme(),
        { args: { path: "src/a.ts" } },
      ),
    );

    assert.match(out, /hello/);
    assert.match(out, /world/);
    assert.doesNotMatch(out, /1#AB/);
    assert.doesNotMatch(out, /2#CD/);
    // Lightweight when custom rendering is enabled
    assert.match(out, /⎿/);
    assert.doesNotMatch(out, /┌|└|│/);
    // Header with file path and line count
    assert.match(out, /read/);
    assert.match(out, /src\/a\.ts/);
    assert.match(out, /2 lines read/);
  });

  it("preview mode preserves the old collapsed renderer while still stripping anchors", () => {
    const tool = registerReadTool({
      display: "preview",
      originalRenderResult: (result) => new Text(result.content?.[0]?.text ?? "", 0, 0),
    });

    const out = render(
      tool.renderResult(
        { content: [{ type: "text", text: "1#AB|hello" }] },
        { expanded: false },
        theme(),
      ),
    );

    assert.match(out, /hello/);
    assert.doesNotMatch(out, /1#AB/);
    // Lightweight when custom rendering is enabled
    assert.match(out, /⎿/);
    assert.doesNotMatch(out, /┌|└|│/);
  });

  it("delegated renderer also receives anchor-stripped details", () => {
    const tool = registerReadTool({
      display: "preview",
      originalRenderResult: (result) =>
        new Text(String((result.details as { preview?: string } | undefined)?.preview ?? ""), 0, 0),
    });

    const out = render(
      tool.renderResult(
        {
          content: [{ type: "text", text: "1#AB|hello" }],
          details: { preview: "1#AB|from details", nested: ["2#CD|nested detail"] } as never,
        },
        { expanded: false },
        theme(),
      ),
    );

    assert.match(out, /from details/);
    assert.doesNotMatch(out, /1#AB/);
    // Lightweight when custom rendering is enabled
    assert.match(out, /⎿/);
    assert.doesNotMatch(out, /┌|└|│/);
  });

  it("expanded result is wrapped in lightweight result lines", () => {
    const tool = registerReadTool({
      display: "compact",
      originalRenderResult: (result) => new Text(result.content?.[0]?.text ?? "", 0, 0),
    });

    const out = render(
      tool.renderResult(
        { content: [{ type: "text", text: "1#AB|hello" }] },
        { expanded: true },
        theme(),
      ),
    );

    assert.match(out, /hello/);
    assert.doesNotMatch(out, /1#AB/);
    assert.match(out, /⎿/);
    assert.doesNotMatch(out, /┌|└|│/);
  });

  it("compact summary reports truncation without rendering content", () => {
    const out = render(
      renderCompactReadResult(
        {
          content: [{ type: "text", text: "a\nb" }],
          details: { truncation: { truncated: true, totalLines: 5000 } } as never,
        },
        { expanded: false },
        theme(),
      ),
    );

    assert.match(out, /2 lines read/);
    assert.match(out, /truncated from 5000 lines/);
    assert.doesNotMatch(out, /\na\n/);
  });
});
