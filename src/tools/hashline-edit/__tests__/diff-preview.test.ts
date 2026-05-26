import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { computeCID } from "../../../utils/cid.js";
import {
  MAX_DIFF_LINES,
  computeChangedRanges,
  renderDiffPreview,
  renderUpdatedAnchors,
} from "../diff-preview.js";
import { applyHashlineEdits } from "../index.js";

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe("computeChangedRanges", () => {
  it("returns empty for identical snapshots", () => {
    assert.deepEqual(computeChangedRanges(["a", "b"], ["a", "b"]), []);
  });

  it("single-line replace", () => {
    const r = computeChangedRanges(["a", "b", "c"], ["a", "B", "c"]);
    assert.equal(r.length, 1);
    assert.equal(r[0].oldStart, 2);
    assert.equal(r[0].oldEnd, 2);
    assert.equal(r[0].newStart, 2);
    assert.equal(r[0].newEnd, 2);
    assert.deepEqual(r[0].oldLines, ["b"]);
    assert.deepEqual(r[0].newLines, ["B"]);
  });

  it("range replace 5→3 (old 5 lines, new 3)", () => {
    const r = computeChangedRanges(["k", "1", "2", "3", "4", "5", "z"], ["k", "A", "B", "C", "z"]);
    assert.equal(r.length, 1);
    assert.equal(r[0].oldStart, 2);
    assert.equal(r[0].oldEnd, 6);
    assert.equal(r[0].newStart, 2);
    assert.equal(r[0].newEnd, 4);
    assert.deepEqual(r[0].oldLines, ["1", "2", "3", "4", "5"]);
    assert.deepEqual(r[0].newLines, ["A", "B", "C"]);
  });

  it("pure append (no removals)", () => {
    const r = computeChangedRanges(["a", "b"], ["a", "b", "c", "d"]);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].oldLines, []);
    assert.deepEqual(r[0].newLines, ["c", "d"]);
    // empty old side encoded with oldEnd < oldStart
    assert.ok(r[0].oldEnd < r[0].oldStart);
  });

  it("pure delete (no additions)", () => {
    const r = computeChangedRanges(["a", "b", "c"], ["a", "c"]);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].oldLines, ["b"]);
    assert.deepEqual(r[0].newLines, []);
    assert.ok(r[0].newEnd < r[0].newStart);
  });

  it("multiple non-overlapping edits collapse into one coarse range (v1 trade-off)", () => {
    // Two distinct changes — v1 returns a single covering range; spec § Risks
    // documents that fine-grained splitting is a future enhancement.
    const r = computeChangedRanges(["a", "b", "c", "d", "e"], ["A", "b", "c", "d", "E"]);
    assert.equal(r.length, 1);
    assert.equal(r[0].oldStart, 1);
    assert.equal(r[0].oldEnd, 5);
  });
});

describe("renderUpdatedAnchors", () => {
  it("emits LINE#CID|content with context lines", () => {
    const newLines = ["alpha", "BETA", "gamma"];
    const ranges = computeChangedRanges(["alpha", "beta", "gamma"], newLines);
    const out = renderUpdatedAnchors(newLines, ranges, 3);
    // Every emitted line must round-trip through computeCID at its line number
    for (const line of out.split("\n")) {
      const m = /^(\d+)#([A-Z]{2})\|(.*)$/.exec(line);
      assert.ok(m, `bad anchor line: ${line}`);
      assert.equal(m![2], computeCID(Number(m![1]), m![3]));
    }
  });
});

describe("renderDiffPreview", () => {
  it("removed lines are formatted WITHOUT a CID and DO NOT match the strict-patch regex", () => {
    const ranges = computeChangedRanges(["a", "b", "c"], ["a", "BB", "c"]);
    const out = renderDiffPreview(ranges);
    const minusLines = out.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(minusLines.length, 1);
    assert.equal(minusLines[0], "- 2| b");
    // Critical: the body after "- " must NOT itself match the T1 strict-patch
    // regex, so a model copying the removed line into a `lines` payload
    // cannot accidentally hit E_INVALID_PATCH false-positives.
    const body = minusLines[0].slice(2);
    assert.ok(!/^\d+#[A-Z]{2}\|/.test(body), "minus body must not match strict-patch shape");
  });

  it("added lines carry a full LINE#CID| anchor", () => {
    const newLines = ["a", "BB", "c"];
    const ranges = computeChangedRanges(["a", "b", "c"], newLines);
    const out = renderDiffPreview(ranges);
    const plusLine = out.split("\n").find((l) => l.startsWith("+ "));
    assert.ok(plusLine, "expected a + line");
    const m = /^\+ (\d+)#([A-Z]{2})\| (.*)$/.exec(plusLine!);
    assert.ok(m, `bad plus line: ${plusLine}`);
    assert.equal(m![1], "2");
    assert.equal(m![2], computeCID(2, m![3]));
    assert.equal(m![3], "BB");
  });

  it("middle-cuts when total diff lines exceed MAX_DIFF_LINES", () => {
    // Build a range with 200 changed lines on each side → 400 total
    const oldLines = Array.from({ length: 200 }, (_, i) => `old${i}`);
    const newLines = Array.from({ length: 200 }, (_, i) => `new${i}`);
    const ranges = computeChangedRanges(oldLines, newLines);
    const out = renderDiffPreview(ranges);
    const lines = out.split("\n");
    // Should be exactly MAX_DIFF_LINES + 1 elision marker
    assert.equal(lines.length, MAX_DIFF_LINES + 1);
    assert.ok(lines.some((l) => /^\[… \d+ lines elided …\]$/.test(l)));
  });

  it("pure append emits only + lines; pure delete emits only - lines", () => {
    const appendRanges = computeChangedRanges(["a"], ["a", "b"]);
    const appendOut = renderDiffPreview(appendRanges);
    assert.ok(appendOut.split("\n").every((l) => l.startsWith("+ ")));

    const deleteRanges = computeChangedRanges(["a", "b"], ["a"]);
    const deleteOut = renderDiffPreview(deleteRanges);
    assert.ok(deleteOut.split("\n").every((l) => l.startsWith("- ")));
  });
});

// ---------------------------------------------------------------------------
// End-to-end via applyHashlineEdits
// ---------------------------------------------------------------------------

describe("applyHashlineEdits success response carries diff preview", () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-diff-e2e-"));
    file = join(tmp, "f.txt");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function anchor(lineNum: number, content: string): string {
    return `${lineNum}#${computeCID(lineNum, content)}`;
  }

  it("includes both Updated anchors and Diff preview blocks after a real edit", () => {
    writeFileSync(file, "alpha\nbeta\ngamma\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: anchor(2, "beta"), lines: "BETA" }],
    });
    assert.equal(r.success, true);
    const msg = (r as { message: string }).message;
    assert.ok(msg.includes("--- Updated anchors ---"));
    assert.ok(msg.includes("--- Diff preview ---"));
    // The diff must contain the removed and added forms.
    assert.ok(msg.includes("- 2| beta"));
    assert.ok(msg.match(/\+ 2#[A-Z]{2}\| BETA/));
    // diffData attached on the SuccessResult.
    assert.ok("diffData" in r);
    assert.equal(readFileSync(file, "utf8"), "alpha\nBETA\ngamma\n");
  });
});
