import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  boxedExpandHint,
  formatBoxedFooter,
  renderBoxedToolCall,
  renderBoxedToolResult,
  renderCompactBoxedToolCall,
} from "../boxed-render.js";

function theme(): any {
  return {
    fg: (token: string, text: string) => `«${token}:${text}»`,
    bg: (token: string, text: string) => `«bg:${token}:${text}»`,
    bold: (text: string) => `«bold:${text}»`,
  };
}

function plainTheme(): any {
  return {
    fg: (_token: string, text: string) => text,
    bg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  };
}

describe("boxed-render", () => {
  it("renders a compact boxed call that opens a frame and leaves the bottom open", () => {
    const out = renderCompactBoxedToolCall(theme(), "glob", "pattern **/*.ts")
      .render(80)
      .join("\n");
    assert.match(out, /┌/);
    assert.match(out, /➔ glob/);
    assert.match(out, /pattern/);
    // Bottom stays open: the seam-top result box draws the closing border.
    assert.doesNotMatch(out, /└/);
  });

  it("renders multiline boxed calls and leaves the bottom open for the result box", () => {
    const out = renderBoxedToolCall(theme(), "bash", ["$ bun run test", "> --watch"], {
      isPartial: true,
    })
      .render(60)
      .join("\n");
    assert.match(out, /bun run test/);
    assert.match(out, /«accent:…»/);
    // Call box no longer closes itself: the result box draws the seam + bottom.
    assert.doesNotMatch(out, /└/);
  });

  it("renders a seam-top result that continues the call box without a top border", () => {
    const out = renderBoxedToolResult(theme(), "output", {
      seamTop: true,
      footerLines: ["footer"],
    })
      .render(50)
      .join("\n");
    // Seam result opens with a divider row, not a ┌ top border, and closes with └.
    assert.doesNotMatch(out, /┌/);
    assert.match(out, /output/);
    assert.match(out, /└/);
  });

  it("renders boxed results with footer and error marker", () => {
    const out = renderBoxedToolResult(theme(), "boom", {
      isError: true,
      footerLines: ["footer"],
    })
      .render(50)
      .join("\n");
    assert.match(out, /✗ Error/);
    assert.match(out, /boom/);
    assert.match(out, /footer/);
    assert.ok(out.startsWith("«"), "result box opens with a styled top border");
    assert.match(out, /┌/);
    assert.match(out, /└/);
  });

  it("wraps content at narrow widths", () => {
    const out = renderBoxedToolResult(theme(), "alpha beta gamma delta epsilon").render(20);
    assert.ok(out.length > 3);
  });

  it("formats footer and expand hint", () => {
    assert.match(formatBoxedFooter(theme(), "hello world", ["◷ 1ms"]), /~2 words/);
    assert.match(boxedExpandHint(theme()), /expand/);
  });

  it("renders identical output across repeated renders at the same width", () => {
    const comp = renderBoxedToolResult(theme(), "alpha beta gamma delta epsilon", {
      footerLines: ["footer"],
    });
    const first = comp.render(40);
    const second = comp.render(40);
    assert.deepEqual(second, first);
    const call = renderBoxedToolCall(theme(), "bash", ["$ ls", "> -la"]);
    assert.deepEqual(call.render(40), call.render(40));
  });

  it("recomputes after invalidate() and never exceeds the granted width at narrow widths", () => {
    const comp = renderBoxedToolResult(theme(), "alpha beta gamma");
    const before = comp.render(40);
    comp.invalidate();
    assert.deepEqual(comp.render(40), before);

    for (let width = 1; width < 12; width++) {
      const narrow = renderBoxedToolCall(plainTheme(), "x", ["detail"], {
        bgToken: "toolPendingBg",
      }).render(width);
      assert.ok(narrow.length > 0);
      for (const line of narrow) {
        assert.ok(
          visibleWidth(line) <= width,
          `line ${JSON.stringify(line)} exceeded width ${width}`,
        );
      }
    }
  });
});
