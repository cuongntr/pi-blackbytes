import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { isBoxedToolCallsEnabled, setBoxedToolCallsEnabled } from "../boxed-config.js";
import { makeRenderCall } from "../call-render.js";

function theme(): Theme {
  return {
    fg: (token: string, text: string) => `«${token}:${text}»`,
    bg: (token: string, text: string) => `«bg:${token}:${text}»`,
    bold: (text: string) => `«bold:${text}»`,
  } as unknown as Theme;
}

function render(value: unknown): string {
  return (value as { render: (width: number) => string[] }).render(80).join("\n");
}

describe("boxed tool call config", () => {
  afterEach(() => {
    setBoxedToolCallsEnabled(true);
  });

  it("defaults to enabled", () => {
    assert.equal(isBoxedToolCallsEnabled(), true);
  });

  it("renders boxed calls while enabled", () => {
    setBoxedToolCallsEnabled(true);
    const renderCall = makeRenderCall("⌕", "glob", (args, t) =>
      t.fg("accent", String(args.pattern)),
    );

    const out = render(renderCall({ pattern: "**/*.ts" }, theme()));

    assert.match(out, /┌/);
    assert.match(out, /➔ ⌕ glob/);
    assert.match(out, /\*\*\/\*\.ts/);
  });

  it("reflects partial and error status from render context", () => {
    setBoxedToolCallsEnabled(true);
    const renderCall = makeRenderCall("⌕", "glob", (args, t) =>
      t.fg("accent", String(args.pattern)),
    );

    const partial = render(
      renderCall({ pattern: "**/*.ts" }, theme(), { isPartial: true, hasResult: false }),
    );
    const failed = render(renderCall({ pattern: "**/*.ts" }, theme(), { isError: true }));

    assert.match(partial, /«accent:…»/);
    assert.match(partial, /└/);
    assert.match(failed, /«error:✗»/);
  });

  it("renders legacy unboxed calls when disabled", () => {
    setBoxedToolCallsEnabled(false);
    const renderCall = makeRenderCall("⌕", "glob", (args, t) =>
      t.fg("accent", String(args.pattern)),
    );

    const out = render(renderCall({ pattern: "**/*.ts" }, theme()));

    assert.doesNotMatch(out, /┌/);
    assert.match(out, /⌕ glob/);
    assert.match(out, /\*\*\/\*\.ts/);
  });
});
