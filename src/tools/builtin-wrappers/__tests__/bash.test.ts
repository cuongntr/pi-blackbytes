import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BoxedUiConfig } from "../../../config/schema.js";
import { registerBashWrapper } from "../bash.js";

const ui: BoxedUiConfig = {
  boxed_tool_calls: true,
  boxed_builtin_tools: true,
  boxed_max_preview_lines: 5,
  boxed_max_expanded_lines: 200,
  boxed_dim_output: false,
  read_tool_display: "compact",
};

interface RegisteredTool {
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate: unknown,
  ) => unknown;
  readonly [key: string]: unknown;
}

interface RenderableText {
  readonly render: (width: number) => string[];
}

interface StubTheme {
  readonly fg: (token: string, text: string) => string;
  readonly bg: (token: string, text: string) => string;
  readonly bold: (text: string) => string;
}

interface RenderableRegisteredTool extends RegisteredTool {
  readonly renderCall: (
    args: Record<string, unknown> | null | undefined,
    theme: StubTheme,
    context?: Record<string, unknown>,
  ) => unknown;
  readonly renderResult: (
    result: unknown,
    options: { readonly expanded: boolean; readonly isPartial?: boolean },
    theme: StubTheme,
    context?: Record<string, unknown>,
  ) => unknown;
}

function piCapturingTool(capture: (tool: RegisteredTool) => void): ExtensionAPI {
  return {
    registerTool: (tool: RegisteredTool) => {
      capture(tool);
    },
  } as unknown as ExtensionAPI;
}

function theme(): StubTheme {
  return {
    fg: (token: string, text: string) => `«${token}:${text}»`,
    bg: (token: string, text: string) => `«bg:${token}:${text}»`,
    bold: (text: string) => `«bold:${text}»`,
  };
}

function render(value: unknown, width = 100): string {
  return (value as RenderableText).render(width).join("\n");
}

function assertRenderableTool(tool: RegisteredTool): asserts tool is RenderableRegisteredTool {
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
}

function registerEnabledTool(config: BoxedUiConfig = ui): RegisteredTool {
  let registeredTool: RegisteredTool | undefined;
  const enabled = registerBashWrapper(
    piCapturingTool((tool) => {
      registeredTool = tool;
    }),
    {
      cwd: "/tmp",
      ui: config,
      factory: () => ({
        name: "bash",
        execute: (toolCallId: string, params: unknown) => ({ toolCallId, params }),
      }),
    },
  );

  assert.equal(enabled, true);
  assert.ok(registeredTool);
  return registeredTool;
}

describe("registerBashWrapper", () => {
  it("does not register when builtin boxing is disabled", () => {
    let registered = false;
    const enabled = registerBashWrapper(
      piCapturingTool(() => {
        registered = true;
      }),
      {
        cwd: "/tmp",
        ui: { ...ui, boxed_builtin_tools: false },
        factory: () => ({ execute: () => "unused" }),
      },
    );

    assert.equal(enabled, false);
    assert.equal(registered, false);
  });

  it("fails closed when the bash factory throws", () => {
    let registered = false;
    const enabled = registerBashWrapper(
      piCapturingTool(() => {
        registered = true;
      }),
      {
        cwd: "/tmp",
        ui,
        factory: () => {
          throw new Error("missing createBashTool");
        },
      },
    );

    assert.equal(enabled, false);
    assert.equal(registered, false);
  });

  it("delegates execution to the registered base tool without recreating it", async () => {
    let registeredTool: RegisteredTool | undefined;
    let factoryCalls = 0;
    const enabled = registerBashWrapper(
      piCapturingTool((tool) => {
        registeredTool = tool;
      }),
      {
        cwd: "/tmp",
        ui,
        factory: () => {
          factoryCalls += 1;
          return {
            name: "bash",
            execute: (toolCallId: string, params: unknown) => ({ toolCallId, params }),
          };
        },
      },
    );

    assert.equal(enabled, true);
    assert.equal(factoryCalls, 1);
    assert.ok(registeredTool);

    const result = await registeredTool.execute(
      "call-1",
      { command: "pwd" },
      new AbortController().signal,
      undefined,
    );

    assert.deepEqual(result, { toolCallId: "call-1", params: { command: "pwd" } });
    assert.equal(factoryCalls, 1);
  });

  it("renders highlighted commands in the shared lightweight style", () => {
    const tool = registerEnabledTool();
    assertRenderableTool(tool);

    const out = render(
      tool.renderCall({ command: "bun run test\n--watch" }, theme(), { isPartial: true }),
      200,
    );

    assert.match(out, /«accent:⏺»/);
    assert.match(out, /Bash/);
    assert.match(out, /«syntaxFunction:bun»/);
    assert.match(out, /more line/);
    assert.match(out, /«accent:…»/);
    assert.doesNotMatch(out, /┌|└|│|\$ | > /);

    const withResult = render(
      tool.renderCall({ command: "bun run test\n--watch" }, theme(), {
        isPartial: true,
        hasResult: true,
      }),
    );
    assert.doesNotMatch(withResult, /┌|└|│/);
  });

  it("renders collapsed tail preview, error color, and footer", () => {
    const tool = registerEnabledTool({ ...ui, boxed_max_preview_lines: 2 });
    assertRenderableTool(tool);

    const out = render(
      tool.renderResult(
        {
          content: [{ type: "text", text: "line1\nline2\nline3\nline4" }],
        },
        { expanded: false },
        theme(),
        { args: { timeout: 12 }, isError: true },
      ),
    );

    assert.match(out, /«error:line3»/);
    assert.match(out, /«error:line4»/);
    assert.doesNotMatch(out, /line1/);
    assert.match(out, /earlier lines hidden/);
    assert.match(out, /⏹ 12s/);
    assert.match(out, /~4 words/);
  });

  it("omits the timeout footer when no explicit timeout is passed", () => {
    const tool = registerEnabledTool(ui);
    assertRenderableTool(tool);

    const out = render(
      tool.renderResult(
        { content: [{ type: "text", text: "hello" }] },
        { expanded: false },
        theme(),
        { args: {} },
      ),
    );

    // Default timeout used to always print "⏹ 300s"; now it is hidden as noise.
    assert.doesNotMatch(out, /⏹/);
    assert.match(out, /~1 words/);
  });

  it("renders expanded output caps and partial state", () => {
    const tool = registerEnabledTool({ ...ui, boxed_max_expanded_lines: 2 });
    assertRenderableTool(tool);

    const expanded = render(
      tool.renderResult(
        {
          content: [{ type: "text", text: "line1\nline2\nline3" }],
        },
        { expanded: true },
        theme(),
        { args: { timeout: 30 } },
      ),
    );
    const partial = render(tool.renderResult({}, { expanded: false, isPartial: true }, theme()));

    assert.match(expanded, /line1/);
    assert.match(expanded, /line2/);
    assert.doesNotMatch(expanded, /line3/);
    assert.match(expanded, /boxed_max_expanded_lines/);
    assert.match(partial, /Running command/);
  });
});
