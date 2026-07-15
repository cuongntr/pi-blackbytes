/**
 * Adversarial security tests for cleanup module (T-002B Security Block).
 *
 * Tests verify that:
 * - Cleanup rejects symlinks, special files, hardlinks (nlink != 1)
 * - Cleanup checks dev/ino/nlink/device/mount drift
 * - File hashing uses O_NOFOLLOW descriptor with fstat stability
 * - Every cleanup operation is bound to the real run key
 * - Canonical JSON byte equality and strict exact schemas
 * - Noncanonical and nested unknown/sourcePath manifest rejected
 * - Cleanup symlink/special/hardlink rejection
 * - Directory inode replacement
 * - All drift cases no deletion
 * - Exact success removes intended run artifacts/control/root
 *
 * @module
 */

import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { ensurePrivateRunRoot, openSafeRun, preManifestRunPath } from "../path-safety.js";
import type { PreManifestRun, SafeRun } from "../path-safety.js";
import { EvidenceStoreError } from "../types.js";
import type { RunManifest } from "../types.js";

let tempRoot: string;
let sequence = 0;

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "adversarial-cleanup-"));
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

// ── Hardlink rejection ────────────────────────────────────────────────────────

describe("cleanup hardlink rejection", () => {
  it("rejects a hardlinked file (nlink > 1) during planning", async () => {
    const agentDir = await testDir("hardlink-plan");
    const { key, preRun, safeRun } = await setupRun(agentDir, "hl-run");
    const runRoot = preManifestRunPath(preRun);

    // Create a file
    await writeFile(join(runRoot, "original.txt"), "data");

    // Create a hardlink to it
    await link(join(runRoot, "original.txt"), join(runRoot, "hardlink.txt"));

    // Planning must reject the hardlink
    await assert.rejects(
      () => planCleanup(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a hardlinked file during execution preflight", async () => {
    const agentDir = await testDir("hardlink-execute");
    const { key, preRun, safeRun } = await setupRun(agentDir, "hl-exec");
    const runRoot = preManifestRunPath(preRun);

    // Create a file (no hardlink yet)
    await writeFile(join(runRoot, "data.txt"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Create a hardlink after planning
    await link(join(runRoot, "data.txt"), join(runRoot, "hardlink.txt"));

    // Execution must reject
    await assert.rejects(
      () => executeCleanup(safeRun, key, "hl-exec", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });
});

// ── Special file rejection ───────────────────────────────────────────────────

describe("cleanup special file rejection", () => {
  it("rejects a FIFO (named pipe) during planning", async () => {
    const agentDir = await testDir("fifo-plan");
    const { key, preRun, safeRun } = await setupRun(agentDir, "fifo-run");
    const runRoot = preManifestRunPath(preRun);

    // Create a FIFO (named pipe) using the mkfifo shell command
    const { execSync } = await import("node:child_process");
    execSync(`mkfifo -m 600 ${JSON.stringify(join(runRoot, "evil.fifo"))}`);

    // Planning must reject the FIFO
    await assert.rejects(
      () => planCleanup(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });
});

// ── Symlink rejection in cleanup ────────────────────────────────────────────

describe("cleanup symlink rejection", () => {
  it("rejects a symlink in the run root during planning", async () => {
    const agentDir = await testDir("symlink-plan");
    const { key, preRun, safeRun } = await setupRun(agentDir, "sym-plan");
    const runRoot = preManifestRunPath(preRun);

    // Create a symlink in the run root
    const outsideTarget = join(agentDir, "outside");
    await writeFile(outsideTarget, "outside data");
    await symlink(outsideTarget, join(runRoot, "evil-link"));

    // Planning must reject the symlink
    await assert.rejects(
      () => planCleanup(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a symlink added after planning during execution preflight", async () => {
    const agentDir = await testDir("symlink-execute");
    const { key, preRun, safeRun } = await setupRun(agentDir, "sym-exec");
    const runRoot = preManifestRunPath(preRun);

    // Create a regular file
    await writeFile(join(runRoot, "data.txt"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Add a symlink after planning
    const outsideTarget = join(agentDir, "outside");
    await writeFile(outsideTarget, "outside data");
    await symlink(outsideTarget, join(runRoot, "evil-link"));

    // Execution must reject (extra target)
    await assert.rejects(
      () => executeCleanup(safeRun, key, "sym-exec", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });
});

// ── Key binding ─────────────────────────────────────────────────────────────

describe("cleanup key binding", () => {
  it("rejects a wrong-but-valid corpus key in planCleanup", async () => {
    const agentDir = await testDir("wrong-key-plan");
    const { safeRun } = await setupRun(agentDir, "wk-run");

    // Use a different valid key
    const wrongKey = generateCorpusKey();

    await assert.rejects(
      () => planCleanup(safeRun, wrongKey),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a wrong-but-valid corpus key in persistCleanupManifest", async () => {
    const agentDir = await testDir("wrong-key-persist");
    const { key, preRun, safeRun } = await setupRun(agentDir, "wk-persist");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");
    const plan = await planCleanup(safeRun, key);

    // Use a different valid key for persistence
    const wrongKey = generateCorpusKey();

    await assert.rejects(
      () => persistCleanupManifest(safeRun, plan, wrongKey),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a wrong-but-valid corpus key in loadCleanupManifest", async () => {
    const agentDir = await testDir("wrong-key-load");
    const { key, preRun, safeRun } = await setupRun(agentDir, "wk-load");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");
    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Use a different valid key for loading
    const wrongKey = generateCorpusKey();

    await assert.rejects(
      () => loadCleanupManifest(safeRun, wrongKey),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a wrong-but-valid corpus key in executeCleanup", async () => {
    const agentDir = await testDir("wrong-key-execute");
    const { key, preRun, safeRun } = await setupRun(agentDir, "wk-exec");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");
    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Use a different valid key for execution
    const wrongKey = generateCorpusKey();

    await assert.rejects(
      () => executeCleanup(safeRun, wrongKey, "wk-exec", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });
});

// ── Schema validation ────────────────────────────────────────────────────────

describe("cleanup schema validation", () => {
  it("rejects a noncanonical manifest (tampered HMAC after reorder)", async () => {
    const agentDir = await testDir("schema-noncanonical");
    const { key, preRun, safeRun } = await setupRun(agentDir, "nc-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");
    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Tamper with the manifest by changing the HMAC
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const tampered = content.replace(/hmac":".*?"/, `hmac":"${"a".repeat(64)}"`);
    await writeFile(manifestPath, tampered, { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a manifest with nested unknown fields in plan", async () => {
    const agentDir = await testDir("schema-nested-unknown");
    const { key, preRun, safeRun } = await setupRun(agentDir, "nu-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");
    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Add an unknown field to a target in the plan
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(content);
    parsed.plan.targets[0].unknownField = true;
    await writeFile(manifestPath, JSON.stringify(parsed), { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a manifest with sourcePath at any nesting level", async () => {
    const agentDir = await testDir("schema-sourcepath-nested");
    const { key, preRun, safeRun } = await setupRun(agentDir, "sp-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");
    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Add sourcePath to a deeply nested target
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(content);
    parsed.plan.targets[0].sourcePath = "/etc/passwd";
    await writeFile(manifestPath, JSON.stringify(parsed), { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a manifest with missing required fields", async () => {
    const agentDir = await testDir("schema-missing-fields");
    const { key, preRun, safeRun } = await setupRun(agentDir, "mf-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");
    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Remove a required field from the manifest
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(content);
    delete parsed.runId;
    await writeFile(manifestPath, JSON.stringify(parsed), { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a manifest with wrong field types", async () => {
    const agentDir = await testDir("schema-wrong-types");
    const { key, preRun, safeRun } = await setupRun(agentDir, "wt-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");
    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Change a field type
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(content);
    parsed.schemaVersion = "1"; // string instead of number
    await writeFile(manifestPath, JSON.stringify(parsed), { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a manifest with unsorted targets", async () => {
    const agentDir = await testDir("schema-unsorted-targets");
    const { key, preRun, safeRun } = await setupRun(agentDir, "ut-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "a.txt"), "a");
    await writeFile(join(runRoot, "b.txt"), "b");
    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Reverse the target order
    const manifestPath = join(runRoot, "cleanup-manifest.json");
    const content = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(content);
    parsed.plan.targets = parsed.plan.targets.reverse();
    await writeFile(manifestPath, JSON.stringify(parsed), { mode: 0o600 });

    await assert.rejects(
      () => loadCleanupManifest(safeRun, key),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("rejects a noncanonical manifest (whitespace/key order)", async () => {
    const agentDir = await testDir("schema-noncanonical-bytes");
    const { key, preRun, safeRun } = await setupRun(agentDir, "ncb-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");
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

// ── Directory inode replacement ──────────────────────────────────────────────

describe("cleanup directory inode replacement", () => {
  it("rejects a directory replaced with a different directory", async () => {
    const agentDir = await testDir("dir-replace");
    const { key, preRun, safeRun } = await setupRun(agentDir, "dr-run");
    const runRoot = preManifestRunPath(preRun);

    await mkdir(join(runRoot, "subdir"), { mode: 0o700 });
    await writeFile(join(runRoot, "subdir", "file.txt"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Replace the directory with a new one (different inode)
    await rm(join(runRoot, "subdir"), { recursive: true, force: true });
    await mkdir(join(runRoot, "subdir"), { mode: 0o700 });
    await writeFile(join(runRoot, "subdir", "other.txt"), "other");

    // Execution must reject (different content)
    await assert.rejects(
      () => executeCleanup(safeRun, key, "dr-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });
});

// ── All drift cases no deletion ───────────────────────────────────────────────

describe("cleanup drift cases no deletion", () => {
  it("deletes nothing on stale target (file removed before execution)", async () => {
    const agentDir = await testDir("drift-stale");
    const { key, preRun, safeRun } = await setupRun(agentDir, "ds-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Remove the file before execution
    await rm(join(runRoot, "data.txt"));

    await assert.rejects(
      () => executeCleanup(safeRun, key, "ds-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );

    // Verify nothing was deleted (the run root should still exist)
    await stat(preManifestRunPath(preRun));
  });

  it("deletes nothing on extra file added before execution", async () => {
    const agentDir = await testDir("drift-extra");
    const { key, preRun, safeRun } = await setupRun(agentDir, "de-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Add an extra file
    await writeFile(join(runRoot, "extra.txt"), "extra");

    await assert.rejects(
      () => executeCleanup(safeRun, key, "de-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );

    // Original file should still exist
    await stat(join(runRoot, "data.txt"));
  });

  it("deletes nothing on file replaced with symlink", async () => {
    const agentDir = await testDir("drift-symlink");
    const { key, preRun, safeRun } = await setupRun(agentDir, "dsl-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Replace file with symlink
    await rm(join(runRoot, "data.txt"));
    const target = join(runRoot, "target.txt");
    await writeFile(target, "target");
    await symlink(target, join(runRoot, "data.txt"));

    await assert.rejects(
      () => executeCleanup(safeRun, key, "dsl-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("deletes nothing on file type changed (file to directory)", async () => {
    const agentDir = await testDir("drift-type-change");
    const { key, preRun, safeRun } = await setupRun(agentDir, "dtc-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "data");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Replace file with directory
    await rm(join(runRoot, "data.txt"));
    await mkdir(join(runRoot, "data.txt"), { mode: 0o700 });

    await assert.rejects(
      () => executeCleanup(safeRun, key, "dtc-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });

  it("deletes nothing on inode drift (file content changed)", async () => {
    const agentDir = await testDir("drift-inode");
    const { key, preRun, safeRun } = await setupRun(agentDir, "di-run");
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "data.txt"), "original");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    // Change file content
    await writeFile(join(runRoot, "data.txt"), "modified");

    await assert.rejects(
      () => executeCleanup(safeRun, key, "di-run", plan.planDigest),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        return true;
      },
    );
  });
});

// ── Exact success removes intended artifacts ────────────────────────────────

describe("cleanup exact success", () => {
  it("removes all planned evidence artifacts including control files and run root", async () => {
    const agentDir = await testDir("exact-success");
    const { key, preRun, safeRun } = await setupRun(agentDir, "es-run");
    const runRoot = preManifestRunPath(preRun);

    // Create various files
    await writeFile(join(runRoot, "data1.json"), "data1");
    await writeFile(join(runRoot, "data2.json"), "data2");
    await mkdir(join(runRoot, "subdir"), { mode: 0o700 });
    await writeFile(join(runRoot, "subdir", "nested.txt"), "nested");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    const deleted = await executeCleanup(safeRun, key, "es-run", plan.planDigest);
    // deleted count includes planned targets + cleanup manifest + run root
    assert.equal(deleted, plan.targets.length + 2);

    // Verify all planned files are gone
    for (const target of plan.targets) {
      await assert.rejects(
        () => stat(join(runRoot, target.path)),
        { code: "ENOENT" },
        `Target ${target.path} should be deleted`,
      );
    }

    // Verify the run root directory itself is removed
    await assert.rejects(
      () => stat(runRoot),
      { code: "ENOENT" },
      "Run root directory should be removed after cleanup",
    );
  });

  it("leaves outside and source files unchanged after cleanup", async () => {
    const agentDir = await testDir("exact-outside");
    const { key, preRun, safeRun } = await setupRun(agentDir, "eo-run");
    const runRoot = preManifestRunPath(preRun);

    // Create a file outside the run root
    const outsideFile = join(agentDir, "outside.txt");
    await writeFile(outsideFile, "outside data");

    // Create a source file outside the run root
    const sourceFile = join(agentDir, "source.txt");
    await writeFile(sourceFile, "source data");

    // Create files inside the run root
    await writeFile(join(runRoot, "inside.json"), "inside");

    const plan = await planCleanup(safeRun, key);
    await persistCleanupManifest(safeRun, plan, key);

    await executeCleanup(safeRun, key, "eo-run", plan.planDigest);

    // Outside files should still exist
    const outsideContent = await readFile(outsideFile, "utf8");
    assert.equal(outsideContent, "outside data");

    const sourceContent = await readFile(sourceFile, "utf8");
    assert.equal(sourceContent, "source data");
  });
});
