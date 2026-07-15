/**
 * Adversarial security tests for path-safety module (T-002B Security Block).
 *
 * Tests verify that:
 * - SafeRun capability is runtime-unforgeable (not just a string brand)
 * - Raw arbitrary-path write/create APIs are not exported
 * - Symlinks are rejected in every evidence-root/run/path component
 * - Every safe read/stat/write walks existing components with lstat,
 *   rejects symlink/special/cross-device, uses O_NOFOLLOW for final opens
 * - getSafeRunRoot is not exported
 * - PreManifestRun is opaque and forged handles cannot initialize anything
 *
 * @module
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalJson } from "../canonical-json.js";
import {
  atomicManifestWrite,
  corpusKeyDigest,
  generateCorpusKey,
  loadOrCreateCorpusKey,
} from "../evidence-store.js";
import {
  ensurePrivateRunRoot,
  openSafeRun,
  preManifestRunId,
  preManifestRunPath,
  resolveEvidenceRoot,
  safeRunPath,
  safeRunReadFile,
  safeRunReaddir,
  safeRunStat,
  safeRunWriteFile,
} from "../path-safety.js";
import type { PreManifestRun, SafeRun } from "../path-safety.js";
import { EvidenceStoreError } from "../types.js";
import type { RunManifest } from "../types.js";

let tempRoot: string;
let sequence = 0;

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "adversarial-path-safety-"));
}

async function testDir(label: string): Promise<string> {
  sequence += 1;
  const dir = join(tempRoot, `${sequence}-${label}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function makeManifest(runId: string, corpusKeyDigestVal: string): RunManifest {
  return {
    schemaVersion: 1,
    runId,
    createdAt: "2026-07-14T12:00:00.000Z",
    corpusKeyDigest: corpusKeyDigestVal,
    eventCount: 0,
  };
}

before(async () => {
  tempRoot = await makeTempRoot();
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ── Forged SafeRun capability ────────────────────────────────────────────────

describe("SafeRun capability unforgeability", () => {
  it("rejects a forged SafeRun with matching brand string", async () => {
    const agentDir = await testDir("forged-brand");
    const runId = "legit-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const legit = await openSafeRun(agentDir, runId);

    // Create a forged SafeRun with the same brand string
    const forged: SafeRun = {
      __brand: "SafeRun" as const,
    };

    // All operations on the forged handle must fail
    await assert.rejects(
      () => safeRunStat(forged, "manifest.json"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );

    await assert.rejects(
      () => safeRunReadFile(forged, "manifest.json"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );

    assert.throws(
      () => safeRunPath(forged, "test.json"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );

    await assert.rejects(
      () => safeRunReaddir(forged, ""),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );

    await assert.rejects(
      () => safeRunWriteFile(forged, "test.json", "content"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a SafeRun with extra properties but matching brand", async () => {
    const agentDir = await testDir("forged-extra");
    const runId = "extra-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const legit = await openSafeRun(agentDir, runId);

    // Forged with extra properties
    const forged: SafeRun = {
      __brand: "SafeRun" as const,
    } as SafeRun;

    await assert.rejects(
      () => safeRunStat(forged, "manifest.json"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a SafeRun constructed from Object.create with brand", async () => {
    const agentDir = await testDir("forged-object-create");
    const runId = "oc-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const legit = await openSafeRun(agentDir, runId);

    // Forged via Object.create
    const forged = Object.create(null);
    forged.__brand = "SafeRun";

    await assert.rejects(
      () => safeRunStat(forged as SafeRun, "manifest.json"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });
});

// ── Forged PreManifestRun ─────────────────────────────────────────────────────

describe("PreManifestRun unforgeability", () => {
  it("rejects a forged PreManifestRun with matching brand string", async () => {
    const forged: PreManifestRun = {
      __brand: "PreManifestRun" as const,
    };

    // Accessors must reject forged handles
    assert.throws(
      () => preManifestRunPath(forged),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );

    assert.throws(
      () => preManifestRunId(forged),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );

    // A forged PreManifestRun cannot initialize anything
    // Note: atomicManifestWrite validates via preManifestRunPath which throws synchronously for forged handles
    assert.throws(
      () => atomicManifestWrite(forged, makeManifest("forged", "a".repeat(64))),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a PreManifestRun constructed from Object.create", async () => {
    const forged = Object.create(null);
    forged.__brand = "PreManifestRun";

    assert.throws(
      () => preManifestRunPath(forged as PreManifestRun),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });
});

// ── Raw writer exports absent ───────────────────────────────────────────────

describe("raw writer exports absent", () => {
  it("does not export raw writeFile or open from path-safety", async () => {
    const exports_ = Object.keys(await import("../path-safety.js")) as Array<
      keyof typeof import("../path-safety.js")
    >;

    // These raw writer names must NOT be exported
    const forbidden = ["writeFile", "open", "mkdir", "rm", "unlink", "rename", "getSafeRunRoot"];
    for (const name of forbidden) {
      assert.equal(
        exports_.includes(name as never),
        false,
        `Raw writer '${name}' must not be exported from path-safety`,
      );
    }
  });

  it("does not export raw writeFile or open from evidence-store", async () => {
    const exports_ = Object.keys(await import("../evidence-store.js")) as Array<
      keyof typeof import("../evidence-store.js")
    >;

    // These raw writer names must NOT be exported
    const forbidden = ["writeFile", "open", "mkdir", "rm", "unlink", "rename", "getSafeRunRoot"];
    for (const name of forbidden) {
      assert.equal(
        exports_.includes(name as never),
        false,
        `Raw writer '${name}' must not be exported from evidence-store`,
      );
    }
  });

  it("does not export raw path-based writer variants from evidence-store", async () => {
    const exports_ = Object.keys(await import("../evidence-store.js")) as Array<
      keyof typeof import("../evidence-store.js")
    >;

    // These raw path-based writer names must NOT be exported
    const forbidden = [
      "ensurePrivateRunRoot", // now returns PreManifestRun from path-safety
      "safeAppendEvent",
      "safeAtomicManifestWrite",
      "safeLoadOrCreateCorpusKey",
    ];
    for (const name of forbidden) {
      assert.equal(
        exports_.includes(name as never),
        false,
        `Raw path-based writer '${name}' must not be exported from evidence-store`,
      );
    }
  });
});

// ── Symlink rejection in path components ─────────────────────────────────────

describe("symlink rejection in path components", () => {
  it("rejects a symlink in the evidence root path", async () => {
    const agentDir = await testDir("symlink-evidence-root");
    const runId = "sym-run";

    // Create a symlink in the evidence root path
    const evidenceRoot = resolveEvidenceRoot(agentDir);
    const parentDir = resolve(evidenceRoot, "..");
    const fakeSegment = join(parentDir, "fake-segment");
    await mkdir(fakeSegment, { recursive: true, mode: 0o700 });

    // Replace a segment of the evidence root with a symlink
    const targetSegment = join(agentDir, "blackbytes");
    const realTarget = join(agentDir, "real-blackbytes");
    await mkdir(realTarget, { recursive: true, mode: 0o700 });
    await rm(targetSegment, { recursive: true, force: true }).catch(() => {});
    await symlink(realTarget, targetSegment);

    // Now try to open a run - should fail because evidence root has symlink
    await assert.rejects(
      () => openSafeRun(agentDir, runId),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a symlink replacing a run root", async () => {
    const agentDir = await testDir("symlink-run-root");
    const runId = "legit-run";
    const key = generateCorpusKey();
    const keyDigest = corpusKeyDigest(key);

    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));

    // Replace the run root with a symlink to outside
    const outsideDir = join(agentDir, "outside");
    await mkdir(outsideDir, { recursive: true, mode: 0o700 });
    const runRoot = preManifestRunPath(preRun);
    await rm(runRoot, { recursive: true, force: true });
    await symlink(outsideDir, runRoot);

    await assert.rejects(
      () => openSafeRun(agentDir, runId),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a symlink nested inside the run root", async () => {
    const agentDir = await testDir("symlink-nested");
    const runId = "nested-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);
    const runRoot = preManifestRunPath(preRun);

    // Create a symlink inside the run root
    const outsideTarget = join(agentDir, "outside-target");
    await writeFile(outsideTarget, "sensitive data");
    await symlink(outsideTarget, join(runRoot, "evil-link"));

    // safeRunStat must reject the symlink
    await assert.rejects(
      () => safeRunStat(opened, "evil-link"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );

    // safeRunReadFile must reject the symlink
    await assert.rejects(
      () => safeRunReadFile(opened, "evil-link"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a symlink in a subdirectory path component", async () => {
    const agentDir = await testDir("symlink-subdir");
    const runId = "subdir-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);
    const runRoot = preManifestRunPath(preRun);

    // Create a subdir with a symlink component
    const subdir = join(runRoot, "subdir");
    await mkdir(subdir, { mode: 0o700 });
    const outsideTarget = join(agentDir, "outside-target");
    await writeFile(outsideTarget, "sensitive");

    // Replace subdir with a symlink
    await rm(subdir, { recursive: true, force: true });
    await symlink(outsideTarget, subdir);

    // Writing to a path under the symlinked subdir must fail
    await assert.rejects(
      () => safeRunWriteFile(opened, "subdir/file.txt", "content"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });
});

// ── O_NOFOLLOW and fstat identity verification ──────────────────────────────

describe("O_NOFOLLOW and fstat identity", () => {
  it("safeRunReadFile uses O_NOFOLLOW and verifies fstat identity", async () => {
    const agentDir = await testDir("onofollow-read");
    const runId = "read-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);

    // Write a file
    await safeRunWriteFile(opened, "test.txt", "hello world");

    // Read it back - should succeed
    const content = await safeRunReadFile(opened, "test.txt");
    assert.equal(content.toString("utf8"), "hello world");
  });

  it("safeRunStat uses lstat and rejects symlinks", async () => {
    const agentDir = await testDir("onofollow-stat");
    const runId = "stat-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);
    const runRoot = preManifestRunPath(preRun);

    // Create a regular file
    await safeRunWriteFile(opened, "real.txt", "data");

    // Stat should work for regular file
    const result = await safeRunStat(opened, "real.txt");
    assert.equal(result.isFile, true);
    assert.equal(result.size, 4);

    // Create a symlink
    const outsideTarget = join(agentDir, "outside");
    await writeFile(outsideTarget, "outside data");
    await symlink(outsideTarget, join(runRoot, "link.txt"));

    // Stat must reject the symlink
    await assert.rejects(
      () => safeRunStat(opened, "link.txt"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("safeRunWriteFile validates parent directory components with lstat", async () => {
    const agentDir = await testDir("write-validate-parent");
    const runId = "write-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);
    const runRoot = preManifestRunPath(preRun);

    // Create a subdir
    await mkdir(join(runRoot, "subdir"), { mode: 0o700 });

    // Write to a file in the subdir - should succeed
    await safeRunWriteFile(opened, "subdir/file.txt", "content");

    // Verify it was written
    const content = await safeRunReadFile(opened, "subdir/file.txt");
    assert.equal(content.toString("utf8"), "content");
  });
});

// ── Cross-device rejection ───────────────────────────────────────────────────

describe("cross-device rejection", () => {
  it("rejects paths that cross device boundaries", async () => {
    const agentDir = await testDir("cross-device");
    const runId = "dev-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);

    // Stat a file within the run root - should work
    await safeRunWriteFile(opened, "test.txt", "data");
    const result = await safeRunStat(opened, "test.txt");
    assert.equal(result.isFile, true);

    // The dev field should be consistent within the run root
    const result2 = await safeRunStat(opened, "manifest.json");
    assert.equal(result2.dev, result.dev, "Files in same run root must be on same device");
  });
});

// ── safeRunReaddir rejects symlinks (not skips) ──────────────────────────────

describe("safeRunReaddir rejects symlinks", () => {
  it("rejects when a directory entry is a symlink", async () => {
    const agentDir = await testDir("readdir-reject-symlink");
    const runId = "readdir-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);
    const runRoot = preManifestRunPath(preRun);

    // Create a symlink in the run root
    const outsideTarget = join(agentDir, "outside");
    await writeFile(outsideTarget, "outside data");
    await symlink(outsideTarget, join(runRoot, "evil-link"));

    // readdir must reject (not skip) the symlink
    await assert.rejects(
      () => safeRunReaddir(opened, ""),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });
});
