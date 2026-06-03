import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
    bold: (text: string) => `«bold:${text}»`,
  };
}

describe("boxed-render", () => {
  it("renders a compact boxed call with title and detail", () => {
    const out = renderCompactBoxedToolCall(theme(), "glob", "pattern **/*.ts")
      .render(80)
      .join("\n");
    assert.match(out, /┌/);
    assert.match(out, /➔ glob/);
    assert.match(out, /pattern/);
    assert.match(out, /└/);
  });

  it("renders multiline boxed calls with pending state", () => {
    const out = renderBoxedToolCall(theme(), "bash", ["$ bun run test", "> --watch"], {
      isPending: true,
      isPartial: true,
    })
      .render(60)
      .join("\n");
    assert.match(out, /bun run test/);
    assert.match(out, /Waiting for output/);
    assert.match(out, /«accent:…»/);
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
});
