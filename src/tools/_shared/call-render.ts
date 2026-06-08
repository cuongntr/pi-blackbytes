import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderLightweightToolCall } from "./lightweight-render.js";

/** Safely extract a string from unknown args */
export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Truncate a string for display */
export function truncate(s: string, max: number): string {
  if (max <= 1) return max === 1 ? "\u2026" : "";
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function singleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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
    return renderLightweightToolCall(theme, titleFromIconName(icon, name), detail, {
      isError: context?.isError,
      isPartial: context?.isPartial,
    });
  };
}

/** Build a renderCall for sub-agent tools. */
export function makeSubAgentRenderCall(_icon: string, name: string, primaryKey: string) {
  return (
    args: Record<string, unknown> | null | undefined,
    theme: Theme,
    context?: RenderCallContext,
  ) => {
    const safeArgs = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const val = str(safeArgs[primaryKey]);
    const detail = val ? theme.fg("accent", `"${truncate(singleLine(val), 60)}"`) : "";
    return renderLightweightToolCall(theme, `Agent: ${titleCaseName(name)} `, detail, {
      isError: context?.isError,
      isPartial: context?.isPartial,
    });
  };
}
