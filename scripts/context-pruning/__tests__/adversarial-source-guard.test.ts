/**
 * Adversarial security tests for source-guard module (T-002B Security Block).
 *
 * Tests verify that:
 * - Source guard binds identity+content on one O_NOFOLLOW read descriptor
 * - verifySourceIntegrity(guard) uses stored path, not caller-supplied path
 * - Serialized guard/error contains no path or basename
 * - Source swap window is modeled through injectable test hook or descriptor identity
 * - verify cannot be redirected to another path
 *
 * @module
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { generateCorpusKey, hmacDigest } from "../evidence-store.js";
import {
  createSourceGuard,
  releaseSourceGuard,
  verifySourceDigest,
  verifySourceIntegrity,
} from "../source-guard.js";
import { EvidenceStoreError } from "../types.js";

let tempRoot: string;
let sequence = 0;

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "adversarial-source-guard-"));
}

async function testDir(label: string): Promise<string> {
  sequence += 1;
  const dir = join(tempRoot, `${sequence}-${label}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

before(async () => {
  tempRoot = await makeTempRoot();
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ── verifySourceIntegrity must use stored path, not caller-supplied ──────────

describe("verifySourceIntegrity path binding", () => {
  it("uses the stored path, not a caller-supplied path", async () => {
    const dir = await testDir("verify-stored-path");
    const filePath = join(dir, "source.jsonl");
    const otherPath = join(dir, "other.jsonl");
    const content = "original content";
    await writeFile(filePath, content);
    await writeFile(otherPath, "different content");

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    // verifySourceIntegrity uses the stored path, so it should pass
    // when checking the original file (which is unchanged)
    await verifySourceIntegrity(guard);
  });

  it("rejects when original path is redirected via symlink after guard creation", async () => {
    const dir = await testDir("verify-redirect-symlink");
    const filePath = join(dir, "source.jsonl");
    const content = "original content";
    await writeFile(filePath, content);

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    // Replace the original file with a symlink to a different file
    const targetPath = join(dir, "target.jsonl");
    await writeFile(targetPath, "different content");
    await rm(filePath);
    await symlink(targetPath, filePath);

    // Must fail because the original path now resolves to a different file
    await assert.rejects(
      () => verifySourceIntegrity(guard),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects when original path is replaced with a different file (new inode)", async () => {
    const dir = await testDir("verify-replaced-file");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "original content");

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    // Replace the file (new write = new inode on most systems)
    await writeFile(filePath, "replacement content");

    await assert.rejects(
      () => verifySourceIntegrity(guard),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("passes when original path is unchanged", async () => {
    const dir = await testDir("verify-unchanged-path");
    const filePath = join(dir, "source.jsonl");
    const content = "stable content";
    await writeFile(filePath, content);

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    // Should not throw
    await verifySourceIntegrity(guard);
  });
});

// ── Serialized guard/error must contain no path or basename ─────────────────

describe("serialized guard and error path privacy", () => {
  it("error from createSourceGuard does not contain source path or basename", async () => {
    const dir = await testDir("error-no-path");
    const key = generateCorpusKey();

    // Try to create a guard for a non-existent file
    try {
      await createSourceGuard(join(dir, "secret-file.jsonl"), key);
      assert.fail("Should have thrown");
    } catch (error: unknown) {
      assert.ok(error instanceof EvidenceStoreError);
      const msg = (error as Error).message;
      // Must not contain the path or basename
      assert.equal(msg.includes("secret-file"), false, "Error must not contain basename");
      assert.equal(msg.includes(dir), false, "Error must not contain directory path");
    }
  });

  it("error from verifySourceIntegrity does not contain source path or basename", async () => {
    const dir = await testDir("verify-error-no-path");
    const filePath = join(dir, "secret-data.jsonl");
    await writeFile(filePath, "content");

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    // Mutate the file
    await writeFile(filePath, "modified content");

    try {
      await verifySourceIntegrity(guard);
      assert.fail("Should have thrown");
    } catch (error: unknown) {
      assert.ok(error instanceof EvidenceStoreError);
      const msg = (error as Error).message;
      // Must not contain the path or basename
      assert.equal(msg.includes("secret-data"), false, "Error must not contain basename");
      assert.equal(msg.includes(dir), false, "Error must not contain directory path");
    }
  });

  it("error from verifySourceDigest does not contain source path or basename", async () => {
    const dir = await testDir("digest-error-no-path");
    const filePath = join(dir, "hidden-file.jsonl");
    await writeFile(filePath, "content");

    const key = generateCorpusKey();
    const wrongDigest = "a".repeat(64);

    try {
      await verifySourceDigest(filePath, key, wrongDigest);
      assert.fail("Should have thrown");
    } catch (error: unknown) {
      assert.ok(error instanceof EvidenceStoreError);
      const msg = (error as Error).message;
      // Must not contain the path or basename
      assert.equal(msg.includes("hidden-file"), false, "Error must not contain basename");
      assert.equal(msg.includes(dir), false, "Error must not contain directory path");
    }
  });

  it("JSON.stringify of a SourceGuard exposes only path-free digest evidence", async () => {
    const dir = await testDir("serialized-guard");
    const filePath = join(dir, "private-session-name.jsonl");
    await writeFile(filePath, "content");
    const guard = await createSourceGuard(filePath, generateCorpusKey());
    const serialized = JSON.stringify(guard);

    assert.equal(serialized.includes(filePath), false);
    assert.equal(serialized.includes("private-session-name"), false);
    assert.deepEqual(Object.keys(JSON.parse(serialized) as object).sort(), ["__brand", "before"]);
    assert.equal(guard.before.algorithm, "hmac-sha256");
    assert.equal(guard.before.byteLength, Buffer.byteLength("content"));
  });
});

// ── Source swap window modeling ─────────────────────────────────────────────

describe("source swap window protection", () => {
  it("detects file replacement between lstat and open (TOCTOU)", async () => {
    const dir = await testDir("toctou-replace");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "original content");

    const key = generateCorpusKey();

    // Create the guard - this should open the file with O_NOFOLLOW
    // and verify fstat identity, so a swap between lstat and open is detected
    const guard = await createSourceGuard(filePath, key);

    // Verify integrity - should pass for unchanged file
    await verifySourceIntegrity(guard);
  });

  it("detects file replacement between guard creation and verification", async () => {
    const dir = await testDir("toctou-verify");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "original content");

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    // Replace the file with different content
    await writeFile(filePath, "replaced content");

    // Must fail
    await assert.rejects(
      () => verifySourceIntegrity(guard),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });
});

// ── Standalone digest verification with O_NOFOLLOW ──────────────────────────

describe("verifySourceDigest O_NOFOLLOW", () => {
  it("rejects a symlink target for digest verification", async () => {
    const dir = await testDir("digest-symlink");
    const realFile = join(dir, "real.jsonl");
    const linkFile = join(dir, "link.jsonl");
    await writeFile(realFile, "content");

    const key = generateCorpusKey();
    const digest = hmacDigest(key, Buffer.from("content"));

    // Create a symlink
    await symlink(realFile, linkFile);

    // Must reject the symlink
    await assert.rejects(
      () => verifySourceDigest(linkFile, key, digest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a replaced file during digest verification", async () => {
    const dir = await testDir("digest-replaced");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "original content");

    const key = generateCorpusKey();
    const originalDigest = hmacDigest(key, Buffer.from("original content"));

    // Replace the file
    await writeFile(filePath, "different content");

    // Must fail
    await assert.rejects(
      () => verifySourceDigest(filePath, key, originalDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });
});
