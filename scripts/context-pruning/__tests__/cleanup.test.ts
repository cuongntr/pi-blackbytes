/**
 * Adversarial hermetic tests for cleanup module (T-002B).
 *
 * Tests run under a temporary `$PI_AGENT_DIR` and never touch real sessions.
 * Verifies dry-run planning, manifest persistence, and safe execution.
 *
 * @module
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  dryRunCleanup,
  executeCleanup,
  loadCleanupManifest,
  persistCleanupManifest,
  planCleanup,
} from "../cleanup.js";
import {
  atomicManifestWrite,
  corpusKeyDigest,
  generateCorpusKey,
  loadOrCreateCorpusKey,
} from "../evidence-store.js";
import {
  ensurePrivateRunRoot,
  getSafeRunCorpusKeyDigest,
  openSafeRun,
  preManifestRunPath,
} from "../path-safety.js";
import type { PreManifestRun, SafeRun } from "../path-safety.js";
import { EvidenceStoreError } from "../types.js";
import type { RunManifest } from "../types.js";

let tempRoot: string;
let sequence = 0;

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cleanup-test-"));
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

// ── Setup helper ─────────────────────────────────────────────────────────────

async function setupRun(
  agentDir: string,
  runId: string,
): Promise<{ key: string; preRun: PreManifestRun; safeRun: SafeRun }> {
  const preRun = await ensurePrivateRunRoot(agentDir, runId);
  const key = await loadOrCreateCorpusKey(preRun);
  const keyDigest = corpusKeyDigest(key);
  await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
  const opened = await openSafeRun(agentDir, runId);
  return { key, preRun, safeRun: opened };
}

// ── Dry-run cleanup ───────────────────────────────────────────────────────────

describe("dryRunCleanup", () => {
  it("produces a plan with relative targets and no deletion", async () => {
    const agentDir = await testDir("dry-run-basic");
    const { key, preRun, safeRun } = await setupRun(agentDir, "dry-run-1");
    const runRoot = preManifestRunPath(preRun);

    // Create some files
    await writeFile(join(runRoot, "file1.json"), "content1");
    await writeFile(join(runRoot, "file2.json"), "content2");
    await mkdir(join(runRoot, "subdir"), { mode: 0o700 });
    await writeFile(join(runRoot, "subdir", "nested.txt"), "nested");

    const plan = await dryRunCleanup(safeRun, key);

    assert.equal(plan.runId, "dry-run-1");
    assert.equal(plan.schemaVersion, 1);
    assert.ok(plan.planDigest.length > 0);
    assert.ok(plan.targets.length >= 3);

    // Verify relative paths
    const paths = plan.targets.map((t) => t.path);
    assert.ok(paths.includes("file1.json"));
    assert.ok(paths.includes("file2.json"));
    assert.ok(paths.includes("subdir/nested.txt"));

    // Verify no source paths in the plan
    for (const target of plan.targets) {
      assert.equal(target.path.startsWith("/"), false);
      assert.equal(target.path.startsWith(".."), false);
      assert.equal(target.path.includes("\\"), false);
    }

    // Verify files still exist (no deletion)
    await stat(join(runRoot, "file1.json"));
    await stat(join(runRoot, "file2.json"));
    await stat(join(runRoot, "subdir", "nested.txt"));
  });

  it("produces a plan with only manifest and corpus key for an empty run root", async () => {
    const agentDir = await testDir("dry-run-empty");
    const { key, safeRun } = await setupRun(agentDir, "empty-run");

    const plan = await dryRunCleanup(safeRun, key);
    // Empty run root still has manifest.json and corpus.key from setup
    assert.ok(plan.targets.length >= 2);
    const paths = plan.targets.map((t) => t.path);
    assert.ok(paths.includes("manifest.json"));
    assert.ok(paths.includes("corpus.key"));
  });
});

// ── Plan cleanup ─────────────────────────────────────────────────────────────

describe("planCleanup", () => {
  it("rejects an invalid corpus key", async () => {
    const agentDir = await testDir("plan-bad-key");
    const { safeRun } = await setupRun(agentDir, "bad-key-run");

    await assert.rejects(
      () => planCleanup(safeRun, "not-a-valid-key"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });
});

// ── Persist and load cleanup manifest ────────────────────────────────────────

describe("cleanup manifest persistence", () => {
  it("persists and loads a valid HMAC-sealed manifest", async () => {
    const agentDir = await testDir("manifest-persist");
    const { key, preRun, safeRun } = await setupRun(agentDir, "manifest-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.json"), "test data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Load it back
    const loaded = await loadCleanupManifest(safeRun, key);
    assert.equal(loaded.runId, "manifest-run");
    assert.equal(loaded.plan.planDigest, plan.planDigest);
    assert.equal(loaded.plan.targets.length, plan.targets.length);
  });

  it("rejects a manifest with wrong runId", async () => {
    const agentDir = await testDir("manifest-wrong-run");
    const { key, preRun, safeRun } = await setupRun(agentDir, "real-run");
    const runRoot = preManifestRunPath(preRun);

    const plan = await planCleanup(safeRun, key);
    // Write the manifest directly with a wrong runId (bypass persist validation)
    const wrongManifest = {
      schemaVersion: 1,
      runId: "wrong-run",
      corpusKeyDigest: getSafeRunCorpusKeyDigest(safeRun),
      plan,
      hmac: "a".repeat(64),
      manifestHmac: "a".repeat(64),
    };
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    await writeFile(manifestPath, JSON.stringify(wrongManifest), { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a manifest with tampered HMAC", async () => {
    const agentDir = await testDir("manifest-tampered-hmac");
    const { key, preRun, safeRun } = await setupRun(agentDir, "hmac-run");
    const runRoot = preManifestRunPath(preRun);

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Tamper with the persisted manifest
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const tampered = content.replace(/hmac":".*?"/, `hmac":"${"a".repeat(64)}"`);
    await writeFile(manifestPath, tampered);

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a manifest with unknown fields", async () => {
    const agentDir = await testDir("manifest-unknown-fields");
    const { key, preRun, safeRun } = await setupRun(agentDir, "unknown-run");
    const runRoot = preManifestRunPath(preRun);

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Tamper with the persisted manifest by adding an extra field
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(content);
    parsed.extraField = true;
    await writeFile(manifestPath, JSON.stringify(parsed), { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a manifest with sourcePath field (structural impossibility)", async () => {
    const agentDir = await testDir("manifest-source-path");
    const { key, preRun, safeRun } = await setupRun(agentDir, "source-path-run");
    const runRoot = preManifestRunPath(preRun);

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Add a sourcePath field to the manifest
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(content);
    parsed.sourcePath = "/etc/passwd";
    await writeFile(manifestPath, JSON.stringify(parsed), { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_SCHEMA");
        return true;
      },
    );
  });

  it("rejects a manifest with duplicate targets", async () => {
    const agentDir = await testDir("manifest-duplicate");
    const { key, preRun, safeRun } = await setupRun(agentDir, "dup-run");
    const runRoot = preManifestRunPath(preRun);

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Tamper to add a duplicate target
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(content);
    // Duplicate the first target
    parsed.plan.targets = [...parsed.plan.targets, parsed.plan.targets[0]];
    await writeFile(manifestPath, JSON.stringify(parsed), { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a noncanonical manifest (whitespace/key order)", async () => {
    const agentDir = await testDir("manifest-noncanonical");
    const { key, preRun, safeRun } = await setupRun(agentDir, "nc-run");
    const runRoot = preManifestRunPath(preRun);

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Read the canonical manifest and re-write with different whitespace
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(content);
    // Re-serialize with pretty-print (noncanonical whitespace)
    const noncanonical = JSON.stringify(parsed, null, 2);
    await writeFile(manifestPath, noncanonical, { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });
});

// ── Cleanup execution ────────────────────────────────────────────────────────

describe("executeCleanup", () => {
  it("deletes exact targets with correct confirmation", async () => {
    const agentDir = await testDir("execute-exact");
    const { key, preRun, safeRun } = await setupRun(agentDir, "exact-run");
    const runRoot = preManifestRunPath(preRun);

    // Create files
    await writeFile(join(runRoot, "file1.json"), "data1");
    await writeFile(join(runRoot, "file2.json"), "data2");
    await mkdir(join(runRoot, "subdir"), { mode: 0o700 });
    await writeFile(join(runRoot, "subdir", "nested.txt"), "nested");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    const deleted = await executeCleanup(safeRun, key, "exact-run", plan.planDigest);
    // deleted count includes planned targets + cleanup manifest + run root
    assert.equal(deleted, plan.targets.length + 2);

    // Verify files are gone
    await assert.rejects(() => stat(join(runRoot, "file1.json")), { code: "ENOENT" });
    await assert.rejects(() => stat(join(runRoot, "file2.json")), { code: "ENOENT" });
    await assert.rejects(() => stat(join(runRoot, "subdir", "nested.txt")), {
      code: "ENOENT",
    });
  });

  it("deletes nothing on wrong run ID confirmation", async () => {
    const agentDir = await testDir("execute-wrong-run");
    const { key, preRun, safeRun } = await setupRun(agentDir, "right-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.json"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    await assert.rejects(
      () => executeCleanup(safeRun, key, "wrong-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );

    // File should still exist
    await stat(join(runRoot, "data.json"));
  });

  it("deletes nothing on wrong plan digest confirmation", async () => {
    const agentDir = await testDir("execute-wrong-digest");
    const { key, preRun, safeRun } = await setupRun(agentDir, "digest-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.json"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    await assert.rejects(
      () => executeCleanup(safeRun, key, "digest-run", "a".repeat(64)),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );

    // File should still exist
    await stat(join(runRoot, "data.json"));
  });

  it("deletes nothing on stale target (file removed before execution)", async () => {
    const agentDir = await testDir("execute-stale");
    const { key, preRun, safeRun } = await setupRun(agentDir, "stale-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.json"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Remove the file before execution
    await rm(join(runRoot, "data.json"));

    await assert.rejects(
      () => executeCleanup(safeRun, key, "stale-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("deletes nothing on extra file added before execution", async () => {
    const agentDir = await testDir("execute-extra");
    const { key, preRun, safeRun } = await setupRun(agentDir, "extra-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.json"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Add an extra file
    await writeFile(join(runRoot, "extra.json"), "extra");

    await assert.rejects(
      () => executeCleanup(safeRun, key, "extra-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );

    // Original file should still exist
    await stat(join(runRoot, "data.json"));
  });

  it("deletes nothing on file replaced with symlink", async () => {
    const agentDir = await testDir("execute-symlink-replace");
    const { key, preRun, safeRun } = await setupRun(agentDir, "symlink-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.json"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Replace file with symlink
    await rm(join(runRoot, "data.json"));
    const target = join(runRoot, "target.json");
    await writeFile(target, "target");
    await symlink(target, join(runRoot, "data.json"));

    await assert.rejects(
      () => executeCleanup(safeRun, key, "symlink-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("deletes nothing on file type changed (file to directory)", async () => {
    const agentDir = await testDir("execute-type-change");
    const { key, preRun, safeRun } = await setupRun(agentDir, "type-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.json"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Replace file with directory
    await rm(join(runRoot, "data.json"));
    await mkdir(join(runRoot, "data.json"), { mode: 0o700 });

    await assert.rejects(
      () => executeCleanup(safeRun, key, "type-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("deletes nothing on inode drift (file content changed)", async () => {
    const agentDir = await testDir("execute-inode-drift");
    const { key, preRun, safeRun } = await setupRun(agentDir, "drift-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.json"), "original");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Change file content (same inode on some systems, but digest will differ)
    await writeFile(join(runRoot, "data.json"), "modified");

    await assert.rejects(
      () => executeCleanup(safeRun, key, "drift-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("leaves outside files unchanged after cleanup", async () => {
    const agentDir = await testDir("execute-outside");
    const { key, preRun, safeRun } = await setupRun(agentDir, "outside-run");
    const runRoot = preManifestRunPath(preRun);

    // Create a file outside the run root
    const outsideFile = join(agentDir, "outside.txt");
    await writeFile(outsideFile, "outside data");

    // Create files inside the run root
    await writeFile(join(runRoot, "inside.json"), "inside");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    await executeCleanup(safeRun, key, "outside-run", plan.planDigest);

    // Outside file should still exist
    const content = await readFile(outsideFile, "utf8");
    assert.equal(content, "outside data");
  });

  it("deletes nothing on case-mismatched run ID confirmation", async () => {
    const agentDir = await testDir("execute-case");
    const { key, preRun, safeRun } = await setupRun(agentDir, "CaseSensitive");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.json"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Wrong case
    await assert.rejects(
      () => executeCleanup(safeRun, key, "casesensitive", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );

    // File should still exist
    await stat(join(runRoot, "data.json"));
  });

  it("deletes nothing on missing confirmation (empty run ID)", async () => {
    const agentDir = await testDir("execute-empty-confirm");
    const { key, preRun, safeRun } = await setupRun(agentDir, "empty-confirm");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.json"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    await assert.rejects(
      () => executeCleanup(safeRun, key, "", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });
});
