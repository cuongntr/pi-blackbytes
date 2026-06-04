import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { SPINNER_FRAMES } from "../format.js";
import { getAgentIcon } from "../icons.js";
import {
  type SubAgentRenderDetails,
  SubAgentResultComponent,
  buildSubAgentRenderResult,
  rebuildSubAgentResultComponent,
} from "../render.js";

/**
 * Minimal theme stub that records *which* color token was applied so tests
 * can assert color choices without depending on real ANSI codes.
 *
 * Format: `«token:text»` for foreground, `«bg:token:text»` for background,
 * `«bold:text»` for bold. Composable: `theme.fg("success", theme.bold("x"))`
 * → `«success:«bold:x»»`.
 */
function makeStubTheme(): Theme {
  const fg = (token: string, text: string) => `«${token}:${text}»`;
  const bg = (token: string, text: string) => `«bg:${token}:${text}»`;
  const bold = (text: string) => `«bold:${text}»`;
  // Pi's Theme has many helpers; only the ones used by render.ts matter here.
  // Use `unknown` cast to satisfy the structural type without enumerating every member.
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

interface RenderInput {
  readonly details: SubAgentRenderDetails;
  readonly content?: ReadonlyArray<{ type: string; text?: string }>;
  readonly expanded?: boolean;
  readonly isPartial?: boolean;
}

/**
 * Render and concatenate all child Text contents into a single string for
 * easy substring assertions. Splits each Text on lines is unnecessary — the
 * Text constructor stores the literal string we passed.
 */
function renderToText(input: RenderInput): string {
  const component = new SubAgentResultComponent();
  const state = { startedAt: undefined, endedAt: undefined, interval: undefined };
  const theme = makeStubTheme();
  rebuildSubAgentResultComponent(
    component,
    {
      content: input.content ?? [],
      details: input.details,
    },
    { expanded: input.expanded ?? false, isPartial: input.isPartial ?? false },
    state,
    theme,
  );
  // Container exposes its children; we walk them to extract the rendered text.
  // SubAgentResultComponent extends Container; children are tui Text instances
  // with a `text` property (private but accessible via render).
  // Use render(width) to obtain final lines.
  const lines = component.render(200);
  return lines.join("\n");
}

describe("rebuildSubAgentResultComponent — header", () => {
  it("includes spinner frame + agent icon + agent name for running state", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "running",
        elapsedMs: 9_000,
        toolCallCount: 4,
      },
      isPartial: true,
    });
    // Spinner frame must be one of the braille frames.
    const hasSpinner = SPINNER_FRAMES.some((f) => out.includes(f));
    assert.ok(hasSpinner, `expected spinner frame in header, got: ${out}`);
    assert.ok(out.includes(getAgentIcon("explore")), "expected agent icon 🔭");
    assert.ok(out.includes("«bold:explore»"), "expected agent name in bold");
    assert.ok(out.includes("9.0s"), "expected formatted duration");
    assert.ok(out.includes("4 calls"), "expected tool call count");
  });

  it("uses ✓ success icon for completed state, no status word", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "completed",
        elapsedMs: 13_900,
        toolCallCount: 4,
        outputChars: 2_410,
      },
    });
    assert.ok(out.includes("«success:✓»"), "expected ✓ in success color");
    assert.ok(!out.includes("completed"), "must NOT show the word 'completed'");
    assert.ok(out.includes("«bold:explore»"));
    assert.ok(out.includes("13.9s"));
    assert.ok(out.includes("2,410 chars"));
  });

  it("uses ✗ error icon for failed state", () => {
    const out = renderToText({
      details: { agent: "oracle", status: "failed", elapsedMs: 1_400 },
    });
    assert.ok(out.includes("«error:✗»"));
    assert.ok(!out.includes("failed"), "must NOT show the word 'failed'");
  });

  it("uses ⚠ warning icon for cancelled and timed_out", () => {
    for (const status of ["cancelled", "timed_out"] as const) {
      const out = renderToText({
        details: { agent: "general", status, elapsedMs: 1_000 },
      });
      assert.ok(out.includes("«warning:⚠»"), `expected ⚠ for ${status}`);
      assert.ok(!out.includes(status), `must NOT show word '${status}'`);
    }
  });

  it("removes model from the collapsed header", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "completed",
        model: "gemini-3-flash-preview",
        elapsedMs: 1_000,
      },
    });
    assert.ok(!out.includes("gemini-3-flash-preview"), "model must not appear in header");
  });

  it("places model in the expanded footer", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "completed",
        model: "gemini-3-flash-preview",
        elapsedMs: 1_000,
      },
      expanded: true,
    });
    // T3 moved model from a standalone "model: xxx" line into the muted footer.
    assert.ok(out.includes("gemini-3-flash-preview"), "model must appear in expanded body");
    assert.ok(!out.includes("model: gemini-3-flash-preview"), "no 'model:' prefix anymore");
  });

  it("falls back to ▸ icon for unknown agents (YAML-defined)", () => {
    const out = renderToText({
      details: { agent: "my-custom-agent", status: "completed", elapsedMs: 100 },
    });
    assert.ok(out.includes("▸"), "unknown agent should get ▸ fallback icon");
  });
});

