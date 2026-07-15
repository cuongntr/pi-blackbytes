/**
 * Adversarial hermetic tests for source-guard module (T-002B).
 *
 * Tests run under a temporary directory and never touch real sessions.
 * Verifies that source paths and basenames never appear in error messages.
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
  return mkdtemp(join(tmpdir(), "source-guard-test-"));
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

// ── Source guard creation ────────────────────────────────────────────────────

describe("createSourceGuard", () => {
  it("creates a guard for a valid source file", async () => {
    const dir = await testDir("create-valid");
    const filePath = join(dir, "source.jsonl");
    const content = '{"eventId":"test","type":"message"}\n';
    await writeFile(filePath, content);

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    assert.ok(guard);
    assert.equal(guard.__brand, "SourceGuard");
    assert.deepEqual(guard.before, {
      algorithm: "hmac-sha256",
      digest: hmacDigest(key, Buffer.from(content)),
      byteLength: Buffer.byteLength(content),
    });
  });

  it("rejects a non-existent file", async () => {
    const dir = await testDir("create-nonexistent");
    const key = generateCorpusKey();

    await assert.rejects(
      () => createSourceGuard(join(dir, "nonexistent.jsonl"), key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        // Error must not contain the source path or basename
        const msg = (error as Error).message;
        assert.equal(msg.includes("nonexistent"), false);
        return true;
      },
    );
  });

  it("rejects a symlink to a regular file", async () => {
    const dir = await testDir("create-symlink");
    const realFile = join(dir, "real.jsonl");
    const linkFile = join(dir, "link.jsonl");
    await writeFile(realFile, "content");
    await symlink(realFile, linkFile);

    const key = generateCorpusKey();

    await assert.rejects(
      () => createSourceGuard(linkFile, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a directory", async () => {
    const dir = await testDir("create-directory");
    const key = generateCorpusKey();

    await assert.rejects(
      () => createSourceGuard(dir, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects an invalid corpus key format", async () => {
    const dir = await testDir("create-bad-key");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "content");

    await assert.rejects(
      () => createSourceGuard(filePath, "not-a-valid-hex-key"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });
});

// ── Source integrity verification ───────────────────────────────────────────

describe("verifySourceIntegrity", () => {
  it("passes for an unchanged source file", async () => {
    const dir = await testDir("verify-unchanged");
    const filePath = join(dir, "source.jsonl");
    const content = '{"eventId":"test","type":"message"}\n';
    await writeFile(filePath, content);

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    const after = await verifySourceIntegrity(guard);
    assert.deepEqual(after, guard.before);
  });

  it("fails for a mutated source file (content changed)", async () => {
    const dir = await testDir("verify-mutated");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "original content");

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    // Mutate the file
    await writeFile(filePath, "modified content");

    await assert.rejects(
      () => verifySourceIntegrity(guard),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        // Error must not contain the source path or basename
        const msg = (error as Error).message;
        assert.equal(msg.includes("source.jsonl"), false);
        return true;
      },
    );
  });

  it("fails for a replaced source file (different inode)", async () => {
    const dir = await testDir("verify-replaced");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "original content");

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    // Replace the file (new inode)
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

  it("fails when source file is replaced by a symlink", async () => {
    const dir = await testDir("verify-symlink-replace");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "original content");

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);

    // Replace the file with a symlink
    await rm(filePath);
    const target = join(dir, "target.jsonl");
    await writeFile(target, "target content");
    await symlink(target, filePath);

    await assert.rejects(
      () => verifySourceIntegrity(guard),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("fails for a released guard", async () => {
    const dir = await testDir("verify-released");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "content");

    const key = generateCorpusKey();
    const guard = await createSourceGuard(filePath, key);
    releaseSourceGuard(guard);

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

// ── Standalone digest verification ───────────────────────────────────────────

describe("verifySourceDigest", () => {
  it("passes for matching digest", async () => {
    const dir = await testDir("digest-match");
    const filePath = join(dir, "source.jsonl");
    const content = "hello world";
    await writeFile(filePath, content);

    const key = generateCorpusKey();
    const expectedDigest = hmacDigest(key, Buffer.from(content));

    await verifySourceDigest(filePath, key, expectedDigest);
  });

  it("fails for mismatched digest", async () => {
    const dir = await testDir("digest-mismatch");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "hello world");

    const key = generateCorpusKey();
    const wrongDigest = "a".repeat(64);

    await assert.rejects(
      () => verifySourceDigest(filePath, key, wrongDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("fails for invalid corpus key format", async () => {
    const dir = await testDir("digest-bad-key");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "content");

    await assert.rejects(
      () => verifySourceDigest(filePath, "bad-key", "a".repeat(64)),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("fails for invalid expected digest format", async () => {
    const dir = await testDir("digest-bad-expected");
    const filePath = join(dir, "source.jsonl");
    await writeFile(filePath, "content");

    const key = generateCorpusKey();

    await assert.rejects(
      () => verifySourceDigest(filePath, key, "not-a-digest"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });
});
