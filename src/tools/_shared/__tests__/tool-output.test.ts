import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampLine,
  countLines,
  countWords,
  expandedPreview,
  getTextOutput,
  stripTrailingNoticeLines,
  tailPreview,
} from "../tool-output.js";

describe("tool-output", () => {
  it("extracts text blocks", () => {
    assert.equal(
      getTextOutput({
        content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
      }),
      "ab",
    );
  });

  it("counts lines and words", () => {
    assert.equal(countLines("a\nb\n"), 2);
    assert.equal(countWords("hello agent-world"), 2);
  });

  it("clamps long lines", () => {
    assert.match(clampLine("abcdef", 5), /truncated/);
  });

  it("strips Pi truncation notice lines", () => {
    const text = "a\n[Showing last 1 lines. Full output: /tmp/x]\nb";
    assert.equal(stripTrailingNoticeLines(text), "a\nb");
  });

  it("returns tail preview with omitted count", () => {
    const out = tailPreview("1\n2\n3\n4", 2);
    assert.deepEqual(out.lines, ["3", "4"]);
    assert.equal(out.omittedLines, 2);
  });

  it("caps expanded preview", () => {
    const out = expandedPreview("1\n2\n3", 2);
    assert.deepEqual(out.lines, ["1", "2"]);
    assert.equal(out.omittedLines, 1);
  });
});
