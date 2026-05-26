import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _resetEnabledSet, initEnabledSet } from "../../../config/enabled-set.js";
import { parseBlackbytesConfig } from "../../../config/schema.js";
import { applyHashlineEdits, registerHashlineEditTool } from "../index.js";

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

interface HashlineToolResult {
  readonly isError?: boolean;
  readonly content: Array<{ type: string; text: string }>;
  readonly details?: { summary?: string; fullText?: string };
}

function makeConfig() {
  const result = parseBlackbytesConfig({});
  if (!result.ok) throw new Error(result.errors.join(", "));
  return result.value;
}

function makeMockPi() {
  const registered: unknown[] = [];
  return {
    pi: {
      registerTool(definition: unknown) {
        registered.push(definition);
      },
    },
    registered,
  };
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
    _resetEnabledSet();
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

  it("rejects lines containing LINE#ID prefix under strict_patch (default)", () => {
    writeTmp("foo\nbar\nbaz\n");
    const pos = anchor(2, "bar");

    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "replace", pos, lines: "2#AB|replacement" }],
    });

    assert.equal(result.success, false);
    assert.ok("error" in result && result.error.startsWith("[E_INVALID_PATCH]"));
    // File untouched on rejection
    assert.equal(readTmp(), "foo\nbar\nbaz\n");
  });

  it("rejects shape-only prefix even when CID alphabet is outside the canonical set", () => {
    writeTmp("foo\nbar\nbaz\n");
    const pos = anchor(2, "bar");

    // "OL" is not in the CID alphabet but matches the [A-Z]{2} shape
    const result = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "replace", pos, lines: "99#OL|replacement" }],
    });

    assert.equal(result.success, false);
    assert.ok("error" in result && result.error.startsWith("[E_INVALID_PATCH]"));
  });

  it("strips LINE#ID prefixes under strict_patch=false (legacy behaviour)", () => {
    writeTmp("foo\nbar\nbaz\n");
    const pos = anchor(2, "bar");

    const result = applyHashlineEdits(
      {
        filePath: tmpFile,
        edits: [{ op: "replace", pos, lines: "2#AB|replacement" }],
      },
      { strictPatch: false },
    );

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

  it("registered tool compacts long errors while preserving full details", async () => {
    initEnabledSet(makeConfig());
    const { pi, registered } = makeMockPi();
    registerHashlineEditTool(pi as Parameters<typeof registerHashlineEditTool>[0]);

    const tool = registered[0] as {
      execute: (_toolCallId: string, input: unknown) => Promise<HashlineToolResult>;
    };
    const content = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n");
    writeTmp(`${content}\n`);

    const result = await tool.execute("test-call", {
      filePath: tmpFile,
      edits: [{ op: "replace", pos: "999#ZZ", lines: "replacement" }],
    });

    assert.equal(result.isError, true);
    assert.ok(result.details?.fullText, "full error should be available in details");
    assert.ok(result.content[0].text.length < result.details.fullText.length);
    assert.match(result.content[0].text, /Output shortened/);
    assert.match(result.content[0].text, /line 300/);
    assert.match(result.details.summary ?? "", />>> mismatch/);
    assert.match(result.details.fullText, /Current file/);
    assert.match(result.details.fullText, /line 300/);
  });
});

describe("edit op aliases (T8)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "hl-aliases-"));
  const tmpFile = join(tmpDir, "f.txt");

  function writeTmp(content: string) {
    writeFileSync(tmpFile, content);
  }
  function readTmp(): string {
    return readFileSync(tmpFile, "utf8");
  }
  function anchor(lineNum: number, content: string): string {
    return `${lineNum}#${computeCID(lineNum, content)}`;
  }

  it("insert_after acts like append with pos", () => {
    writeTmp("a\nb\nc\n");
    const r = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "insert_after", pos: anchor(1, "a"), lines: "A2" }],
    });
    assert.equal(r.success, true);
    assert.equal(readTmp(), "a\nA2\nb\nc\n");
  });

  it("insert_before acts like prepend with pos", () => {
    writeTmp("a\nb\nc\n");
    const r = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "insert_before", pos: anchor(3, "c"), lines: "C0" }],
    });
    assert.equal(r.success, true);
    assert.equal(readTmp(), "a\nb\nC0\nc\n");
  });

  it("replace_range acts like replace with pos+end", () => {
    writeTmp("a\nb\nc\nd\n");
    const r = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "replace_range", pos: anchor(2, "b"), end: anchor(3, "c"), lines: "BC" }],
    });
    assert.equal(r.success, true);
    assert.equal(readTmp(), "a\nBC\nd\n");
  });

  it("insert_after without pos → E_BAD_REF", () => {
    writeTmp("a\n");
    const r = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "insert_after", lines: "x" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_BAD_REF]"));
  });

  it("insert_before without pos → E_BAD_REF", () => {
    writeTmp("a\n");
    const r = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "insert_before", lines: "x" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_BAD_REF]"));
  });

  it("replace_range without end → E_BAD_REF", () => {
    writeTmp("a\nb\n");
    const r = applyHashlineEdits({
      filePath: tmpFile,
      edits: [{ op: "replace_range", pos: anchor(1, "a"), lines: "x" }],
    });
    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_BAD_REF]"));
  });
});
