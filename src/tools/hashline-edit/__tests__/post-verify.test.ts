import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { computeCID } from "../../../utils/cid.js";
import { applyHashlineEdits } from "../index.js";
import { verifyPersistedContent } from "../post-verify.js";

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe("verifyPersistedContent", () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-verify-"));
    file = join(tmp, "f.txt");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok=true when persisted bytes match intended", () => {
    const content = "hello\nworld\n";
    writeFileSync(file, content);
    assert.deepEqual(verifyPersistedContent(file, content), { ok: true });
  });

  it("returns ok=false with diff context when bytes differ", () => {
    writeFileSync(file, "hello\nworld\n");
    const r = verifyPersistedContent(file, "hello\nWORLD\n");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.diffContext.includes("First divergence"));
      assert.ok(r.diffContext.includes("Intended:"));
      assert.ok(r.diffContext.includes("Actual"));
    }
  });

  it("locates divergence line and column correctly", () => {
    writeFileSync(file, "a\nb\nc\nd\n");
    const r = verifyPersistedContent(file, "a\nb\nX\nd\n");
    assert.equal(r.ok, false);
    if (!r.ok) {
      // divergence at line 3, column 1 (the 'c' vs 'X')
      assert.ok(r.diffContext.includes("line 3"));
      assert.ok(r.diffContext.includes("column 1"));
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: applyHashlineEdits with postEditVerify=true
// ---------------------------------------------------------------------------

describe("applyHashlineEdits + postEditVerify", () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-verify-int-"));
    file = join(tmp, "f.txt");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function anchor(lineNum: number, content: string): string {
    return `${lineNum}#${computeCID(lineNum, content)}`;
  }

  it("happy path: verify passes, success returned with diff preview", () => {
    writeFileSync(file, "a\nb\nc\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: anchor(2, "b"), lines: "B" }],
      postEditVerify: true,
    });
    assert.equal(r.success, true);
    assert.equal(readFileSync(file, "utf8"), "a\nB\nc\n");
  });

  it("flag absent → no verification, no extra read cost (smoke: success path unchanged)", () => {
    writeFileSync(file, "a\nb\nc\n");
    const r = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: anchor(2, "b"), lines: "B" }],
      // postEditVerify omitted
    });
    assert.equal(r.success, true);
  });

  it("mismatch → E_VERIFY_FAILED + rollback restores original bytes", () => {
    const original = "a\nb\nc\n";
    writeFileSync(file, original);

    // Inject a fake verify-read that pretends the persisted bytes are wrong.
    const r = applyHashlineEdits(
      {
        filePath: file,
        edits: [{ op: "replace", pos: anchor(2, "b"), lines: "B" }],
        postEditVerify: true,
      },
      { __verifyReadFn: () => "TAMPERED" },
    );

    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_VERIFY_FAILED]"));
    assert.ok("error" in r && r.error.includes("First divergence"));
    assert.ok("error" in r && r.error.includes("Rolled back"));

    // Real rollback path executed — file restored to pre-edit bytes.
    assert.equal(readFileSync(file, "utf8"), original);
  });

  it("mismatch + rollback failure → error message mentions partial corruption", () => {
    writeFileSync(file, "a\nb\nc\n");

    const r = applyHashlineEdits(
      {
        filePath: file,
        edits: [{ op: "replace", pos: anchor(2, "b"), lines: "B" }],
        postEditVerify: true,
      },
      {
        __verifyReadFn: () => "TAMPERED",
        __rollbackWriteFn: () => {
          const err = new Error("read-only fs") as NodeJS.ErrnoException;
          err.code = "EROFS";
          throw err;
        },
      },
    );

    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_VERIFY_FAILED]"));
    assert.ok("error" in r && r.error.includes("Rollback failed"));
    assert.ok("error" in r && r.error.includes("partially corrupted"));
  });

  it("rename to NEW target + verify fail → rollback unlinks the new file, source untouched", () => {
    const src = file;
    const dst = join(tmp, "dst.txt");
    writeFileSync(src, "a\nb\nc\n");

    const r = applyHashlineEdits(
      {
        filePath: src,
        rename: dst,
        edits: [{ op: "replace", pos: anchor(2, "b"), lines: "B" }],
        postEditVerify: true,
      },
      { __verifyReadFn: () => "TAMPERED" },
    );

    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_VERIFY_FAILED]"));
    assert.ok("error" in r && r.error.includes("removing the newly-created file"));
    // Source must be untouched (rename unlink only happens after verify success).
    assert.equal(readFileSync(src, "utf8"), "a\nb\nc\n");
    // Rename target must not exist any more.
    assert.throws(() => readFileSync(dst, "utf8"));
  });

  it("rename to PRE-EXISTING target + verify fail → rollback restores target's prior bytes", () => {
    const src = file;
    const dst = join(tmp, "dst.txt");
    writeFileSync(src, "a\nb\nc\n");
    const dstOriginal = "PRIOR TARGET CONTENT\n";
    writeFileSync(dst, dstOriginal);

    const r = applyHashlineEdits(
      {
        filePath: src,
        rename: dst,
        edits: [{ op: "replace", pos: anchor(2, "b"), lines: "B" }],
        postEditVerify: true,
      },
      { __verifyReadFn: () => "TAMPERED" },
    );

    assert.equal(r.success, false);
    assert.ok("error" in r && r.error.startsWith("[E_VERIFY_FAILED]"));
    assert.ok("error" in r && r.error.includes("Rolled back to pre-edit content"));
    // CRITICAL: rename target's prior bytes restored (not overwritten with source content).
    assert.equal(readFileSync(dst, "utf8"), dstOriginal);
    // Source untouched.
    assert.equal(readFileSync(src, "utf8"), "a\nb\nc\n");
  });
});
