import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { computeCID } from "../../../utils/cid.js";
import { applyHashlineEdits } from "../index.js";

describe("replace_text edit op", () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-replace-text-"));
    file = join(tmp, "f.txt");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function anchor(lineNum: number, content: string): string {
    return `${lineNum}#${computeCID(lineNum, content)}`;
  }

  // 1. single exact match → success
  it("replaces a unique substring", () => {
    writeFileSync(file, "alpha\nbeta\ngamma\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace_text", oldText: "beta", newText: "BETA" }],
    });
    assert.equal(r.success, true);
    assert.equal(readFileSync(file, "utf8"), "alpha\nBETA\ngamma\n");
  });

  // 2. zero match → E_NO_MATCH, no file change
  it("returns E_NO_MATCH when oldText is absent", () => {
    writeFileSync(file, "alpha\nbeta\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace_text", oldText: "ZZZ", newText: "x" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_NO_MATCH]"));
    assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\n");
  });

  // 3. multi match → E_MULTI_MATCH with line numbers, no file change
  it("returns E_MULTI_MATCH when oldText appears more than once", () => {
    writeFileSync(file, "foo\nbar\nfoo\nbaz\nfoo\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace_text", oldText: "foo", newText: "FOO" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_MULTI_MATCH]"));
    // Includes line numbers of first 3 matches (1, 3, 5)
    assert.ok("error" in r && r.error.includes("1, 3, 5"));
    assert.equal(readFileSync(file, "utf8"), "foo\nbar\nfoo\nbaz\nfoo\n");
  });

  // 4. mixed with anchored non-overlap → both apply
  it("works alongside anchored edits when ranges do not overlap", () => {
    writeFileSync(file, "alpha\nbeta\ngamma\ndelta\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [
        { op: "replace_text", oldText: "beta", newText: "BETA" },
        { op: "replace", pos: anchor(4, "delta"), lines: "DELTA" },
      ],
    });
    assert.equal(r.success, true, `unexpected error: ${(r as { error?: string }).error}`);
    assert.equal(readFileSync(file, "utf8"), "alpha\nBETA\ngamma\nDELTA\n");
  });

  // 5. mixed overlap → E_OVERLAP
  it("rejects with E_OVERLAP when a text-edit span intersects an anchored range", () => {
    writeFileSync(file, "alpha\nbeta\ngamma\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [
        { op: "replace_text", oldText: "beta", newText: "BETA" },
        { op: "replace", pos: anchor(2, "beta"), lines: "X" },
      ],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_OVERLAP]"));
    // File untouched on rejection
    assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\ngamma\n");
  });

  // 6. multi-line oldText
  it("supports multi-line oldText", () => {
    writeFileSync(file, "header\nfoo\nbar\nfooter\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace_text", oldText: "foo\nbar", newText: "BAZ" }],
    });
    assert.equal(r.success, true);
    assert.equal(readFileSync(file, "utf8"), "header\nBAZ\nfooter\n");
  });

  // 7. empty oldText → E_NO_MATCH (defensive)
  it("rejects empty oldText with E_NO_MATCH", () => {
    writeFileSync(file, "x\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace_text", oldText: "", newText: "y" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_NO_MATCH]"));
  });

  // Extra: two text edits chained — second sees first's result.
  it("chains text edits sequentially", () => {
    writeFileSync(file, "one two three\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [
        { op: "replace_text", oldText: "one", newText: "1" },
        { op: "replace_text", oldText: "1 two", newText: "1-2" },
      ],
    });
    assert.equal(r.success, true);
    assert.equal(readFileSync(file, "utf8"), "1-2 three\n");
  });
});
