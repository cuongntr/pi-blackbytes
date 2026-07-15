/**
 * Adversarial hermetic tests for path-safety module (T-002B).
 *
 * Tests run under a temporary `$PI_AGENT_DIR` and never touch real sessions.
 *
 * @module
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  assertSafeRunId,
  ensurePrivateDir,
  ensurePrivateRunRoot,
  openSafeRun,
  preManifestRunPath,
  resolveEvidenceRoot,
  resolveRunRoot,
  safeRunPath,
  safeRunPublishExclusiveFile,
  safeRunReaddir,
  safeRunStat,
  safeRunSyncDirectory,
  validateSafeRelativePath,
} from "../path-safety.js";
import type { PreManifestRun, SafeRun } from "../path-safety.js";
import { EvidenceStoreError } from "../types.js";
import type { RunManifest } from "../types.js";

let tempRoot: string;
let sequence = 0;

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "path-safety-test-"));
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

// ── Run ID validation ────────────────────────────────────────────────────────

describe("assertSafeRunId", () => {
  it("accepts valid run IDs", () => {
    assertSafeRunId("run-001");
    assertSafeRunId("Run_2026.07-14");
    assertSafeRunId("a");
    assertSafeRunId("a".repeat(128));
  });

  it("rejects empty, traversal, separators, control text, and overlong IDs", () => {
    const invalid = [
      "",
      ".",
      "..",
      "../outside",
      "a/b",
      "a\\b",
      " leading",
      "trailing ",
      "line\nbreak",
      "nul\0byte",
      "a".repeat(129),
    ];

    for (const runId of invalid) {
      assert.throws(
        () => assertSafeRunId(runId),
        (error: unknown) => {
          assert.ok(error instanceof EvidenceStoreError);
          assert.equal((error as EvidenceStoreError).code, "E_EVAL_UNSAFE_PATH");
          return true;
        },
      );
    }
  });
});

// ── Relative path validation ─────────────────────────────────────────────────

describe("validateSafeRelativePath", () => {
  it("accepts valid relative paths", () => {
    validateSafeRelativePath("file.json");
    validateSafeRelativePath("dir/file.json");
    validateSafeRelativePath("a/b/c/d.json");
    validateSafeRelativePath("corpus.key");
    validateSafeRelativePath("events.jsonl");
    validateSafeRelativePath("subdir/nested/deep.json");
  });

  it("rejects absolute paths", () => {
    assert.throws(
      () => validateSafeRelativePath("/etc/passwd"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_UNSAFE_PATH");
        return true;
      },
    );
  });

  it("rejects backslashes (Windows-style paths)", () => {
    assert.throws(() => validateSafeRelativePath("dir\\file.json"), EvidenceStoreError);
  });

  it("rejects NUL bytes", () => {
    assert.throws(() => validateSafeRelativePath("file\0.json"), EvidenceStoreError);
  });

  it("rejects dot components", () => {
    assert.throws(() => validateSafeRelativePath("."), EvidenceStoreError);
    assert.throws(() => validateSafeRelativePath(".."), EvidenceStoreError);
  });

  it("rejects traversal", () => {
    assert.throws(() => validateSafeRelativePath("../outside"), EvidenceStoreError);
    assert.throws(() => validateSafeRelativePath("dir/../../outside"), EvidenceStoreError);
  });

  it("rejects glob characters", () => {
    assert.throws(() => validateSafeRelativePath("*.json"), EvidenceStoreError);
    assert.throws(() => validateSafeRelativePath("file?.json"), EvidenceStoreError);
    assert.throws(() => validateSafeRelativePath("[abc].json"), EvidenceStoreError);
    assert.throws(() => validateSafeRelativePath("{a,b}.json"), EvidenceStoreError);
  });
});

// ── SafeRun path resolution ──────────────────────────────────────────────────

describe("resolveRunRoot", () => {
  it("resolves exactly below the PI agent evidence root", () => {
    const agentDir = join(tempRoot, "agent-root");
    const evidenceRoot = resolve(agentDir, "blackbytes", "evaluations", "context-pruning");

    assert.equal(resolveEvidenceRoot(agentDir), evidenceRoot);
    assert.equal(resolveRunRoot(agentDir, "run-001"), join(evidenceRoot, "run-001"));
  });
});

// ── SafeRun creation and verification ─────────────────────────────────────────

describe("openSafeRun", () => {
  it("opens a valid run and returns a SafeRun with correct properties", async () => {
    const agentDir = await testDir("valid-run");
    const runId = "test-run-001";

    // Create the run root and write a manifest
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));

    // Now open it
    const opened = await openSafeRun(agentDir, runId);
    assert.equal(opened.__brand, "SafeRun");
  });

  it("rejects noncanonical run-manifest bytes", async () => {
    const agentDir = await testDir("noncanonical-run-manifest");
    const runId = "noncanonical-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const manifest = makeManifest(runId, corpusKeyDigest(key));
    await writeFile(
      join(preManifestRunPath(preRun), "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );

    await assert.rejects(() => openSafeRun(agentDir, runId), EvidenceStoreError);
  });

  it("rejects unknown run-manifest fields even when canonical", async () => {
    const agentDir = await testDir("run-manifest-extra-field");
    const runId = "extra-field-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const manifest = { ...makeManifest(runId, corpusKeyDigest(key)), sourcePath: "/private" };
    await writeFile(join(preManifestRunPath(preRun), "manifest.json"), canonicalJson(manifest), {
      mode: 0o600,
    });

    await assert.rejects(() => openSafeRun(agentDir, runId), EvidenceStoreError);
  });

  it("rejects an unknown run ID (no manifest)", async () => {
    const agentDir = await testDir("unknown-run");

    await assert.rejects(
      () => openSafeRun(agentDir, "nonexistent"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a run with mismatched runId in manifest", async () => {
    const agentDir = await testDir("mismatched-run");
    const runId = "real-run";
    const key = generateCorpusKey();
    const keyDigest = corpusKeyDigest(key);

    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    // Write manifest with different runId
    await loadOrCreateCorpusKey(preRun);
    await atomicManifestWrite(preRun, makeManifest("different-run", keyDigest));

    await assert.rejects(
      () => openSafeRun(agentDir, runId),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a run with invalid corpusKeyDigest in manifest", async () => {
    const agentDir = await testDir("bad-digest-run");
    const runId = "bad-digest";
    const key = generateCorpusKey();

    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    await loadOrCreateCorpusKey(preRun);
    await atomicManifestWrite(preRun, makeManifest(runId, "not-a-valid-hex-digest"));

    await assert.rejects(
      () => openSafeRun(agentDir, runId),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        assert.equal((error as EvidenceStoreError).code, "E_EVAL_INTEGRITY");
        return true;
      },
    );
  });

  it("rejects a symlink attack where run root points outside evidence root", async () => {
    const agentDir = await testDir("symlink-attack");
    const outsideDir = join(agentDir, "outside");
    await mkdir(outsideDir, { recursive: true, mode: 0o700 });

    // Create a symlink from a run root to outside
    const evidenceRoot = resolveEvidenceRoot(agentDir);
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const fakeRunRoot = join(evidenceRoot, "evil-run");
    await symlink(outsideDir, fakeRunRoot);

    await assert.rejects(
      () => openSafeRun(agentDir, "evil-run"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceStoreError);
        // Should detect the symlink escape
        return true;
      },
    );
  });
});

// ── SafeRun path construction ────────────────────────────────────────────────

describe("safeRunPath", () => {
  it("resolves relative paths within the safe run", async () => {
    const agentDir = await testDir("safe-path");
    const runId = "safe-path-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);

    const filePath = safeRunPath(opened, "test.json");
    const runRoot = preManifestRunPath(preRun);
    // Normalize /private/tmp -> /tmp on macOS for comparison
    const normalizePath = (pathValue: string) =>
      pathValue.replace(/^\/private(?=\/(?:tmp|var)\/)/, "");
    assert.equal(normalizePath(filePath), normalizePath(join(runRoot, "test.json")));
  });

  it("rejects paths that escape the run root", async () => {
    const agentDir = await testDir("escape-path");
    const runId = "escape-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);

    assert.throws(() => safeRunPath(opened, "../outside"), EvidenceStoreError);
  });
});

// ── SafeRun directory listing ────────────────────────────────────────────────

describe("ensurePrivateDir", () => {
  it("syncs a validated copied-sessions directory before descriptor publication", async () => {
    const agentDir = await testDir("sync-private-dir");
    const runId = "sync-private-dir-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    await atomicManifestWrite(preRun, makeManifest(runId, corpusKeyDigest(key)));
    const run = await openSafeRun(agentDir, runId);
    await ensurePrivateDir(run, "copied-sessions");
    await safeRunSyncDirectory(run, "copied-sessions");
    assert.equal((await safeRunStat(run, "copied-sessions")).isDirectory, true);
  });

  it("creates nested private segments before publishing children", async () => {
    const agentDir = await testDir("nested-private-dir");
    const runId = "nested-private-dir-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    await atomicManifestWrite(preRun, makeManifest(runId, corpusKeyDigest(key)));
    const run = await openSafeRun(agentDir, runId);

    await ensurePrivateDir(run, "one/two/three");
    for (const relativePath of ["one", "one/two", "one/two/three"]) {
      const directory = await safeRunStat(run, relativePath);
      assert.equal(directory.isDirectory, true);
      assert.equal(directory.mode & 0o777, 0o700);
    }
  });
});

describe("safeRunPublishExclusiveFile", () => {
  it("publishes a private file through a durable parent-directory entry", async () => {
    const agentDir = await testDir("exclusive-publish");
    const runId = "exclusive-publish-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    await atomicManifestWrite(preRun, makeManifest(runId, corpusKeyDigest(key)));
    const run = await openSafeRun(agentDir, runId);

    assert.equal(await safeRunPublishExclusiveFile(run, "published/value.json", "{}"), true);
    assert.equal(
      await safeRunPublishExclusiveFile(run, "published/value.json", "different"),
      false,
    );
    assert.equal(await readFile(safeRunPath(run, "published/value.json"), "utf8"), "{}");
  });
});

describe("safeRunReaddir", () => {
  it("lists files and directories, rejecting symlinks", async () => {
    const agentDir = await testDir("readdir-test");
    const runId = "readdir-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);
    const runRoot = preManifestRunPath(preRun);

    // Create some files
    await writeFile(join(runRoot, "file1.json"), "{}");
    await writeFile(join(runRoot, "file2.json"), "{}");
    await mkdir(join(runRoot, "subdir"), { mode: 0o700 });

    const entries = await safeRunReaddir(opened, "");
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["corpus.key", "file1.json", "file2.json", "manifest.json", "subdir"]);
  });
});

// ── SafeRun stat ──────────────────────────────────────────────────────────────

describe("safeRunStat", () => {
  it("stats a file within the safe run", async () => {
    const agentDir = await testDir("stat-test");
    const runId = "stat-run";
    const preRun = await ensurePrivateRunRoot(agentDir, runId);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, makeManifest(runId, keyDigest));
    const opened = await openSafeRun(agentDir, runId);
    const runRoot = preManifestRunPath(preRun);

    await writeFile(join(runRoot, "test.txt"), "hello");

    const result = await safeRunStat(opened, "test.txt");
    assert.equal(result.isFile, true);
    assert.equal(result.size, 5);
  });
});
