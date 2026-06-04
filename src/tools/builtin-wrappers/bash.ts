import * as PiAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { BoxedUiConfig } from "../../config/schema.js";
import {
  formatBoxedFooter,
  renderBoxedToolCall,
  renderBoxedToolResult,
} from "../_shared/boxed-render.js";
import { highlightShellLine } from "../_shared/shell-highlight.js";
import { expandedPreview, getTextOutput, tailPreview } from "../_shared/tool-output.js";

const MAX_COMMAND_LINES = 6;

interface BashTool {
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate: unknown,
  ) => unknown;
  readonly [key: string]: unknown;
}

type BashFactory = (cwd: string, config?: unknown) => BashTool;

interface BashRenderContext {
  readonly args?: Record<string, unknown>;
  readonly isError?: boolean;
  readonly isPartial?: boolean;
  readonly hasResult?: boolean;
}

export function registerBashWrapper(
  pi: ExtensionAPI,
  opts: { readonly cwd: string; readonly ui: BoxedUiConfig; readonly factory?: BashFactory },
): boolean {
  if (!opts.ui.boxed_builtin_tools) return false;
  const factory = opts.factory ?? getCreateBashTool();
  if (!factory) return false;
  let base: BashTool;
  try {
    base = factory(opts.cwd, undefined as never);
  } catch {
    return false;
  }

  pi.registerTool({
    ...base,
    // Our renderers draw a complete box (borders, padding, seam). Use the
    // self shell so Pi does not wrap that box in its default Box shell, which
    // adds an outer background band and extra padding around our frame.
    renderShell: "self",
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      onUpdate: unknown,
    ) => {
      return base.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(
      args: Record<string, unknown> | null | undefined,
      theme: Theme,
      context?: BashRenderContext,
    ) {
      const command = String(args?.command ?? "");
      const commandLines = command.split("\n");
      const shown = commandLines.slice(0, MAX_COMMAND_LINES).map((line, index) => {
        const prompt = theme.fg("muted", index === 0 ? "$ " : "> ");
        return `${prompt}${highlightShellLine(line, theme)}`;
      });
      if (commandLines.length > MAX_COMMAND_LINES) {
        shown.push(theme.fg("muted", `… ${commandLines.length - MAX_COMMAND_LINES} more lines`));
      }
      // Always leave bottom open: same rationale as sub-agent call boxes —
      // Pi only calls renderCall once and never re-renders when the result arrives.
      return renderBoxedToolCall(theme, "bash", shown, {
        isError: context?.isError,
        isPartial: context?.isPartial,
        closeBottom: false,
        bgToken: "toolPendingBg",
      });
    },
    renderResult(
      result: unknown,
      options: { expanded: boolean; isPartial?: boolean },
      theme: Theme,
      context?: BashRenderContext,
    ) {
      if (options.isPartial) {
        return renderBoxedToolResult(
          theme,
          new Text(theme.fg("muted", "Running command..."), 0, 0),
          {
            isPartial: true,
            seamTop: true,
            bgToken: "toolPendingBg",
          },
        );
      }
      const text = getTextOutput(result as never);
      const isError = Boolean(
        context?.isError || (result as { isError?: boolean } | undefined)?.isError,
      );
      const preview = options.expanded
        ? expandedPreview(text, opts.ui.boxed_max_expanded_lines)
        : tailPreview(text, opts.ui.boxed_max_preview_lines);
      const lines = preview.lines.map((line) =>
        theme.fg(isError ? "error" : opts.ui.boxed_dim_output ? "toolOutput" : "text", line),
      );
      if (preview.omittedLines > 0) {
        const label = options.expanded
          ? `… ${preview.omittedLines} more lines omitted by boxed_max_expanded_lines`
          : `… ${preview.omittedLines} earlier lines hidden`;
        lines.push(theme.fg("muted", label));
      }
      // Only surface the timeout when the call set one explicitly. Falling back
      // to a fixed default made every result show the same "300s", which is
      // noise rather than the command's actual run time.
      const explicitTimeout = context?.args?.timeout;
      const extraFooter =
        typeof explicitTimeout === "number" ? [theme.fg("muted", `⏹ ${explicitTimeout}s`)] : [];
      const footer = formatBoxedFooter(theme, text, extraFooter);
      return renderBoxedToolResult(theme, new Text(lines.join("\n"), 0, 0), {
        isError,
        footerLines: [footer],
        emptyText: "(no output)",
        seamTop: true,
        bgToken: "toolPendingBg",
      });
    },
  } as never);
  return true;
}

function getCreateBashTool(): BashFactory | undefined {
  const candidate = (PiAgent as { readonly createBashTool?: unknown }).createBashTool;
  return typeof candidate === "function" ? (candidate as BashFactory) : undefined;
}
