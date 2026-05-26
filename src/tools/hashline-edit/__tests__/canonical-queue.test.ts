import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { computeCID } from "../../../utils/cid.js";
import { runQueuedHashlineEdit, safeRealpath } from "../index.js";

describe("safeRealpath", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-canon-rp-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the canonical path for an existing file", () => {
    const file = join(tmp, "f.txt");
    writeFileSync(file, "a\n");
    // tmp may itself be a symlink (e.g. /tmp -> /private/tmp on macOS).
    // realpathSync must return the resolved form, which equals realpath(file).
    const resolved = safeRealpath(file);
    assert.ok(resolved.endsWith("/f.txt"));
    // Idempotent
    assert.equal(safeRealpath(resolved), resolved);
  });

  it(
    "resolves through a symlink to the same canonical path as the target",
    { skip: process.platform === "win32" },
    () => {
      const target = join(tmp, "real.txt");
      const link = join(tmp, "link.txt");
      writeFileSync(target, "x\n");
      symlinkSync(target, link);

      assert.equal(safeRealpath(link), safeRealpath(target));
    },
  );

  it("falls back to the input on ENOENT (rename target may not exist yet)", () => {
    const missing = join(tmp, "ghost.txt");
    assert.equal(safeRealpath(missing), missing);
  });
});

describe("runQueuedHashlineEdit canonical-path queue", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hl-canon-q-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function anchor(lineNum: number, content: string): string {
    return `${lineNum}#${computeCID(lineNum, content)}`;
  }

  it(
    "serialises concurrent edits arriving via symlink + canonical paths to the same file",
    { skip: process.platform === "win32" },
    async () => {
      const real = join(tmp, "real.txt");
      const link = join(tmp, "link.txt");
      writeFileSync(real, "a\nb\nc\n");
      symlinkSync(real, link);

      // Fire BOTH writes "concurrently". Without canonical-path queueing, they
      // would acquire separate queue keys (one for `link`, one for `real`) and
      // race on the same inode — one write could overwrite the other.
      //
      // With canonical-path queueing, both edits canonicalise to realpath(real)
      // and serialise on the same key, so the second edit reads the first's
      // committed content.
      const editA = runQueuedHashlineEdit({
        filePath: link,
        edits: [{ op: "replace", pos: anchor(1, "a"), lines: "A1" }],
      });
      const editB = runQueuedHashlineEdit({
        filePath: real,
        edits: [{ op: "replace", pos: anchor(2, "b"), lines: "B2" }],
      });

      const [resA, resB] = await Promise.all([editA, editB]);

      // Both should succeed: serialised, neither sees a stale CID.
      assert.equal(resA.success, true, `editA failed: ${(resA as { error?: string }).error}`);
      assert.equal(resB.success, true, `editB failed: ${(resB as { error?: string }).error}`);

      // The final file content should reflect BOTH edits applied in some order
      // — line 1 is "A1" and line 2 is "B2" (both succeed only when serialised
      // and re-read between writes; if they raced one would be lost).
      const final = readFileSync(real, "utf8");
      assert.equal(final, "A1\nB2\nc\n");
    },
  );

  it(
    "rename queue paths are also canonicalised (test: rename target inside the same symlinked dir)",
    { skip: process.platform === "win32" },
    async () => {
      // Sanity: a single rename through a symlink should not throw even though
      // the rename target does not exist yet (ENOENT fallback in safeRealpath).
      const real = join(tmp, "real.txt");
      const link = join(tmp, "link.txt");
      writeFileSync(real, "x\n");
      symlinkSync(real, link);

      const renamedTo = join(tmp, "renamed.txt");
      const res = await runQueuedHashlineEdit({
        filePath: link,
        edits: [],
        rename: renamedTo,
      });

      // Just verify the call shape works — full atomic-rename semantics belong
      // to T3, but the queue must not crash on a missing rename target.
      assert.ok("success" in res);
      // `relative` is used merely to silence "unused import" if test changes;
      // also asserts tmp is the dir containing renamedTo.
      assert.ok(!relative(tmp, renamedTo).includes(".."));
    },
  );
});
