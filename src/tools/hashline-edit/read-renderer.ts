/**
 * Override the built-in read tool's renderResult so hashline anchors stay in
 * conversation history for the LLM, while the TUI remains compact and clean.
 */
import {
  type ExtensionAPI,
  type ReadToolDetails,
  SettingsManager,
  type Theme,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import type { BoxedUiConfig } from "../../config/schema.js";
import { isBoxedToolCallsEnabled } from "../_shared/boxed-config.js";
import { renderBoxedToolResult } from "../_shared/boxed-render.js";
import { countLines, getTextOutput, stripTrailingNoticeLines } from "../_shared/tool-output.js";

const ANCHOR_PATTERN = /^\d+#[A-Z]{2}\|/;

interface ReadContentBlock {
  readonly type: string;
  readonly text?: string;
}

interface ReadRenderResult {
  readonly content?: ReadonlyArray<ReadContentBlock>;
  readonly details?: ReadToolDetails;
}

interface ReadRenderOptions {
  readonly expanded?: boolean;
  readonly isPartial?: boolean;
}

interface ReadRenderContext {
  readonly args?: Record<string, unknown>;
}

interface ReadTool {
  readonly renderResult?: (
    result: ReadRenderResult,
    options: ReadRenderOptions,
    theme: Theme,
    context: unknown,
  ) => Component;
  readonly renderCall?: (
    args: Record<string, unknown> | null | undefined,
    theme: Theme,
    context: unknown,
  ) => Component;
  readonly [key: string]: unknown;
}

type ReadToolFactory = (cwd: string, options?: { autoResizeImages?: boolean }) => ReadTool;

interface ReadRendererOptions {
  readonly ui?: Pick<BoxedUiConfig, "read_tool_display">;
  readonly factory?: ReadToolFactory;
}

interface ReadTruncationDetails {
  readonly truncation?: {
    readonly truncated?: boolean;
    readonly totalLines?: number;
  };
}

function stripAnchors(text: string): string {
  return text
    .split("\n")
    .map((line) => (ANCHOR_PATTERN.test(line) ? line.replace(ANCHOR_PATTERN, "") : line))
    .join("\n");
}

function stripContentAnchors(
  content: ReadonlyArray<ReadContentBlock> | undefined,
): ReadContentBlock[] {
  return (content ?? []).map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { ...block, text: stripAnchors(block.text) };
    }
    return block;
  });
}

function stripAnchorStrings<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value === "string") return stripAnchors(value) as T;
  if (value === null || typeof value !== "object") return value;

  const cached = seen.get(value);
  if (cached) return cached as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    copy.push(...value.map((item) => stripAnchorStrings(item, seen)));
    return copy as T;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = stripAnchorStrings(item, seen);
  }
  return copy as T;
}

function formatLineCount(lines: number): string {
  return lines === 1 ? "1 line read" : `${lines} lines read`;
}

function getTruncationSuffix(details: unknown): string {
  const truncation = (details as ReadTruncationDetails | undefined)?.truncation;
  if (!truncation?.truncated) return "";
  if (typeof truncation.totalLines === "number") {
    return ` (truncated from ${truncation.totalLines} lines)`;
  }
  return " (truncated)";
}