describe("rebuildSubAgentResultComponent — current/last tool display", () => {
  it("shows active tool split-colored (icon accent / name toolTitle / arg muted)", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "running",
        currentTool: "ast_search",
        toolHistory: [{ name: "ast_search", summary: "def $FUNC", startMs: 100 }],
      },
      isPartial: true,
    });
    assert.ok(out.includes("«accent:🔧»"), `expected accent 🔧 icon, got: ${out}`);
    assert.ok(
      out.includes("«toolTitle:ast_search»"),
      `expected tool name in toolTitle, got: ${out}`,
    );
    assert.ok(out.includes("«muted:def $FUNC»"), `expected arg in muted, got: ${out}`);
  });

  it("shows last completed tool with ◷ prefix in muted color when running between calls", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "running",
        currentTool: undefined,
        toolHistory: [{ name: "read", summary: "src/index.ts", startMs: 100, endMs: 200 }],
      },
      isPartial: true,
    });
    assert.ok(out.includes("«muted:◷ read src/index.ts»"), `got: ${out}`);
    assert.ok(!out.includes("🔧"), "must not show 🔧 when currentTool is undefined");
  });

  it("shows nothing for tool when currentTool undefined AND no history", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "running",
        currentTool: undefined,
        toolHistory: [],
      },
      isPartial: true,
    });
    assert.ok(!out.includes("🔧"), "no current tool");
    assert.ok(!out.includes("◷"), "no last tool");
  });

  it("does not show 🔧 or ◷ when status is not running", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "completed",
        currentTool: "read",
        toolHistory: [{ name: "read", startMs: 100, endMs: 200 }],
      },
    });
    assert.ok(!out.includes("🔧"), "completed state must not show active-tool indicator");
    assert.ok(!out.includes("◷"), "completed state must not show last-tool indicator");
  });
});

describe("rebuildSubAgentResultComponent — failed error hint", () => {
  it("surfaces a one-line error hint in error color when status is failed", () => {
    const out = renderToText({
      details: { agent: "explore", status: "failed", elapsedMs: 1_000 },
      content: [{ type: "text", text: "Error: nested Pi crashed with signal SIGTERM" }],
    });
    assert.ok(
      out.includes("«error:nested Pi crashed with signal SIGTERM»"),
      `expected stripped error hint, got: ${out}`,
    );
  });

  it("strips the leading 'Error: ' prefix case-insensitively", () => {
    const out = renderToText({
      details: { agent: "explore", status: "failed" },
      content: [{ type: "text", text: "error: budget exhausted" }],
    });
    assert.ok(out.includes("«error:budget exhausted»"), `got: ${out}`);
  });

  it("truncates long error hints to ~60 chars with ellipsis", () => {
    const longErr = `Error: ${"x".repeat(200)}`;
    const out = renderToText({
      details: { agent: "explore", status: "failed" },
      content: [{ type: "text", text: longErr }],
    });
    // Multiple bits use error color (status icon + agent name + hint). Pick the
    // long one — it's the only one containing many `x`s.
    const matches = [...out.matchAll(/«error:([^»]+)»/g)].map((m) => m[1]);
    const hint = matches.find((s) => s.includes("xxx"));
    assert.ok(hint, `expected an error hint bit with the x payload, got: ${out}`);
    assert.ok(hint!.endsWith("\u2026"), `long hint should be ellipsised, got: ${hint}`);
    assert.ok(hint!.length <= 60, `hint length should be ≤ 60, got ${hint!.length}`);
  });

  it("shows no hint for non-failed statuses even with error-like content", () => {
    const out = renderToText({
      details: { agent: "explore", status: "completed" },
      content: [{ type: "text", text: "Error: something" }],
    });
    assert.ok(!out.includes("«error:"), "completed state must not show error hint");
  });

  it("handles failed status with empty content gracefully", () => {
    const out = renderToText({
      details: { agent: "explore", status: "failed" },
      content: [],
    });
    assert.ok(out.includes("«error:✗»"), "status icon still rendered");
    // With no extractable hint, only the status icon and agent name use error
    // color (statusColor("failed") = "error"). Verify no extra error bit creeps in.
    const errBits = [...out.matchAll(/«error:([^»]+)»/g)].map((m) => m[1]);
    assert.equal(
      errBits.length,
      2,
      `expected 2 error bits (icon + agent name), got: ${JSON.stringify(errBits)}`,
    );
    assert.ok(errBits.includes("✗"), "status icon present");
  });
});

