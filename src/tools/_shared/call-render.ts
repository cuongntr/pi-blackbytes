import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isBoxedToolCallsEnabled } from "./boxed-config.js";
import { renderCompactBoxedToolCall } from "./boxed-render.js";

/** Safely extract a string from unknown args */
export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Truncate a string for display */
export function truncate(s: string, max: number): string {
  if (max <= 1) return max === 1 ? "\u2026" : "";
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

interface RenderCallContext {
  readonly isError?: boolean;
  readonly isPartial?: boolean;
  readonly hasResult?: boolean;
}

function titleFromIconName(_icon: string, name: string): string {
  return name;
}

function titleCaseName(name: string): string {
  return name.length === 0 ? name : `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

/**
 * Build a lightweight Claude-like renderCall function.
 * Returns a function matching Pi's renderCall(args, theme, context) signature.
 */
export function makeRenderCall(
  icon: string,
  name: string,
  formatArgs: (args: Record<string, unknown>, theme: Theme) => string,
) {
  return (
    args: Record<string, unknown> | null | undefined,
    theme: Theme,
    context?: RenderCallContext,
  ) => {
    const safeArgs = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const detail = formatArgs(safeArgs, theme);
    if (isBoxedToolCallsEnabled()) {
      return renderCompactBoxedToolCall(theme, titleFromIconName(icon, name), detail, {
        isError: context?.isError,
        isPartial: context?.isPartial,
        closeBottom: !context?.hasResult,
        bgToken: "toolPendingBg",
      });
    }
    return new Text(
      [theme.fg("toolTitle", titleFromIconName(icon, name)), detail].filter(Boolean).join(" "),
      0,
      0,
    );
  };
}

/** Build a renderCall for sub-agent tools. */
export function makeSubAgentRenderCall(icon: string, name: string, primaryKey: string) {
  return (
    args: Record<string, unknown> | null | undefined,
    theme: Theme,
    context?: RenderCallContext,
  ) => {
    const safeArgs = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const val = str(safeArgs[primaryKey]);
    const detail = val ? theme.fg("accent", `"${truncate(val, 60)}"`) : "";
    if (isBoxedToolCallsEnabled()) {
      return renderCompactBoxedToolCall(theme, titleCaseName(name), detail, {
        isError: context?.isError,
        isPartial: context?.isPartial,
        closeBottom: !context?.hasResult,
        bgToken: "toolPendingBg",
      });
    }
    return new Text(
      [theme.fg("toolTitle", titleCaseName(name)), detail].filter(Boolean).join(" "),
      0,
      0,
    );
  };
}
