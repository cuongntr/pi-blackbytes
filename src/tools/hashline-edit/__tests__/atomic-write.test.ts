import { strict as assert } from "node:assert";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { computeCID } from "../../../utils/cid.js";
import { resolveWriteTarget, writeBufferFully, writeFileAtomically } from "../fs-write.js";
import { applyHashlineEdits } from "../index.js";

// All atomic-write tests touch real POSIX semantics (symlinks, hard links,
// chmod, EACCES on a 0o500 dir). Windows is skipped wholesale; see bead §
// Out of scope.
const skipOnWindows = { skip: process.platform === "win32" };

describe("atomic write — symlink preservation", skipOnWindows, () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-atomic-sym-"));
  });

  afterEach(() => {
    // Restore perms so rm can recurse if a test left a read-only dir.
    try {
      chmodSync(tmp, 0o700);
    } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writing through a symlink updates the canonical file and keeps the symlink intact", () => {
    const real = join(tmp, "real.txt");
    const link = join(tmp, "link.txt");
    writeFileSync(real, "old\n");
    symlinkSync(real, link);

    const result = applyHashlineEdits({
      filePath: link,
      edits: [{ op: "replace", pos: `1#${computeCID(1, "old")}`, lines: "new" }],
    });

    assert.equal(result.success, true);
    // Canonical target updated.
    assert.equal(readFileSync(real, "utf8"), "new\n");
    // Symlink still a symlink, not replaced by a regular file.
    assert.ok(lstatSync(link).isSymbolicLink());
  });
});

describe("atomic write — hard-link preservation", skipOnWindows, () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-atomic-hl-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writing one of two hard-linked names updates both and preserves inode", () => {
    const a = join(tmp, "a.txt");
    const b = join(tmp, "b.txt");
    writeFileSync(a, "old\n");
    linkSync(a, b);

    const beforeIno = statSync(a).ino;
    assert.equal(statSync(b).ino, beforeIno, "precondition: same inode");
    assert.equal(statSync(a).nlink, 2);

    const result = applyHashlineEdits({
      filePath: a,
      edits: [{ op: "replace", pos: `1#${computeCID(1, "old")}`, lines: "shared" }],
    });

    assert.equal(result.success, true);
    // Both names see the new content...
    assert.equal(readFileSync(a, "utf8"), "shared\n");
    assert.equal(readFileSync(b, "utf8"), "shared\n");
    // ...and the inode is preserved (in-place truncate, not rename).
    assert.equal(statSync(a).ino, beforeIno);
    assert.equal(statSync(b).ino, beforeIno);
  });
});

describe("atomic write — mode preservation", skipOnWindows, () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-atomic-mode-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("preserves 0o755 across an atomic-rename write", () => {
    const file = join(tmp, "script.sh");
    writeFileSync(file, "old\n");
    chmodSync(file, 0o755);

    const result = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: `1#${computeCID(1, "old")}`, lines: "new" }],
    });

    assert.equal(result.success, true);
    assert.equal(statSync(file).mode & 0o7777, 0o755);
    assert.equal(readFileSync(file, "utf8"), "new\n");
  });
});

describe("atomic write — stale temp tolerance", skipOnWindows, () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-atomic-stale-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("does not collide with a leftover hidden temp from a prior run", () => {
    const file = join(tmp, "f.txt");
    writeFileSync(file, "old\n");
    // Simulate a dead temp file with the legacy basename prefix.
    writeFileSync(join(tmp, ".f.txt.tmp.dead"), "ignored");

    const result = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: `1#${computeCID(1, "old")}`, lines: "fresh" }],
    });

    assert.equal(result.success, true);
    assert.equal(readFileSync(file, "utf8"), "fresh\n");
    // The dead temp must remain — we did not touch it.
    const remaining = readdirSync(tmp).filter((n) => n.startsWith(".f.txt.tmp."));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0], ".f.txt.tmp.dead");
  });
});

describe("atomic write — friendly error on read-only parent dir", skipOnWindows, () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-atomic-ro-"));
  });

  afterEach(() => {
    try {
      chmodSync(tmp, 0o700);
    } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns E_WRITE_FAILED with the underlying code when the parent dir is 0o500", (t) => {
    // Skip when running as root (EACCES does not fire for uid 0).
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("running as root — EACCES is bypassed");
      return;
    }
    const file = join(tmp, "f.txt");
    writeFileSync(file, "old\n");
    chmodSync(tmp, 0o500); // r-x: cannot create temp sibling

    const result = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: `1#${computeCID(1, "old")}`, lines: "blocked" }],
    });

    assert.equal(result.success, false);
    assert.ok("error" in result && result.error.startsWith("[E_WRITE_FAILED]"));
    // Original file should still be readable and unchanged.
    chmodSync(tmp, 0o700); // restore perms for assertions
    assert.equal(readFileSync(file, "utf8"), "old\n");
  });
});