describe("rebuildSubAgentResultComponent — expanded footer aggregate", () => {
  it("renders model + tool aggregate + cost as a single muted footer", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "completed",
        model: "gemini-3-flash-preview",
        toolHistory: [
          { name: "read", startMs: 0, endMs: 10 },
          { name: "read", startMs: 10, endMs: 20 },
          { name: "read", startMs: 20, endMs: 30 },
          { name: "bash", startMs: 30, endMs: 40 },
        ],
        usage: { cost: 0.0042 },
      },
      expanded: true,
    });
    assert.ok(out.includes("gemini-3-flash-preview"), "model in footer");
    assert.ok(out.includes("Tools: 3× read · 1× bash"), `expected aggregate, got: ${out}`);
    assert.ok(out.includes("$0.004"), "smart cost in footer");
  });

  it("omits the standalone 'model: xxx' line that T1 added at top of body", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "completed",
        model: "sonnet-4-5",
      },
      expanded: true,
    });
    assert.ok(!out.includes("model: sonnet-4-5"), "T1's 'model: xxx' line should be removed");
    assert.ok(out.includes("sonnet-4-5"), "model still surfaces in footer");
  });

  it("sorts tool aggregate by count desc, then name asc for ties", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "completed",
        toolHistory: [
          { name: "write", startMs: 0, endMs: 10 },
          { name: "edit", startMs: 10, endMs: 20 },
          { name: "read", startMs: 20, endMs: 30 },
          { name: "read", startMs: 30, endMs: 40 },
        ],
      },
      expanded: true,
    });
    // read(2) first; edit and write tied at 1 — edit before write (alphabetical).
    assert.ok(out.includes("Tools: 2× read · 1× edit · 1× write"), `wrong order, got: ${out}`);
  });

  it("omits footer entirely when nothing to show", () => {
    const out = renderToText({
      details: { agent: "explore", status: "completed" },
      expanded: true,
    });
    assert.ok(!out.includes("Tools:"), "no aggregate when no tools");
  });

  it("uses smart cost format in collapsed header too", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "completed",
        elapsedMs: 1_000,
        usage: { cost: 0.42 },
      },
    });
    assert.ok(out.includes("$0.420"), `expected smart cost, got: ${out}`);
    assert.ok(!out.includes("$0.4200"), "must not use the old 4-decimal format");
  });

  it("does NOT duplicate cost in the header when expanded (footer carries it)", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "completed",
        elapsedMs: 1_000,
        model: "sonnet-4-5",
        usage: { cost: 0.399 },
      },
      expanded: true,
    });
    // Cost must appear exactly once — in the footer aggregate, not in the
    // header. Regression: v2.8.0 showed `$0.399` twice when expanded.
    const occurrences = out.split("$0.399").length - 1;
    assert.equal(occurrences, 1, `cost should appear once when expanded, got: ${out}`);
  });

  it("does NOT duplicate the last/current tool in the header when expanded", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "running",
        elapsedMs: 5_000,
        toolCallCount: 2,
        // No currentTool — emulate the "between calls" state.
        toolHistory: [
          { name: "read", summary: "src/foo.ts", startMs: 0, endMs: 10 },
          { name: "grep", summary: "src/bar.ts", startMs: 10, endMs: 20 },
        ],
      },
      expanded: true,
      isPartial: true,
    });
    // The ◷ between-calls hint must NOT appear in the header when the timeline
    // already lists the same tool below. Regression: v2.8.0 rendered both.
    assert.ok(!out.includes("◷ grep"), `◷ hint must be hidden when expanded, got: ${out}`);
    // Timeline still shows the tool.
    assert.ok(out.includes("grep"), "timeline must still surface the tool name");
  });

  it("keeps cost in the header when collapsed (no footer to delegate to)", () => {
    const out = renderToText({
      details: {
        agent: "explore",
        status: "completed",
        elapsedMs: 1_000,
        usage: { cost: 0.399 },
      },
      expanded: false,
    });
    assert.ok(out.includes("$0.399"), "cost must remain in collapsed header");
  });
});

describe("buildSubAgentRenderResult — boxed frame", () => {
  function render(isPartial: boolean): string {
    const renderResult = buildSubAgentRenderResult();
    const state = { startedAt: undefined, endedAt: undefined, interval: undefined };
    const component = renderResult(
      {
        content: [{ type: "text", text: "done" }],
        details: { agent: "explore", status: isPartial ? "running" : "completed" },
      },
      { expanded: false, isPartial },
      makeStubTheme(),
      { state, lastComponent: undefined, invalidate: () => {} },
    ) as { render(width: number): string[] };
    if (state.interval) clearInterval(state.interval);
    return component.render(80).join("\n");
  }

  it("wraps the live result in a seam-top, pending-tinted box when boxed", () => {
    const out = render(true);
    // Seam-top: no top border ┌, but a closing border └ and a pending background.
    assert.doesNotMatch(out, /┌/);
    assert.match(out, /└/);
    assert.match(out, /«bg:toolPendingBg:/);
    // In seam context (boxed), agent identity is de-duplicated — the call
    // box above already shows it. Only metrics appear in the result box.
    assert.doesNotMatch(out, /explore/);
    assert.match(out, /ctrl\+o to expand/);
  });

  it("keeps the pending background after completion so the seam stays uniform", () => {
    const out = render(false);
    assert.match(out, /«bg:toolPendingBg:/);
    assert.match(out, /└/);
  });
});
