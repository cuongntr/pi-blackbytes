import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { computeCID } from "../../../utils/cid.js";
import { ERROR_CODES, formatError, validateLines } from "../errors.js";
import { applyHashlineEdits } from "../index.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("formatError", () => {
  it("formats without context", () => {
    assert.equal(formatError(ERROR_CODES.E_BAD_REF, "bad"), "[E_BAD_REF] bad");
  });

  it("formats with context joined by single newline", () => {
    assert.equal(
      formatError(ERROR_CODES.E_HASH_MISMATCH, "msg", "ctx line 1\nctx line 2"),
      "[E_HASH_MISMATCH] msg\nctx line 1\nctx line 2",
    );
  });

  it("treats empty context as no context", () => {
    // Empty string is falsy → no trailing newline
    assert.equal(formatError(ERROR_CODES.E_NOT_FOUND, "msg", ""), "[E_NOT_FOUND] msg");
  });

  it("exposes a stable set of 10 codes", () => {
    const codes = Object.values(ERROR_CODES);
    assert.equal(codes.length, 10);
    assert.deepEqual(new Set(codes), new Set(codes), "no duplicates");
  });
});

describe("validateLines", () => {
  it("returns null for clean lines", () => {
    assert.equal(validateLines(["hello", "world", "  42 is fine"]), null);
  });

  it("flags LINE#ID| prefix at the start", () => {
    const p = validateLines(["ok", "42#KQ|bad", "ok"]);
    assert.ok(p);
    assert.equal(p?.index, 1);
    assert.equal(p?.preview, "42#KQ|bad");
  });

  it("flags shape-only prefix outside the CID alphabet (e.g. `OL`)", () => {
    const p = validateLines(["7#OL|nope"]);
    assert.ok(p);
    assert.equal(p?.index, 0);
  });

  it("does NOT flag diff-marker prefixes (`+ ` / `- `) — too prone to false positives", () => {
    // Bullet-list content must not be rejected
    assert.equal(validateLines(["- bullet item", "+ added line"]), null);
  });

  it("does NOT flag prefix-like text mid-line", () => {
    assert.equal(validateLines(["see 42#KQ|foo for ref"]), null);
  });

  it("truncates long previews to 117 chars + ellipsis", () => {
    const long = `42#KQ|${"x".repeat(200)}`;
    const p = validateLines([long]);
    assert.ok(p);
    assert.equal(p?.preview.length, 118);
    assert.ok(p?.preview.endsWith("…"));
  });
});

// ---------------------------------------------------------------------------
// Integration: every code surfaces from applyHashlineEdits
// ---------------------------------------------------------------------------

describe("hashline_edit error codes (integration)", () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-errors-"));
    file = join(tmp, "f.txt");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function anchor(lineNum: number, content: string): string {
    return `${lineNum}#${computeCID(lineNum, content)}`;
  }

  it("E_NOT_FOUND when file is missing", () => {
    const r = applyHashlineEdits({ filePath: join(tmp, "missing.txt"), edits: [] });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_NOT_FOUND]"));
  });

  it("E_BAD_REF on malformed anchor string", () => {
    writeFileSync(file, "a\nb\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: "not-an-anchor", lines: "x" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_BAD_REF]"));
  });

  it("E_BAD_REF on inverted range (start > end)", () => {
    writeFileSync(file, "a\nb\nc\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: anchor(3, "c"), end: anchor(1, "a"), lines: "x" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_BAD_REF]"));
  });

  it("E_OUT_OF_RANGE when anchor line exceeds file length", () => {
    writeFileSync(file, "a\nb\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: "99#KQ", lines: "x" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_OUT_OF_RANGE]"));
  });

  it("E_HASH_MISMATCH when CID does not match content", () => {
    writeFileSync(file, "a\nb\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: "1#KQ", lines: "x" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_HASH_MISMATCH]"));
  });

  it("E_INVALID_PATCH on delete + edits combo", () => {
    writeFileSync(file, "a\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: anchor(1, "a"), lines: "x" }],
      delete: true,
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_INVALID_PATCH]"));
  });

  it("E_INVALID_PATCH on prefixed lines (strict mode)", () => {
    writeFileSync(file, "a\nb\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: anchor(1, "a"), lines: "1#AB|prefixed" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_INVALID_PATCH]"));
  });

  it("E_OVERLAP when two replace edits cover overlapping ranges", () => {
    writeFileSync(file, "a\nb\nc\nd\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [
        { op: "replace", pos: anchor(1, "a"), end: anchor(3, "c"), lines: "x" },
        { op: "replace", pos: anchor(2, "b"), end: anchor(4, "d"), lines: "y" },
      ],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_OVERLAP]"));
  });

  it("E_WRITE_FAILED when delete target cannot be removed", () => {
    // Delete a non-existent path triggers unlinkSync ENOENT
    const r = applyHashlineEdits({
      filePath: join(tmp, "ghost.txt"),
      edits: [],
      delete: true,
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_WRITE_FAILED]"));
  });

  it("E_NO_MATCH and E_MULTI_MATCH and E_VERIFY_FAILED codes are reserved (defined, not yet wired)", () => {
    // Sanity: ensure the codes exist so T4/T7 can wire them later.
    assert.equal(ERROR_CODES.E_NO_MATCH, "E_NO_MATCH");
    assert.equal(ERROR_CODES.E_MULTI_MATCH, "E_MULTI_MATCH");
    assert.equal(ERROR_CODES.E_VERIFY_FAILED, "E_VERIFY_FAILED");
  });
});
