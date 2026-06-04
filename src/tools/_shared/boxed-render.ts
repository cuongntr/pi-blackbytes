import { type Theme, keyText } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatApproxWords } from "./tool-output.js";

const H = "─";
const V = "│";
const SIDE_PAD = 2;

export interface BoxStateOptions {
  readonly isError?: boolean;
  readonly isPartial?: boolean;
  // Close the call box when Pi has not rendered a result slot yet. Once a
  // seam-top result exists, leave the bottom open so call + result read as one
  // continuous frame.
  readonly closeBottom?: boolean;
  // Optional background fill applied to every box line. Omit to keep the box
  // transparent (matching the terminal background).
  readonly bgToken?: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg";
}

export interface BoxedResultOptions extends BoxStateOptions {
  readonly footerLines?: readonly string[];
  readonly emptyText?: string;
  // When true, open with a seam divider instead of a top border so this result
  // visually continues a call box rendered directly above (one frame, two
  // slots). Default false: the result stands alone as a self-closed box.
  readonly seamTop?: boolean;
  // When true, skip the width cache so a live inner component (e.g. a spinner
  // that re-renders every tick) is re-rendered each call instead of serving a
  // stale cached frame.
  readonly live?: boolean;
}

export function boxWidth(width: number): number {
  // Never exceed the width Pi grants us: a wider line wraps in the terminal,
  // so Pi paints more rows than it measured and duplicates the box in
  // scrollback. Narrow widths are rendered with adaptive padding rather than
  // forcing a minimum wider than the granted column count.
  const finiteWidth = Number.isFinite(width) ? Math.floor(width) : 1;
  return Math.max(1, finiteWidth);
}

function sidePadWidth(width: number): number {
  const renderedWidth = boxWidth(width);
  if (renderedWidth >= 2 + SIDE_PAD * 2 + 1) return SIDE_PAD;
  return Math.max(0, Math.floor((renderedWidth - 3) / 2));
}

export function boxInnerWidth(width: number): number {
  const renderedWidth = boxWidth(width);
  if (renderedWidth <= 2) return 1;
  return Math.max(1, renderedWidth - 2 - sidePadWidth(renderedWidth) * 2);
}

function frame(theme: Theme, text: string): string {
  return theme.fg("border", text);
}

function border(theme: Theme, left: string, right: string, width: number): string {
  const renderedWidth = boxWidth(width);
  if (renderedWidth === 1) return frame(theme, left);
  return frame(theme, `${left}${H.repeat(Math.max(0, renderedWidth - 2))}${right}`);
}

function line(theme: Theme, content: string, width: number): string {
  const renderedWidth = boxWidth(width);
  if (renderedWidth === 1) return frame(theme, V);
  if (renderedWidth === 2) return frame(theme, `${V}${V}`);
  const padWidth = sidePadWidth(renderedWidth);
  const inner = Math.max(0, renderedWidth - 2 - padWidth * 2);
  const truncated = inner > 0 ? truncateToWidth(content, inner, "…") : "";
  const fill = " ".repeat(Math.max(0, inner - visibleWidth(truncated)));
  const pad = " ".repeat(padWidth);
  return `${frame(theme, V)}${pad}${truncated}${fill}${pad}${frame(theme, V)}`;
}

function divider(theme: Theme, width: number): string {
  const renderedWidth = boxWidth(width);
  if (renderedWidth === 1) return frame(theme, V);
  if (renderedWidth === 2) return frame(theme, `${V}${V}`);
  const inner = Math.max(0, renderedWidth - 2 - sidePadWidth(renderedWidth) * 2);
  const pad = " ".repeat(sidePadWidth(renderedWidth));
  // Use the same `border` colour as the outer frame so the seam/divider does
  // not visually disappear against the box background (borderMuted was too dark).
  return `${frame(theme, V)}${pad}${frame(theme, H.repeat(inner))}${pad}${frame(theme, V)}`;
}

function wrapBoxed(theme: Theme, content: string, width: number): string[] {
  return wrapTextWithAnsi(content, boxInnerWidth(width)).map((wrapped) =>
    line(theme, wrapped, width),
  );
}

// A full-width empty content row, used as vertical padding inside the box so
// content does not sit flush against the top/bottom borders.
function blankLine(theme: Theme, width: number): string {
  return line(theme, "", width);
}

// Optionally paint a background across every box line. No-op when no token is
// given, keeping the box transparent.
function applyBg(theme: Theme, lines: string[], token?: BoxStateOptions["bgToken"]): string[] {
  if (!token) return lines;
  return lines.map((l) => theme.bg(token, l));
}

// Width-keyed render cache. Pi calls render(width) many times while scrolling;
// recomputing wrapping/padding every time is the source of scroll lag, and a
// non-cached component can drift if recomputation is ever non-idempotent.
function cachedComponent(compute: (width: number) => string[]): Component {
  const cache = new Map<number, string[]>();
  return {
    invalidate() {
      cache.clear();
    },
    render(width: number): string[] {
      const hit = cache.get(width);
      if (hit) return hit;
      const lines = compute(width);
      cache.set(width, lines);
      return lines;
    },
  };
}

