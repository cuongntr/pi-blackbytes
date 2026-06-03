import { type Theme, keyText } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatApproxWords } from "./tool-output.js";

const H = "─";
const V = "│";
const SIDE_PAD = 2;
const MIN_WIDTH = 12;

export interface BoxStateOptions {
  readonly isError?: boolean;
  readonly isPartial?: boolean;
  readonly isPending?: boolean;
}

export interface BoxedResultOptions extends BoxStateOptions {
  readonly footerLines?: readonly string[];
  readonly emptyText?: string;
}

export function boxWidth(width: number): number {
  return Math.max(MIN_WIDTH, width);
}

export function boxInnerWidth(width: number): number {
  return Math.max(1, boxWidth(width) - 2 - SIDE_PAD * 2);
}

function frame(theme: Theme, text: string): string {
  return theme.fg("border", text);
}

function mutedFrame(theme: Theme, text: string): string {
  return theme.fg("borderMuted", text);
}

function border(theme: Theme, left: string, right: string, width: number): string {
  const renderedWidth = boxWidth(width);
  return frame(theme, `${left}${H.repeat(Math.max(0, renderedWidth - 2))}${right}`);
}

function line(theme: Theme, content: string, width: number): string {
  const renderedWidth = boxWidth(width);
  const inner = boxInnerWidth(renderedWidth);
  const truncated = truncateToWidth(content, inner, "…");
  const fill = " ".repeat(Math.max(0, inner - visibleWidth(truncated)));
  const pad = " ".repeat(SIDE_PAD);
  return `${frame(theme, V)}${pad}${truncated}${fill}${pad}${frame(theme, V)}`;
}

function divider(theme: Theme, width: number): string {
  const renderedWidth = boxWidth(width);
  const inner = boxInnerWidth(renderedWidth);
  const pad = " ".repeat(SIDE_PAD);
  return `${frame(theme, V)}${pad}${mutedFrame(theme, H.repeat(inner))}${pad}${frame(theme, V)}`;
}

function wrapBoxed(theme: Theme, content: string, width: number): string[] {
  return wrapTextWithAnsi(content, boxInnerWidth(width)).map((wrapped) =>
    line(theme, wrapped, width),
  );
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
  return {
    invalidate() {},
    render(width: number): string[] {
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
      if (opts.isPending) {
        lines.push(divider(theme, renderedWidth));
        lines.push(...wrapBoxed(theme, theme.fg("muted", "Waiting for output…"), renderedWidth));
      }
      lines.push(border(theme, "└", "┘", renderedWidth));
      return lines;
    },
  };
}

export function renderCompactBoxedToolCall(
  theme: Theme,
  toolName: string,
  detailLine = "",
  opts: BoxStateOptions = {},
): Component {
  return {
    invalidate() {},
    render(width: number): string[] {
      const renderedWidth = boxWidth(width);
      const title = `${formatBoxedTitle(theme, toolName, opts)}${
        detailLine ? ` ${theme.fg("muted", "|")} ${detailLine}` : ""
      }`;
      return [
        border(theme, "┌", "┐", renderedWidth),
        line(theme, title, renderedWidth),
        ...(opts.isPending
          ? [
              divider(theme, renderedWidth),
              ...wrapBoxed(theme, theme.fg("muted", "Waiting for output…"), renderedWidth),
            ]
          : []),
        border(theme, "└", "┘", renderedWidth),
      ];
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
  return {
    invalidate() {
      bodyComponent.invalidate?.();
    },
    render(width: number): string[] {
      const renderedWidth = boxWidth(width);
      const bodyLines = bodyComponent.render(boxInnerWidth(renderedWidth));
      const contentLines =
        bodyLines.length > 0 ? bodyLines : [theme.fg("muted", opts.emptyText ?? "(no output)")];
      const lines = [border(theme, "┌", "┐", renderedWidth)];
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
      return lines;
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
