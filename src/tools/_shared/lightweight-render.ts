import { type Theme, keyText } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatApproxWords } from "./tool-output.js";

const CALL_MARK = "⏺";
const RESULT_MARK = "  ⎿  ";
const RESULT_CONTINUATION = "     ";

export interface LightweightCallOptions {
  readonly isError?: boolean;
  readonly isPartial?: boolean;
}

export interface LightweightResultOptions extends LightweightCallOptions {
  readonly footerLines?: readonly string[];
  readonly emptyText?: string;
  readonly live?: boolean;
}

function lineWidth(width: number): number {
  const finiteWidth = Number.isFinite(width) ? Math.floor(width) : 1;
  return Math.max(1, finiteWidth);
}

export function innerWidth(width: number): number {
  return Math.max(1, lineWidth(width) - visibleWidth(RESULT_MARK));
}

function componentFromBody(body: Component | readonly string[] | string): Component {
  if (typeof body === "string") return new Text(body, 0, 0);
  if (Array.isArray(body)) return new Text((body as readonly string[]).join("\n"), 0, 0);
  return body as Component;
}

function cachedComponent(
  compute: (width: number) => string[],
  opts: { readonly live?: boolean; readonly onInvalidate?: () => void } = {},
): Component {
  const cache = new Map<number, string[]>();
  const lastRenderAt = new Map<number, number>();
  const LIVE_CACHE_MS = 100;
  return {
    invalidate() {
      cache.clear();
      lastRenderAt.clear();
      opts.onInvalidate?.();
    },
    render(width: number): string[] {
      const renderedWidth = lineWidth(width);
      const hit = cache.get(renderedWidth);
      const now = Date.now();
      if (hit) {
        if (!opts.live) return hit;
        const widthLastRenderAt = lastRenderAt.get(renderedWidth) ?? 0;
        if (now - widthLastRenderAt < LIVE_CACHE_MS) return hit;
      }
      const lines = compute(renderedWidth);
      cache.set(renderedWidth, lines);
      lastRenderAt.set(renderedWidth, Date.now());
      return lines;
    },
  };
}

function compactStatus(theme: Theme, opts: LightweightCallOptions): string {
  if (opts.isError) return theme.fg("error", "✗");
  if (opts.isPartial) return theme.fg("accent", "…");
  return "";
}

function callMarkToken(opts: LightweightCallOptions): "success" | "error" | "accent" {
  if (opts.isError) return "error";
  if (opts.isPartial) return "accent";
  return "success";
}

export function formatLightweightTitle(
  theme: Theme,
  toolName: string,
  opts: LightweightCallOptions = {},
): string {
  const status = compactStatus(theme, opts);
  const suffix = status ? ` ${status}` : "";
  const mark = theme.fg(callMarkToken(opts), CALL_MARK);
  return `${mark} ${theme.fg("toolTitle", theme.bold(toolName))}${suffix}`;
}

export function renderLightweightToolCall(
  theme: Theme,
  toolName: string,
  detailLine = "",
  opts: LightweightCallOptions = {},
): Component {
  return cachedComponent((width) => {
    const detail = detailLine ? `(${detailLine})` : "";
    return [
      truncateToWidth(`${formatLightweightTitle(theme, toolName, opts)}${detail}`, width, "…"),
    ];
  });
}

function prefixBodyLines(
  theme: Theme,
  bodyLines: readonly string[],
  opts: LightweightResultOptions,
): string[] {
  const contentLines =
    bodyLines.length > 0 ? [...bodyLines] : [theme.fg("muted", opts.emptyText ?? "(no output)")];
  if (opts.isError) contentLines.unshift(theme.fg("error", "✗ Error"));

  const lines: string[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    const prefix = i === 0 ? RESULT_MARK : RESULT_CONTINUATION;
    lines.push(`${theme.fg("muted", prefix)}${contentLines[i]}`);
  }

  if (opts.footerLines && opts.footerLines.length > 0) {
    for (const footer of opts.footerLines) {
      lines.push(`${theme.fg("muted", RESULT_CONTINUATION)}${footer}`);
    }
  }
  return lines;
}

export function renderLightweightToolResult(
  theme: Theme,
  body: Component | readonly string[] | string,
  opts: LightweightResultOptions = {},
): Component {
  const bodyComponent = componentFromBody(body);
  return cachedComponent(
    (width) => {
      bodyComponent.invalidate?.();
      const bodyLines = bodyComponent.render(innerWidth(width));
      return prefixBodyLines(theme, bodyLines, opts).map((line) =>
        truncateToWidth(line, width, "…"),
      );
    },
    { live: Boolean(opts.live), onInvalidate: () => bodyComponent.invalidate?.() },
  );
}

export function lightweightExpandHint(theme: Theme): string {
  const key = keyText("app.tools.expand") || "ctrl+o";
  return theme.fg("accent", `${key} to expand`);
}

export function formatLightweightFooter(
  theme: Theme,
  text: string,
  extraParts: readonly string[] = [],
): string {
  const parts = [...extraParts.filter(Boolean), formatApproxWords(text)].map((part) =>
    theme.fg("muted", part),
  );
  return parts.join(theme.fg("muted", " · "));
}