function positiveIntegerArg(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function formatReadTarget(args: Record<string, unknown> | undefined, theme: Theme): string {
  const rawPath = args?.path;
  if (typeof rawPath !== "string" || rawPath.length === 0) return "";

  let target = theme.fg("accent", rawPath);
  const offset = positiveIntegerArg(args?.offset);
  const limit = positiveIntegerArg(args?.limit);
  if (offset !== undefined || limit !== undefined) {
    const start = offset ?? 1;
    const end = limit !== undefined ? start + limit - 1 : undefined;
    target += theme.fg("warning", `:${start}${end !== undefined ? `-${end}` : ""}`);
  }
  return target;
}

function compactReadPrefix(context: ReadRenderContext | undefined, theme: Theme): string {
  const lead = `  ${theme.fg("muted", "➜")} `;
  const target = formatReadTarget(context?.args, theme);
  if (!target) return `${lead}${theme.fg("toolTitle", theme.bold("read"))} `;
  return `${lead}${theme.fg("toolTitle", theme.bold("read"))} ${target} `;
}

function buildExpandedHeader(
  result: ReadRenderResult,
  theme: Theme,
  context: ReadRenderContext | undefined,
): string {
  const target = formatReadTarget(context?.args, theme);
  const content = result.content ?? [];

  if (content.some((block) => block.type === "image")) {
    const parts = [
      theme.fg("success", "✓"),
      theme.fg("toolTitle", theme.bold("read")),
      ...(target ? [target] : []),
      theme.fg("muted", "·"),
      theme.fg("muted", "Image loaded"),
    ];
    return parts.join(" ");
  }

  const text = stripTrailingNoticeLines(getTextOutput({ content }));
  const lineCount = countLines(text);
  const parts = [
    theme.fg("success", "✓"),
    theme.fg("toolTitle", theme.bold("read")),
    ...(target ? [target] : []),
    theme.fg("muted", "·"),
    theme.fg("muted", formatLineCount(lineCount)),
  ];
  const truncation = getTruncationSuffix(result.details);
  if (truncation) parts.push(theme.fg("warning", truncation));
  return parts.join(" ");
}

export function renderCompactReadResult(
  result: ReadRenderResult,
  options: ReadRenderOptions,
  theme: Theme,
  context?: ReadRenderContext,
): Component {
  const prefix = compactReadPrefix(context, theme);
  if (options.isPartial) return new Text(`${prefix}${theme.fg("muted", "Reading...")}`, 0, 0);

  const content = result.content ?? [];
  if (content.some((block) => block.type === "image")) {
    return new Text(`${prefix}${theme.fg("success", "✓")} Image loaded`, 0, 0);
  }

  const text = stripTrailingNoticeLines(getTextOutput({ content }));
  const lineCount = countLines(text);
  const summary = `${prefix}${theme.fg("success", "✓")} ${formatLineCount(
    lineCount,
  )}${getTruncationSuffix(result.details)}`;
  return new Text(summary, 0, 0);
}

export function registerCleanReadRenderer(
  pi: ExtensionAPI,
  cwd: string,
  opts: ReadRendererOptions = {},
): void {
  let readOptions: { autoResizeImages?: boolean } = {};
  try {
    const settings = SettingsManager.create(cwd, process.env.PI_AGENT_DIR);
    readOptions = { autoResizeImages: settings.getImageAutoResize() };
  } catch {
    // ignore
  }

  const factory =
    opts.factory ??
    ((toolCwd: string, options?: { autoResizeImages?: boolean }) =>
      createReadToolDefinition(toolCwd, options) as unknown as ReadTool);
  const original = factory(cwd, readOptions);
  const originalRenderResult = original.renderResult;

  if (!originalRenderResult) return;

  const display = opts.ui?.read_tool_display ?? "compact";

  // Re-register with stripped-anchor renderResult. Compact mode changes only
  // what the user sees while leaving returned tool content untouched for the LLM.
  const override = {
    ...original,
    ...(display === "compact"
      ? {
          renderShell: "self",
          renderCall: () => new Container(),
        }
      : {}),
    renderResult(
      result: ReadRenderResult,
      options: ReadRenderOptions,
      theme: Theme,
      context: unknown,
    ) {
      const cleanResult = {
        ...result,
        content: stripContentAnchors(result.content),
        details: stripAnchorStrings(result.details),
      };
      if (display === "compact" && !options.expanded) {
        return renderCompactReadResult(cleanResult, options, theme, context as ReadRenderContext);
      }
      const inner = originalRenderResult(cleanResult, options, theme, context);
      if (isBoxedToolCallsEnabled()) {
        const header = buildExpandedHeader(cleanResult, theme, context as ReadRenderContext);
        const body = new Container();
        body.addChild(new Text(header, 0, 0));
        body.addChild(inner);
        return renderBoxedToolResult(theme, body, {
          seamTop: true,
          bgToken: "toolSuccessBg",
        });
      }
      return inner;
    },
  };

  pi.registerTool(override as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
}