describe("resolveWriteTarget", skipOnWindows, () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-atomic-rwt-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports hardLinkCount > 1 for hard-linked files", () => {
    const a = join(tmp, "a.txt");
    const b = join(tmp, "b.txt");
    writeFileSync(a, "x\n");
    linkSync(a, b);

    const t = resolveWriteTarget(a);
    assert.equal(t.hardLinkCount, 2);
    assert.equal(t.isSymlink, false);
    assert.equal(t.isNonRegularFile, false);
  });

  it("flags isSymlink and resolves canonicalPath", () => {
    const real = join(tmp, "real.txt");
    const link = join(tmp, "link.txt");
    writeFileSync(real, "x\n");
    symlinkSync(real, link);

    const t = resolveWriteTarget(link);
    assert.equal(t.isSymlink, true);
    // canonicalPath must match realpath(real); cannot compare to `real` directly
    // because /tmp itself may be a symlink (e.g. macOS).
    assert.equal(t.canonicalPath, resolveWriteTarget(real).canonicalPath);
  });

  it("returns defaults for a non-existent path (treated as fresh write)", () => {
    const t = resolveWriteTarget(join(tmp, "ghost.txt"));
    assert.equal(t.hardLinkCount, 1);
    assert.equal(t.mode, 0o644);
    assert.equal(t.isSymlink, false);
  });
});

// ---------------------------------------------------------------------------
// Direct unit test on writeFileAtomically — ensures content is exactly the
// bytes we passed (no encoding surprises with BOM/CRLF round-tripping).
// ---------------------------------------------------------------------------

describe("writeFileAtomically — byte-for-byte preservation", skipOnWindows, () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-atomic-bytes-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("preserves BOM and CRLF when caller embeds them in the payload", () => {
    const file = join(tmp, "bom.txt");
    writeFileSync(file, "x");
    const payload = "\uFEFFhello\r\nworld\r\n";
    writeFileAtomically(file, 1, 0o644, payload);
    assert.equal(readFileSync(file, "utf8"), payload);
  });
});

describe("writeBufferFully", () => {
  it("advances by bytes written until a UTF-8 buffer is complete", () => {
    const source = Buffer.from("a😀z", "utf8");
    const output = Buffer.alloc(source.length);
    const offsets: number[] = [];

    writeBufferFully(1, source, (_fd, buffer, offset, length) => {
      offsets.push(offset);
      const written = Math.min(2, length);
      buffer.copy(output, offset, offset, offset + written);
      return written;
    });

    assert.deepEqual(offsets, [0, 2, 4]);
    assert.deepEqual(output, source);
  });

  it("throws when a write makes no progress", () => {
    assert.throws(() => writeBufferFully(1, Buffer.from("data"), () => 0), /made no progress/);
  });
});

describe("writeFileAtomically — temp cleanup", skipOnWindows, () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-atomic-cleanup-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the unpublished temp and preserves the target after a pre-rename failure", () => {
    const file = join(tmp, "f.txt");
    writeFileSync(file, "old\n");

    assert.throws(() => writeFileAtomically(file, 1, -1, "new\n"));
    assert.equal(readFileSync(file, "utf8"), "old\n");
    assert.deepEqual(readdirSync(tmp), ["f.txt"]);
  });
});

describe("writeFileAtomically — mode bypasses umask", skipOnWindows, () => {
  let tmp: string;
  let prevUmask: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-atomic-umask-"));
    // Force a restrictive umask so openSync(..., mode) would otherwise mask
    // off group/other bits. fchmod inside writeViaTempRename must override.
    prevUmask = process.umask(0o077);
  });

  afterEach(() => {
    process.umask(prevUmask);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("preserves 0o664 across an atomic-rename write even under a 0o077 umask", () => {
    const file = join(tmp, "data.txt");
    writeFileSync(file, "old\n");
    chmodSync(file, 0o664);

    const result = applyHashlineEdits({
      filePath: file,
      edits: [{ op: "replace", pos: `1#${computeCID(1, "old")}`, lines: "new" }],
    });

    assert.equal(result.success, true);
    assert.equal(statSync(file).mode & 0o7777, 0o664);
  });
});