function statusIcon(theme: Theme, isError?: boolean, isPartial?: boolean): string {
  if (isPartial) return theme.fg("accent", "…");
  return isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

export function formatBoxedTitle(
  theme: Theme,
  toolName: string,
  opts: BoxStateOptions = {},
): string {
  const title = `➔ ${toolName} ${statusIcon(theme, opts.isError, opts.isPartial)}`;
  return theme.fg("toolTitle", theme.bold(title));
}

export function renderBoxedToolCall(
  theme: Theme,
  toolName: string,
  detailLines: readonly string[],
  opts: BoxStateOptions = {},
): Component {
  const compute = (width: number): string[] => {
    const renderedWidth = boxWidth(width);
    const lines = [
      border(theme, "┌", "┐", renderedWidth),
      line(theme, formatBoxedTitle(theme, toolName, opts), renderedWidth),
    ];
    if (detailLines.length > 0) {
      lines.push(divider(theme, renderedWidth));
      for (const detail of detailLines) {
        lines.push(...wrapBoxed(theme, detail, renderedWidth));
      }
    }
    // lines.push(blankLine(theme, renderedWidth));
    if (opts.closeBottom) lines.push(border(theme, "└", "┘", renderedWidth));
    // Normally the call box leaves its bottom open: a result box renders directly
    // below and draws the seam divider plus the closing border, so the two slots
    // read as one frame. closeBottom covers the brief state before Pi has a
    // result slot to render.
    return applyBg(theme, lines, opts.bgToken);
  };
  // No width-keyed cache: closeBottom is dynamic (true when no result yet,
  // false once a result slot exists). Caching by width alone would stale
  // the bottom border and break the seam between call box and result box.
  return {
    invalidate() {},
    render(width: number): string[] {
      return compute(width);
    },
  };
}

export function renderCompactBoxedToolCall(
  theme: Theme,
  toolName: string,
  detailLine = "",
  opts: BoxStateOptions = {},
): Component {
  const compute = (width: number): string[] => {
    const renderedWidth = boxWidth(width);
    const title = `${formatBoxedTitle(theme, toolName, opts)}${
      detailLine ? ` ${theme.fg("muted", "|")} ${detailLine}` : ""
    }`;
    const lines = [
      border(theme, "┌", "┐", renderedWidth),
      line(theme, title, renderedWidth),
      // blankLine(theme, renderedWidth),
    ];
    if (opts.closeBottom) lines.push(border(theme, "└", "┘", renderedWidth));
    // Normally leave the bottom open: a seam-top result box renders directly
    // below and draws the seam divider plus the closing border, so call + result
    // read as one continuous frame (same pattern as renderBoxedToolCall).
    return applyBg(theme, lines, opts.bgToken);
  };
  // No width-keyed cache: closeBottom is dynamic (true during partial, false once
  // a result slot exists). Caching by width alone would stale the bottom border
  // and break the seam between call box and result box.
  return {
    invalidate() {},
    render(width: number): string[] {
      return compute(width);
    },
  };
}

export function renderBoxedToolResult(
  theme: Theme,
  body: Component | readonly string[] | string,
  opts: BoxedResultOptions = {},
): Component {
  let bodyComponent: Component;
  if (typeof body === "string") {
    bodyComponent = new Text(body, 0, 0);
  } else if (Array.isArray(body)) {
    bodyComponent = new Text((body as readonly string[]).join("\n"), 0, 0);
  } else {
    bodyComponent = body as Component;
  }
  const cache = new Map<number, string[]>();
  return {
    invalidate() {
      cache.clear();
      bodyComponent.invalidate?.();
    },
    render(width: number): string[] {
      if (!opts.live) {
        const hit = cache.get(width);
        if (hit) return hit;
      }
      const renderedWidth = boxWidth(width);
      const bodyLines = bodyComponent.render(boxInnerWidth(renderedWidth));
      const contentLines =
        bodyLines.length > 0 ? bodyLines : [theme.fg("muted", opts.emptyText ?? "(no output)")];
      // Continue the call box above with a seam divider, or stand alone with a
      // full top border.
      const lines = [
        opts.seamTop ? divider(theme, renderedWidth) : border(theme, "┌", "┐", renderedWidth),
      ];
      // Standalone boxes need their own top padding; seam boxes inherit it from
      // the call box's trailing blank line.
      // if (!opts.seamTop) lines.push(blankLine(theme, renderedWidth));
      if (opts.isError)
        lines.push(...wrapBoxed(theme, theme.fg("error", "✗ Error"), renderedWidth));
      for (const bodyLine of contentLines) {
        lines.push(...wrapBoxed(theme, bodyLine, renderedWidth));
      }
      if (opts.footerLines && opts.footerLines.length > 0) {
        lines.push(divider(theme, renderedWidth));
        for (const footer of opts.footerLines) lines.push(line(theme, footer, renderedWidth));
      }

      lines.push(border(theme, "└", "┘", renderedWidth));
      const painted = applyBg(theme, lines, opts.bgToken);
      if (!opts.live) cache.set(width, painted);
      return painted;
    },
  };
}

export function boxedExpandHint(theme: Theme): string {
  const key = keyText("app.tools.expand") || "ctrl+o";
  return theme.fg("accent", `${key} to expand`);
}

export function formatBoxedFooter(
  theme: Theme,
  text: string,
  extraParts: readonly string[] = [],
): string {
  const parts = [...extraParts.filter(Boolean), formatApproxWords(text)].map((part) =>
    theme.fg("muted", part),
  );
  return parts.join(theme.fg("muted", " · "));
}
