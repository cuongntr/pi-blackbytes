import * as PiAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { BlackbytesUiConfig } from "../../config/schema.js";
import {
  formatLightweightFooter,
  renderLightweightToolCall,
  renderLightweightToolResult,
} from "../_shared/lightweight-render.js";
import { highlightShellLine } from "../_shared/shell-highlight.js";
import {
  expandedPreview,
  getTextOutput,
  headTailPreview,
  tailPreview,
} from "../_shared/tool-output.js";

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
  opts: { readonly cwd: string; readonly ui: BlackbytesUiConfig; readonly factory?: BashFactory },
): boolean {
  if (!opts.ui.bash_wrapper_enabled) return false;
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
    // Use the self shell so Pi does not wrap the lightweight call/result lines
    // in its default built-in tool wrapper.
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
      const detailParts = [highlightShellLine(commandLines[0] ?? "", theme)];
      if (commandLines.length > 1) {
        const hiddenLineCount = commandLines.length - 1;
        const noun = hiddenLineCount === 1 ? "line" : "lines";
        detailParts.push(theme.fg("muted", `… ${hiddenLineCount} more ${noun}`));
      }
      return renderLightweightToolCall(theme, "Bash", detailParts.join(theme.fg("muted", " ")), {
        isError: context?.isError,
        isPartial: context?.isPartial,
      });
    },
    renderResult(
      result: unknown,
      options: { expanded: boolean; isPartial?: boolean },
      theme: Theme,
      context?: BashRenderContext,
    ) {
      if (options.isPartial) {
        return renderLightweightToolResult(
          theme,
          new Text(theme.fg("muted", "Running command..."), 0, 0),
          { isPartial: true },
        );
      }
      const text = getTextOutput(result as never);
      const isError = Boolean(
        context?.isError || (result as { isError?: boolean } | undefined)?.isError,
      );
      const outputColor = isError ? "error" : opts.ui.bash_dim_output ? "toolOutput" : "text";
      const lines: string[] = [];
      if (!options.expanded && isError) {
        const preview = headTailPreview(text, opts.ui.bash_max_preview_lines);
        lines.push(...preview.headLines.map((line) => theme.fg(outputColor, line)));
        if (preview.omittedLines > 0) {
          const location =
            preview.headLines.length > 0 && preview.tailLines.length > 0
              ? "middle "
              : preview.headLines.length > 0
                ? "later "
                : "";
          lines.push(theme.fg("muted", `… ${preview.omittedLines} ${location}lines hidden`));
        }
        lines.push(...preview.tailLines.map((line) => theme.fg(outputColor, line)));
      } else {
        const preview = options.expanded
          ? expandedPreview(text, opts.ui.bash_max_expanded_lines)
          : tailPreview(text, opts.ui.bash_max_preview_lines);
        lines.push(...preview.lines.map((line) => theme.fg(outputColor, line)));
        if (preview.omittedLines > 0) {
          const label = options.expanded
            ? `… ${preview.omittedLines} more lines omitted by bash_max_expanded_lines`
            : `… ${preview.omittedLines} earlier lines hidden`;
          lines.push(theme.fg("muted", label));
        }
      }
      // Only surface the timeout when the call set one explicitly. Falling back
      // to a fixed default made every result show the same "300s", which is
      // noise rather than the command's actual run time.
      const explicitTimeout = context?.args?.timeout;
      const extraFooter =
        typeof explicitTimeout === "number" ? [theme.fg("muted", `⏹ ${explicitTimeout}s`)] : [];
      const footer = formatLightweightFooter(theme, text, extraFooter);
      return renderLightweightToolResult(theme, new Text(lines.join("\n"), 0, 0), {
        isError,
        footerLines: [footer],
        emptyText: "(no output)",
      });
    },
  } as never);
  return true;
}

function getCreateBashTool(): BashFactory | undefined {
  const candidate = (PiAgent as { readonly createBashTool?: unknown }).createBashTool;
  return typeof candidate === "function" ? (candidate as BashFactory) : undefined;
}
