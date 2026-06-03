import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import type { DiffData } from "../diff-preview.js";
import { clampToWidth, renderHashlineEditResult } from "../result-renderer.js";

/**
 * Stub theme that wraps each colour-token call in a delimited marker so we
 * can assert on token usage by name (e.g. `«success:…»`, `«error:…»`)
 * without depending on actual ANSI codes. Same pattern as
 * `src/sub-agents/__tests__/render.test.ts`.
 */
function makeStubTheme(): Theme {
  const fg = (token: string, text: string) => `«${token}:${text}»`;
  const bg = (token: string, text: string) => `«bg:${token}:${text}»`;
  const bold = (text: string) => `«bold:${text}»`;
  return {
    fg,
    bg,
    bold,
    italic: (s: string) => s,
    underline: (s: string) => s,
    dim: (s: string) => s,
    inverse: (s: string) => s,
    strikethrough: (s: string) => s,
  } as unknown as Theme;
}

function render(input: {
  expanded?: boolean;
  isPartial?: boolean;
  isError?: boolean;
  width?: number;
  details?: { summary?: string; fullText?: string; diffData?: DiffData };
  contentText?: string;
}): string {
  const theme = makeStubTheme();
  const text = renderHashlineEditResult(
    {
      content: input.contentText ? [{ type: "text", text: input.contentText }] : [],
      details: input.details,
    },
    {
      expanded: input.expanded ?? false,
      isPartial: input.isPartial,
      width: input.width,
    },
    theme,
    { isError: input.isError },
  );
  // pi-tui Text exposes `.render(width)` returning string[] of lines.
  const lines = (text as unknown as { render: (w: number) => string[] }).render(200);
  return lines.join("\n");
}

describe("renderHashlineEditResult — collapsed", () => {
  it("renders ✓ + summary + expand hint for success", () => {
    const out = render({
      details: { summary: "File updated. 12 lines." },
    });
    assert.ok(out.includes("«success:✓»"), `expected success-coloured ✓; got: ${out}`);
    assert.ok(out.includes("File updated. 12 lines."));
    assert.ok(out.includes("to expand"));
    // No diff markers in collapsed view.
    assert.ok(!out.includes("▌-"));
    assert.ok(!out.includes("▌+"));
  });

  it("renders ✗ + summary in error colour for failures", () => {
    const out = render({
      isError: true,
      details: { summary: "[E_HASH_MISMATCH] anchor stale" },
    });
    assert.ok(out.includes("«error:✗»"), `expected error-coloured ✗; got: ${out}`);
    assert.ok(out.includes("«error:[E_HASH_MISMATCH] anchor stale»"));
  });
});

describe("renderHashlineEditResult — partial", () => {
  it("renders muted 'Editing...' label while the call is in flight", () => {
    const out = render({ isPartial: true });
    assert.ok(out.includes("«muted:Editing...»"), `expected boxed partial label; got: ${out}`);
  });
});

describe("renderHashlineEditResult — expanded with diff", () => {
  const diffData: DiffData = {
    ranges: [
      {
        oldStart: 2,
        oldEnd: 2,
        oldLines: ["beta"],
        newStart: 2,
        newEnd: 2,
        newLines: ["BETA"],
      },
    ],
  };

  it("renders ▌- and ▌+ markers in error and success colours", () => {
    const out = render({
      expanded: true,
      details: { summary: "File updated.", fullText: "ignored", diffData },
    });
    assert.ok(out.includes("«error:▌- beta»"), `expected error-coloured minus line; got: ${out}`);
    assert.ok(
      out.includes("«success:▌+ BETA»"),
      `expected success-coloured plus line; got: ${out}`,
    );
  });

  it("falls back to plain fullText when diffData is empty", () => {
    const out = render({
      expanded: true,
      details: {
        summary: "Deleted /tmp/x.txt",
        fullText: "Deleted /tmp/x.txt",
        diffData: { ranges: [] },
      },
    });
    assert.ok(out.includes("«toolOutput:Deleted /tmp/x.txt»"));
    assert.ok(!out.includes("▌-"));
    assert.ok(!out.includes("▌+"));
  });

  it("renders error fullText in error colour on failure", () => {
    const out = render({
      expanded: true,
      isError: true,
      details: {
        summary: "[E_HASH_MISMATCH] ...",
        fullText: "[E_HASH_MISMATCH] anchor stale\nNearby current lines:\n...",
      },
    });
    assert.ok(
      out.includes("«error:[E_HASH_MISMATCH]"),
      `expected boxed error fullText; got: ${out}`,
    );
  });
});

describe("clampToWidth", () => {
  it("returns the line unchanged when width is undefined or too small to be useful", () => {
    assert.equal(clampToWidth("abcdef", undefined), "abcdef");
    assert.equal(clampToWidth("abcdef", 3), "abcdef");
  });

  it("truncates with ellipsis when line exceeds the budget (width - gutter)", () => {
    // width=10 → budget = 10-3 = 7 → output 6 chars + …
    assert.equal(clampToWidth("0123456789", 10), "012345…");
  });

  it("does not truncate when line fits the budget exactly", () => {
    // width=10 → budget = 7 → "0123456" fits exactly
    assert.equal(clampToWidth("0123456", 10), "0123456");
  });
});
