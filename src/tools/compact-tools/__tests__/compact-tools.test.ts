import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { parseBlackbytesConfig } from "../../../config/schema.js";
import {
  getCompactToolsConfig,
  registerCompactToolRenderers,
  registerCompactToolsCommand,
} from "../index.js";

const BUILTIN_NAMES = ["read", "bash", "edit", "write", "find", "ls"] as const;

interface RenderableComponent {
  render(width: number): string[];
}

interface RenderContext {
  args: Record<string, unknown>;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: RenderableComponent | undefined;
  state: Record<string, unknown>;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

interface RegisteredTool {
  readonly name: string;
  readonly renderResult?: (
    result: { content: Array<{ type: "text"; text: string }>; details?: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: RenderContext,
  ) => RenderableComponent;
  readonly execute?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

interface CapturedCommand {
  readonly name: string;
  readonly options: {
    readonly description?: string;
    readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  };
}

function config(input: Record<string, unknown> = {}) {
  const parsed = parseBlackbytesConfig(input);
  assert.ok(parsed.ok);
  return parsed.value;
}

function makeTheme(): Theme {
  return {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

function makeRenderContext(args: Record<string, unknown>, isError = false): RenderContext {
  return {
    args,
    toolCallId: "tool-call-1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError,
  };
}

function makeCtx(
  onSetExpanded?: (expanded: boolean) => void,
  cwd = process.cwd(),
): ExtensionContext {
  return {
    cwd,
    ui: {
      setToolsExpanded: onSetExpanded ?? (() => {}),
    },
  } as unknown as ExtensionContext;
}

function makePi(
  opts: {
    activeTools?: readonly string[];
    allTools?: Array<{ name: string; source: string }>;
  } = {},
): {
  pi: ExtensionAPI;
  registeredTools: RegisteredTool[];
  commands: CapturedCommand[];
} {
  const registeredTools: RegisteredTool[] = [];
  const commands: CapturedCommand[] = [];
  const activeTools = opts.activeTools ?? BUILTIN_NAMES;
  const allTools = opts.allTools ?? BUILTIN_NAMES.map((name) => ({ name, source: "builtin" }));

  const pi = {
    registerTool(definition: RegisteredTool) {
      registeredTools.push(definition);
    },
    registerCommand(name: string, options: CapturedCommand["options"]) {
      commands.push({ name, options });
    },
    getActiveTools() {
      return [...activeTools];
    },
    getAllTools() {
      return allTools.map((tool) => ({
        name: tool.name,
        sourceInfo: { source: tool.source },
      }));
    },
  } as unknown as ExtensionAPI;

  return { pi, registeredTools, commands };
}

function renderedText(component: RenderableComponent): string {
  return component.render(200).join("\n");
}

describe("compact tools", () => {
  it("defaults to enabled and compact/collapsed", () => {
    const runtime = getCompactToolsConfig(config());
    assert.deepEqual(runtime, { enabled: true, defaultExpanded: false });
  });

  it("registers compact wrappers for Pi built-ins except grep", () => {
    const expanded: boolean[] = [];
    const { pi, registeredTools } = makePi();

    registerCompactToolRenderers(
      pi,
      config(),
      makeCtx((value) => expanded.push(value)),
    );

    assert.deepEqual(
      registeredTools.map((tool) => tool.name),
      ["read", "bash", "edit", "write", "find", "ls"],
    );
    assert.deepEqual(expanded, [false]);
  });

  it("does not register wrappers when compact_tools is disabled", () => {
    const expanded: boolean[] = [];
    const { pi, registeredTools } = makePi();

    registerCompactToolRenderers(
      pi,
      config({ compact_tools: { enabled: false } }),
      makeCtx((value) => expanded.push(value)),
    );

    assert.deepEqual(registeredTools, []);
    assert.deepEqual(expanded, []);
  });

  it("registers builtin wrappers even when inactive, but does not clobber non-builtin overrides", () => {
    const { pi, registeredTools } = makePi({
      activeTools: [],
      allTools: [
        { name: "read", source: "builtin" },
        { name: "bash", source: "other-extension" },
      ],
    });

    registerCompactToolRenderers(pi, config(), makeCtx());

    assert.deepEqual(
      registeredTools.map((tool) => tool.name),
      ["read"],
    );
  });

  it("skips compact wrappers when builtin provenance is unavailable", () => {
    const { pi, registeredTools } = makePi({
      activeTools: ["read"],
      allTools: [],
    });

    registerCompactToolRenderers(pi, config(), makeCtx());

    assert.deepEqual(registeredTools, []);
  });

  it("renders collapsed read output as a one-line summary", () => {
    const { pi, registeredTools } = makePi();
    registerCompactToolRenderers(pi, config(), makeCtx());
    const readTool = registeredTools.find((tool) => tool.name === "read");
    assert.ok(readTool?.renderResult);

    const component = readTool.renderResult(
      { content: [{ type: "text", text: "alpha\nbeta" }] },
      { expanded: false, isPartial: false },
      makeTheme(),
      makeRenderContext({ path: "/tmp/example.ts" }),
    );

    const text = renderedText(component);
    assert.match(text, /✓ read/);
    assert.match(text, /\/tmp\/example\.ts/);
    assert.match(text, /2 lines/);
    assert.match(text, /expand/);
  });

  it("cleans up bash expanded-render state before returning final compact output", () => {
    const { pi, registeredTools } = makePi({
      allTools: [{ name: "bash", source: "builtin" }],
    });
    registerCompactToolRenderers(pi, config(), makeCtx());
    const bashTool = registeredTools.find((tool) => tool.name === "bash");
    assert.ok(bashTool?.renderResult);

    const context = makeRenderContext({ command: "echo hi" });
    const interval = setInterval(() => {}, 1000);
    context.state.startedAt = Date.now();
    context.state.interval = interval;
    try {
      const component = bashTool.renderResult(
        { content: [{ type: "text", text: "hi" }] },
        { expanded: false, isPartial: false },
        makeTheme(),
        context,
      );

      assert.match(renderedText(component), /✓ \$/);
      assert.equal(context.state.interval, undefined);
      assert.equal(typeof context.state.endedAt, "number");
    } finally {
      clearInterval(interval);
    }
  });

  it("preserves Pi shellCommandPrefix when wrapping bash", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-bb-compact-tools-"));
    const originalAgentDir = process.env.PI_AGENT_DIR;
    try {
      process.env.PI_AGENT_DIR = tmp;
      await writeFile(
        join(tmp, "settings.json"),
        JSON.stringify({ shellCommandPrefix: "export PI_BB_COMPACT_PREFIX=ok" }),
        "utf8",
      );

      const { pi, registeredTools } = makePi({
        activeTools: ["bash"],
        allTools: [{ name: "bash", source: "builtin" }],
      });
      registerCompactToolRenderers(pi, config(), makeCtx(undefined, tmp));
      const bashTool = registeredTools.find((tool) => tool.name === "bash");
      assert.ok(bashTool?.execute);

      const result = await bashTool.execute(
        "tool-call-1",
        { command: 'printf "$PI_BB_COMPACT_PREFIX"', timeout: 5 },
        undefined,
        undefined,
        { cwd: tmp },
      );
      const text = result.content.map((block) => block.text ?? "").join("");

      assert.equal(text, "ok");
    } finally {
      if (originalAgentDir === undefined) {
        delete process.env.PI_AGENT_DIR;
      } else {
        process.env.PI_AGENT_DIR = originalAgentDir;
      }
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("registers /toggle-verbose to switch tool expansion state", async () => {
    const { pi, commands } = makePi();
    registerCompactToolsCommand(pi);
    const command = commands.find((entry) => entry.name === "toggle-verbose");
    assert.ok(command);

    let expanded = false;
    const notifications: string[] = [];
    const ctx = {
      ui: {
        getToolsExpanded: () => expanded,
        setToolsExpanded: (value: boolean) => {
          expanded = value;
        },
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionCommandContext;

    await command.options.handler("", ctx);

    assert.equal(expanded, true);
    assert.deepEqual(notifications, ["Tool output: expanded mode"]);
  });
});
