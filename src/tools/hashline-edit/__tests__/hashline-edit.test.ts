import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyHashlineEdits } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CID_CHARS = "ZPMQVRWSNKTXJBYH";

function computeCID(lineNum: number, content: string): string {
  let hash = lineNum * 31;
  const normalized = content.replace(/\r/g, "").trimEnd();
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) & 0xffff;
  }
  return CID_CHARS[hash & 0xf] + CID_CHARS[(hash >> 4) & 0xf];
}

function anchor(lineNum: number, line: string): string {
  return `${lineNum}#${computeCID(lineNum, line)}`;
}

let tmpDir: string;
let tmpFile: string;

function writeTmp(content: string): string {
  writeFileSync(tmpFile, content, "utf8");
  return tmpFile;
}

function readTmp(): string {
  return readFileSync(tmpFile, "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hashline_edit", () => {
  beforeEach(() => {
    tmpDir = tmpdir();
    tmpFile = join(
      tmpDir,
      `hashline-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
  });

  afterEach(() => {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it("single-line replace", () => {
    writeTmp("line one\nline two\nline three\n");
    const pos = anchor(2, "line two");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "replace", pos, lines: "replaced line" }],
    });

    assert.equal(result.success, true);
    assert.equal(readTmp(), "line one\nreplaced line\nline three\n");
  });

  it("range replace", () => {
    writeTmp("alpha\nbeta\ngamma\ndelta\n");
    const pos = anchor(2, "beta");
    const end = anchor(3, "gamma");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "replace", pos, end, lines: ["new line"] }],
    });

    assert.equal(result.success, true);
    assert.equal(readTmp(), "alpha\nnew line\ndelta\n");
  });

  it("delete line (lines=null)", () => {
    writeTmp("keep\ndelete me\nkeep too\n");
    const pos = anchor(2, "delete me");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "replace", pos, lines: null }],
    });

    assert.equal(result.success, true);
    assert.equal(readTmp(), "keep\nkeep too\n");
  });

  it("append after anchor", () => {
    writeTmp("first\nsecond\nthird\n");
    const pos = anchor(1, "first");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "append", pos, lines: "inserted" }],
    });

    assert.equal(result.success, true);
    assert.equal(readTmp(), "first\ninserted\nsecond\nthird\n");
  });

  it("prepend before anchor", () => {
    writeTmp("first\nsecond\nthird\n");
    const pos = anchor(2, "second");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "prepend", pos, lines: "before second" }],
    });

    assert.equal(result.success, true);
    assert.equal(readTmp(), "first\nbefore second\nsecond\nthird\n");
  });

  it("append at EOF (no pos)", () => {
    writeTmp("line a\nline b\n");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "append", lines: "line c" }],
    });

    assert.equal(result.success, true);
    assert.equal(readTmp(), "line a\nline b\nline c\n");
  });

  it("prepend at BOF (no pos)", () => {
    writeTmp("line a\nline b\n");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "prepend", lines: "line 0" }],
    });

    assert.equal(result.success, true);
    assert.equal(readTmp(), "line 0\nline a\nline b\n");
  });

  it("multi-edit batch applies bottom-up ordering correctly", () => {
    // Replace line 1 and line 3 in one call — must apply bottom-up so
    // replacing line 3 first doesn't affect line 1's index.
    writeTmp("aaa\nbbb\nccc\n");
    const pos1 = anchor(1, "aaa");
    const pos3 = anchor(3, "ccc");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [
        // Intentionally provide in ascending order to verify tool sorts bottom-up
        { op: "replace", pos: pos1, lines: "AAA" },
        { op: "replace", pos: pos3, lines: "CCC" },
      ],
    });

    assert.equal(result.success, true);
    assert.equal(readTmp(), "AAA\nbbb\nCCC\n");
  });

  it("anchor mismatch returns error with current anchors", () => {
    writeTmp("real content\n");
    // Fabricate an anchor with wrong CID
    const badAnchor = "1#ZZ"; // ZZ is very likely not the real CID

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "replace", pos: badAnchor, lines: "new" }],
    });

    // May or may not be a mismatch depending on CID for "real content" at line 1
    // Let's compute real CID and verify the mismatch path by using a definitely wrong one
    const realCID = computeCID(1, "real content");
    if (realCID === "ZZ") {
      // astronomically unlikely but handle it
      assert.equal(result.success, true);
    } else {
      assert.equal(result.success, false);
      assert.ok("error" in result && result.error.includes(">>> mismatch"));
      assert.ok("error" in result && result.error.includes("1#"));
    }
  });

  it("strips LINE#ID prefixes from user-provided lines", () => {
    writeTmp("foo\nbar\nbaz\n");
    const pos = anchor(2, "bar");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "replace", pos, lines: "2#AB|replacement" }],
    });

    assert.equal(result.success, true);
    assert.equal(readTmp(), "foo\nreplacement\nbaz\n");
  });

  it("file not found returns error", () => {
    const result = applyHashlineEdits({
      filePath: "/nonexistent/path/to/file.txt",
      edits: [],
    });

    assert.equal(result.success, false);
    assert.ok("error" in result && result.error.includes("File not found"));
  });

  it("delete=true removes the file", () => {
    writeTmp("some content\n");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [],
      delete: true,
    });

    assert.equal(result.success, true);
    assert.equal(existsSync(tmpFile), false);
    // Prevent afterEach from complaining about missing file
    writeFileSync(tmpFile, ""); // recreate empty so cleanup doesn't throw
  });

  it("rename moves file to new path", () => {
    writeTmp("content to rename\n");
    const newPath = `${tmpFile}.renamed`;

    try {
      const result = applyHashlineEdits({
        filePath: tmpFile,
        edits: [],
        rename: newPath,
      });

      assert.equal(result.success, true);
      assert.equal(existsSync(newPath), true);
      assert.equal(readFileSync(newPath, "utf8"), "content to rename\n");
    } finally {
      try {
        unlinkSync(newPath);
      } catch {
        /* ignore */
      }
    }
  });
});
