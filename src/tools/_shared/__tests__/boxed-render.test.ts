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

describe("lightweight tool renderer", () => {
  it("renders a compact Claude-like call without borders", () => {
    const out = renderCompactBoxedToolCall(theme(), "glob", "pattern **/*.ts")
      .render(80)
      .join("\n");
    assert.match(out, /«success:⏺»/);
    assert.match(out, /glob/);
    assert.match(out, /pattern/);
    assert.doesNotMatch(out, /┌|└|│/);
  });

  it("renders multiline calls as a lead line plus indented details", () => {
    const out = renderBoxedToolCall(theme(), "bash", ["$ bun run test", "> --watch"], {
      isPartial: true,
    })
      .render(60)
      .join("\n");
    assert.match(out, /«accent:⏺»/);
    assert.match(out, /bash/);
    assert.match(out, /bun run test/);
    assert.match(out, /«accent:…»/);
    assert.doesNotMatch(out, /┌|└|│/);
  });

  it("renders results with a Claude-like output marker", () => {
    const out = renderBoxedToolResult(theme(), "output", {
      seamTop: true,
      footerLines: ["footer"],
    })
      .render(50)
      .join("\n");
    assert.match(out, /⎿/);
    assert.match(out, /output/);
    assert.match(out, /footer/);
    assert.doesNotMatch(out, /┌|└|│/);
  });

  it("renders lightweight results with footer and error marker", () => {
    const out = renderBoxedToolResult(theme(), "boom", {
      isError: true,
      footerLines: ["footer"],
    })
      .render(50)
      .join("\n");
    assert.match(out, /⎿/);
    assert.match(out, /✗ Error/);
    assert.match(out, /boom/);
    assert.match(out, /footer/);
    assert.doesNotMatch(out, /┌|└|│/);
  });

  it("keeps narrow output within the granted width", () => {
    const out = renderBoxedToolResult(theme(), "alpha beta gamma delta epsilon").render(20);
    assert.ok(out.length > 0);
    for (const line of out) assert.ok(visibleWidth(line) <= 20);
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

  it("propagates invalidate() to component bodies", () => {
    let invalidations = 0;
    const body = {
      invalidate() {
        invalidations++;
      },
      render() {
        return ["body"];
      },
    };

    const comp = renderBoxedToolResult(plainTheme(), body);
    comp.render(40);
    const before = invalidations;

    comp.invalidate?.();

    assert.equal(invalidations, before + 1);
  });

  it("tracks live cache freshness independently per width", () => {
    const originalNow = Date.now;
    let now = 1_000;
    let renders = 0;
    Date.now = () => now;
    try {
      const body = {
        invalidate() {},
        render(width: number) {
          renders++;
          return [`${width}:${renders}`];
        },
      };
      const comp = renderBoxedToolResult(plainTheme(), body, { live: true });

      assert.match(comp.render(80).join("\n"), /75:1/);
      now += 50;
      assert.match(comp.render(120).join("\n"), /115:2/);
      now += 51;

      assert.match(comp.render(80).join("\n"), /75:3/);
    } finally {
      Date.now = originalNow;
    }
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
