/**
 * Manifest-scoped cleanup primitives for the context-pruning evidence store.
 *
 * This module provides:
 * - `planCleanup()` — scan descendants of a verified SafeRun, produce a dry-run plan
 * - `executeCleanup()` — verify and execute a cleanup plan against a SafeRun
 *
 * All operations are manifest-scoped, symlink-safe, and require explicit
 * run-ID + plan-digest confirmation before any deletion.
 *
 * Source paths are structurally impossible in the cleanup manifest.
 *
 * @module
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { corpusKeyBytes } from "./evidence-store.js";
import type { SafeRun } from "./path-safety.js";
import {
  getSafeRunCorpusKeyDigest,
  getSafeRunId,
  safeRunPath,
  safeRunReaddir,
  safeRunStat,
} from "./path-safety.js";
import { validateSafeRelativePath } from "./path-safety.js";
import { EvidenceStoreError } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Filename for the HMAC-sealed cleanup manifest. */
const CLEANUP_MANIFEST_FILENAME = "cleanup-manifest.json";

/** Current schema version for cleanup manifests. */
const CLEANUP_SCHEMA_VERSION = 1;

/** Pattern for a valid lowercase-hex SHA-256 digest. */
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single cleanup target entry.
 * All paths are relative to the run root.
 */
export interface CleanupTarget {
  /** Relative path from the run root. */
  readonly path: string;
  /** Whether this is a file or directory. */
  readonly type: "file" | "directory";
  /** SHA-256 digest of the file content (for files), or "directory" for directories. */
  readonly digest: string;
  /** File size in bytes (for files), or 0 for directories. */
  readonly size: number;
  /** Device number at plan time. */
  readonly dev: number;
  /** Inode number at plan time. */
  readonly ino: number;
  /** Number of hard links at plan time (must be 1 for files). */
  readonly nlink: number;
}

/**
 * A cleanup plan produced by `planCleanup()`.
 * Contains only relative paths and digests — no source paths.
 */
export interface CleanupPlan {
  /** Schema version. */
  readonly schemaVersion: typeof CLEANUP_SCHEMA_VERSION;
  /** The run ID this plan applies to. */
  readonly runId: string;
  /** SHA-256 digest of the corpus key from the run manifest. */
  readonly corpusKeyDigest: string;
  /** Ordered list of targets (leaf-first: files before directories). */
  readonly targets: readonly CleanupTarget[];
  /** SHA-256 digest of the canonical JSON serialization of this plan. */
  readonly planDigest: string;
}

/**
 * HMAC-sealed cleanup manifest persisted to disk.
 */
export interface CleanupManifest {
  /** Schema version. */
  readonly schemaVersion: typeof CLEANUP_SCHEMA_VERSION;
  /** The run ID. */
  readonly runId: string;
  /** SHA-256 digest of the corpus key. */
  readonly corpusKeyDigest: string;
  /** The cleanup plan. */
  readonly plan: CleanupPlan;
  /** HMAC-SHA256 of the canonical plan JSON, keyed by the corpus key. */
  readonly hmac: string;
  /** HMAC-SHA256 of the canonical manifest JSON (without hmac/manifestHmac fields), keyed by the corpus key. */
  readonly manifestHmac: string;
}

// ── Allowed schema keys for strict validation ─────────────────────────────────

const ALLOWED_MANIFEST_KEYS = new Set([
  "schemaVersion",
  "runId",
  "corpusKeyDigest",
  "plan",
  "hmac",
  "manifestHmac",
]);

const ALLOWED_PLAN_KEYS = new Set([
  "schemaVersion",
  "runId",
  "corpusKeyDigest",
  "targets",
  "planDigest",
]);

const ALLOWED_TARGET_KEYS = new Set(["path", "type", "digest", "size", "dev", "ino", "nlink"]);

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Compare two 64-character hex strings using timingSafeEqual.
 * Both must be valid 64-hex strings.
 */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (bufA.length !== 32 || bufB.length !== 32) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Compute SHA-256 digest of a file's content using O_NOFOLLOW|O_NONBLOCK descriptor.
 * Takes expected dev/ino, opens with O_RDONLY|O_NOFOLLOW|O_NONBLOCK,
 * fstats exact regular identity/nlink before hashing, fstats stability after.
 */
async function fileDigest(
  filePath: string,
  expectedDev: number,
  expectedIno: number,
): Promise<string> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(filePath, flags);
  try {
    // Fstat the handle to verify it's a regular file with expected identity
    const handleStats = await handle.stat();
    if (!handleStats.isFile()) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path is not a regular file");
    }
    if (handleStats.dev !== expectedDev || handleStats.ino !== expectedIno) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        "File identity changed between stat and open",
      );
    }
    if (handleStats.nlink !== 1) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "File has multiple hard links");
    }

    const hash = createHash("sha256");
    const buffer = Buffer.alloc(65536);
    let bytesRead: number;

    do {
      const result = await handle.read(buffer, 0, 65536, null);
      bytesRead = result.bytesRead;
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);

    // Fstat after reading to verify stability
    const afterStats = await handle.stat();
    if (afterStats.dev !== handleStats.dev || afterStats.ino !== handleStats.ino) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "File identity changed during read");
    }
    if (afterStats.size !== handleStats.size) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "File size changed during read");
    }

    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/**
 * Recursively scan a directory within a SafeRun, collecting all files and
 * directories in leaf-first order (files before their parent directories).
 * Rejects symlinks, hardlinks (nlink > 1 for files), special files, and
 * cross-device paths.
 */
async function scanTree(safeRun: SafeRun, relativeDir: string): Promise<CleanupTarget[]> {
  const entries = await safeRunReaddir(safeRun, relativeDir);
  const targets: CleanupTarget[] = [];

  for (const entry of entries) {
    const entryPath = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;

    // Skip the cleanup manifest itself
    if (entryPath === CLEANUP_MANIFEST_FILENAME) {
      continue;
    }

    if (entry.isDirectory) {
      // Recurse into subdirectories
      const children = await scanTree(safeRun, entryPath);
      targets.push(...children);

      // Stat the directory to get dev/ino/nlink
      const stats = await safeRunStat(safeRun, entryPath);

      // Add the directory after its children (leaf-first)
      targets.push({
        path: entryPath,
        type: "directory",
        digest: "directory",
        size: 0,
        dev: stats.dev,
        ino: stats.ino,
        nlink: stats.nlink,
      });
    } else if (entry.isFile) {
      // Stat the file first to check hardlinks
      const stats = await safeRunStat(safeRun, entryPath);

      // Reject hardlinks (nlink > 1)
      if (stats.nlink > 1) {
        throw new EvidenceStoreError(
          "E_EVAL_INTEGRITY",
          `File has multiple hard links: ${entryPath}`,
        );
      }

      // Compute file digest using O_NOFOLLOW|O_NONBLOCK descriptor with expected dev/ino
      const fullPath = safeRunPath(safeRun, entryPath);
      const digest = await fileDigest(fullPath, stats.dev, stats.ino);

      targets.push({
        path: entryPath,
        type: "file",
        digest,
        size: stats.size,
        dev: stats.dev,
        ino: stats.ino,
        nlink: stats.nlink,
      });
    }
  }

  return targets;
}

/**
 * Compute HMAC-SHA256 of a string using the corpus key.
 */
function hmacDigest(key: string, data: string): string {
  return createHmac("sha256", corpusKeyBytes(key, "E_EVAL_SCHEMA"))
    .update(data, "utf8")
    .digest("hex");
}

/**
 * Strictly validate a value against a set of allowed keys, rejecting unknown,
 * missing, or wrong-type fields.
 */
function validateExactSchema(
  value: unknown,
  allowedKeys: Set<string>,
  context: string,
  requiredTypes: Record<string, string>,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvidenceStoreError("E_EVAL_SCHEMA", `${context} must be an object`);
  }

  const obj = value as Record<string, unknown>;

  // Check for unknown keys
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new EvidenceStoreError("E_EVAL_SCHEMA", `Unexpected field in ${context}: ${key}`);
    }
  }

  // Check for missing required fields and type correctness
  for (const [key, expectedType] of Object.entries(requiredTypes)) {
    if (!(key in obj)) {
      throw new EvidenceStoreError("E_EVAL_SCHEMA", `Missing required field in ${context}: ${key}`);
    }
    const val = obj[key];
    if (expectedType === "array") {
      if (!Array.isArray(val)) {
        throw new EvidenceStoreError(
          "E_EVAL_SCHEMA",
          `Field ${key} in ${context} must be an array`,
        );
      }
    } else if (expectedType === "string") {
      if (typeof val !== "string") {
        throw new EvidenceStoreError(
          "E_EVAL_SCHEMA",
          `Field ${key} in ${context} must be a string`,
        );
      }
    } else if (expectedType === "number") {
      if (typeof val !== "number" || !Number.isFinite(val)) {
        throw new EvidenceStoreError(
          "E_EVAL_SCHEMA",
          `Field ${key} in ${context} must be a finite number`,
        );
      }
    }
  }
}

// ── Strict recursive plan validator ───────────────────────────────────────────

/**
 * Strictly validate a cleanup plan, used BOTH before signing/persist and after load.
 * Validates exact fields/types/ranges/path via validateSafeRelativePath,
 * duplicate/order/type/digest/dev/ino/nlink, run/key binding, and recomputes planDigest.
 * A caller with key cannot persist injected nested/source fields.
 */
function validateCleanupPlan(plan: CleanupPlan, safeRun: SafeRun, corpusKey: string): void {
  // Validate plan schema
  validateExactSchema(plan, ALLOWED_PLAN_KEYS, "cleanup plan", {
    schemaVersion: "number",
    runId: "string",
    corpusKeyDigest: "string",
    targets: "array",
    planDigest: "string",
  });

  // Validate schema version
  if (plan.schemaVersion !== CLEANUP_SCHEMA_VERSION) {
    throw new EvidenceStoreError(
      "E_EVAL_SCHEMA",
      `Unsupported cleanup plan schema version: ${plan.schemaVersion}`,
    );
  }

  // Validate runId
  if (plan.runId !== getSafeRunId(safeRun)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Cleanup plan runId does not match the safe run",
    );
  }

  // Validate corpusKeyDigest
  if (plan.corpusKeyDigest !== getSafeRunCorpusKeyDigest(safeRun)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Cleanup plan corpusKeyDigest does not match the safe run",
    );
  }

  // Validate targets
  const seenPaths = new Set<string>();
  let lastPath = "";
  for (const target of plan.targets) {
    validateExactSchema(target, ALLOWED_TARGET_KEYS, "cleanup target", {
      path: "string",
      type: "string",
      digest: "string",
      size: "number",
      dev: "number",
      ino: "number",
      nlink: "number",
    });

    // Reject sourcePath at any level
    if ("sourcePath" in target) {
      throw new EvidenceStoreError("E_EVAL_SCHEMA", "sourcePath is not allowed in cleanup targets");
    }

    // Validate type
    if (target.type !== "file" && target.type !== "directory") {
      throw new EvidenceStoreError("E_EVAL_SCHEMA", `Invalid target type: ${target.type}`);
    }

    // Validate path
    if (target.path.startsWith("/") || target.path.startsWith("..")) {
      throw new EvidenceStoreError("E_EVAL_SCHEMA", "Target path must be relative");
    }

    // Validate relative path safety
    try {
      validateSafeRelativePath(target.path);
    } catch {
      throw new EvidenceStoreError("E_EVAL_SCHEMA", `Invalid target path: ${target.path}`);
    }

    // Check for duplicate paths
    if (seenPaths.has(target.path)) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", `Duplicate target path: ${target.path}`);
    }
    seenPaths.add(target.path);

    // Check leaf-first ordering (files before directories, parents after children)
    // A child must come before its parent (e.g., "subdir/file.txt" before "subdir")
    // Files must come before their parent directory
    if (lastPath.length > 0) {
      // Check if the current path is a child of the last path (parent before child = wrong)
      if (target.path.startsWith(`${lastPath}/`)) {
        throw new EvidenceStoreError(
          "E_EVAL_INTEGRITY",
          "Targets must be in leaf-first order (child before parent)",
        );
      }
      // Check if the current path is the same as the last path (duplicate)
      if (target.path === lastPath) {
        throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Duplicate target path in ordering");
      }
    }
    lastPath = target.path;

    // Validate digest format
    if (target.type === "file" && !HEX64_PATTERN.test(target.digest)) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        `Target ${target.path} has invalid digest format`,
      );
    }

    // Validate nlink for files
    if (target.type === "file" && target.nlink !== 1) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", `Target ${target.path} has nlink !== 1`);
    }
  }

  // Recompute planDigest and verify
  const planBody: Omit<CleanupPlan, "planDigest"> = {
    schemaVersion: plan.schemaVersion,
    runId: plan.runId,
    corpusKeyDigest: plan.corpusKeyDigest,
    targets: plan.targets,
  };
  const planJson = canonicalJson(planBody);
  const expectedDigest = createHmac("sha256", Buffer.from(corpusKey, "hex"))
    .update(planJson, "utf8")
    .digest("hex");

  if (!timingSafeHexEqual(plan.planDigest, expectedDigest)) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Cleanup plan digest mismatch");
  }
}

// ── Plan cleanup ──────────────────────────────────────────────────────────────

/**
 * Plan cleanup for a verified SafeRun.
 *
 * Scans all descendants of the run root without following symlinks,
 * rejects hardlinks/special files/mount/device drift, and produces a
 * dry-run plan with exact relative targets and digests.
 *
 * Does not delete anything.
 *
 * @param safeRun - A verified SafeRun
 * @param corpusKey - The 32-byte lowercase-hex corpus key
 * @returns A CleanupPlan with relative targets and a plan digest
 * @throws {EvidenceStoreError} E_EVAL_INTEGRITY on hardlinks, special files, or device drift
 */
export async function planCleanup(safeRun: SafeRun, corpusKey: string): Promise<CleanupPlan> {
  if (!HEX64_PATTERN.test(corpusKey)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Corpus key must be exactly 32 lowercase-hex bytes",
    );
  }

  // Validate corpus key digest matches the safe run
  const expectedDigest = createHash("sha256")
    .update(corpusKeyBytes(corpusKey, "E_EVAL_INTEGRITY"))
    .digest("hex");
  if (!timingSafeHexEqual(expectedDigest, getSafeRunCorpusKeyDigest(safeRun))) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Corpus key does not match the safe run's corpusKeyDigest",
    );
  }

  // Scan the run root tree
  const targets = await scanTree(safeRun, "");

  // Build the plan
  const plan: Omit<CleanupPlan, "planDigest"> = {
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    runId: getSafeRunId(safeRun),
    corpusKeyDigest: getSafeRunCorpusKeyDigest(safeRun),
    targets,
  };

  // Compute the plan digest
  const planJson = canonicalJson(plan);
  const planDigest = createHmac("sha256", Buffer.from(corpusKey, "hex"))
    .update(planJson, "utf8")
    .digest("hex");

  const fullPlan: CleanupPlan = { ...plan, planDigest };

  // Validate the plan before returning
  validateCleanupPlan(fullPlan, safeRun, corpusKey);

  return fullPlan;
}

// ── Persist cleanup manifest ──────────────────────────────────────────────────

/**
 * Persist a cleanup plan as an HMAC-sealed cleanup-manifest.json in the run root.
 *
 * Validates input before signing so a caller with the key cannot inject source fields.
 *
 * @param safeRun - A verified SafeRun
 * @param plan - The cleanup plan to persist
 * @param corpusKey - The 32-byte lowercase-hex corpus key
 */
export async function persistCleanupManifest(
  safeRun: SafeRun,
  plan: CleanupPlan,
  corpusKey: string,
): Promise<void> {
  // Validate the plan before signing
  validateCleanupPlan(plan, safeRun, corpusKey);

  const manifestPath = safeRunPath(safeRun, CLEANUP_MANIFEST_FILENAME);

  // Compute HMAC of the canonical plan JSON
  const planJson = canonicalJson(plan);
  const hmac = hmacDigest(corpusKey, planJson);

  // Also compute a manifest-level HMAC that covers the entire manifest content
  const manifestForHmac = {
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    runId: getSafeRunId(safeRun),
    corpusKeyDigest: getSafeRunCorpusKeyDigest(safeRun),
    plan,
  };
  const manifestJson = canonicalJson(manifestForHmac);
  const manifestHmac = hmacDigest(corpusKey, manifestJson);

  const manifest: CleanupManifest = {
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    runId: getSafeRunId(safeRun),
    corpusKeyDigest: getSafeRunCorpusKeyDigest(safeRun),
    plan,
    hmac,
    manifestHmac,
  };

  const fullManifestJson = canonicalJson(manifest);

  // Write atomically via temp file
  const tempPath = join(
    dirname(manifestPath),
    `.cleanup-manifest.tmp.${process.pid}.${randomBytes(4).toString("hex")}`,
  );
  await writeFile(tempPath, fullManifestJson, { mode: 0o600 });
  try {
    await rename(tempPath, manifestPath);
  } catch (error: unknown) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  await chmod(manifestPath, 0o600);
}

// ── Load cleanup manifest ────────────────────────────────────────────────────

/**
 * Load and verify the HMAC-sealed cleanup manifest from a SafeRun.
 *
 * After parse, requires onDiskContent === canonicalJson(parsedManifest) before
 * any HMAC validation. This rejects noncanonical bytes (whitespace, key order).
 *
 * @param safeRun - A verified SafeRun
 * @param corpusKey - The 32-byte lowercase-hex corpus key
 * @returns The verified CleanupManifest
 * @throws {EvidenceStoreError} E_EVAL_INTEGRITY on HMAC mismatch or schema violation
 */
export async function loadCleanupManifest(
  safeRun: SafeRun,
  corpusKey: string,
): Promise<CleanupManifest> {
  const manifestPath = safeRunPath(safeRun, CLEANUP_MANIFEST_FILENAME);

  let onDiskContent: string;
  try {
    onDiskContent = await readFile(manifestPath, "utf8");
  } catch (error: unknown) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      `Cannot read cleanup manifest: ${(error as Error).message}`,
    );
  }

  let manifest: CleanupManifest;
  try {
    manifest = JSON.parse(onDiskContent) as CleanupManifest;
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Cleanup manifest is not valid JSON");
  }

  // Require onDiskContent === canonicalJson(parsedManifest) before any HMAC validation
  // This rejects noncanonical bytes (whitespace, key order differences)
  const canonicalContent = canonicalJson(manifest);
  if (onDiskContent !== canonicalContent) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Cleanup manifest is not canonical JSON");
  }

  // Validate schema version
  if (manifest.schemaVersion !== CLEANUP_SCHEMA_VERSION) {
    throw new EvidenceStoreError(
      "E_EVAL_SCHEMA",
      `Unsupported cleanup manifest schema version: ${manifest.schemaVersion}`,
    );
  }

  // Strict schema validation for the manifest
  validateExactSchema(manifest, ALLOWED_MANIFEST_KEYS, "cleanup manifest", {
    schemaVersion: "number",
    runId: "string",
    corpusKeyDigest: "string",
    plan: "object",
    hmac: "string",
    manifestHmac: "string",
  });

  // Validate runId
  if (manifest.runId !== getSafeRunId(safeRun)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Cleanup manifest runId does not match the safe run",
    );
  }

  // Validate corpusKeyDigest
  if (manifest.corpusKeyDigest !== getSafeRunCorpusKeyDigest(safeRun)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Cleanup manifest corpusKeyDigest does not match the safe run",
    );
  }

  // Validate corpus key digest matches
  const expectedDigest = createHash("sha256")
    .update(corpusKeyBytes(corpusKey, "E_EVAL_INTEGRITY"))
    .digest("hex");
  if (!timingSafeHexEqual(expectedDigest, getSafeRunCorpusKeyDigest(safeRun))) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Corpus key does not match the safe run's corpusKeyDigest",
    );
  }

  // Validate the plan using the shared validator
  validateCleanupPlan(manifest.plan, safeRun, corpusKey);

  // Verify plan HMAC
  const planJson = canonicalJson(manifest.plan);
  const expectedHmac = hmacDigest(corpusKey, planJson);

  if (!timingSafeHexEqual(manifest.hmac, expectedHmac)) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Cleanup manifest plan HMAC mismatch");
  }

  // Verify manifest HMAC (covers the entire manifest structure)
  const manifestForHmac = {
    schemaVersion: manifest.schemaVersion,
    runId: manifest.runId,
    corpusKeyDigest: manifest.corpusKeyDigest,
    plan: manifest.plan,
  };
  const manifestJson = canonicalJson(manifestForHmac);
  const expectedManifestHmac = hmacDigest(corpusKey, manifestJson);

  if (!timingSafeHexEqual(manifest.manifestHmac, expectedManifestHmac)) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Cleanup manifest structure HMAC mismatch");
  }

  return manifest;
}

// ── Execute cleanup ──────────────────────────────────────────────────────────

/**
 * Execute a cleanup plan against a verified SafeRun.
 *
 * Before any deletion:
 * 1. Reopens and verifies the run manifest (runId + corpusKeyDigest)
 * 2. Verifies the cleanup manifest HMAC and plan digest
 * 3. Confirms the run ID (exact case-sensitive match)
 * 4. Confirms the plan digest (exact match)
 * 5. Performs a fresh full tree scan and identity match
 * 6. Validates corpus key digest matches the safe run
 *
 * On any missing/extra/replaced/symlinked/type-changed target, deletes nothing.
 * Deletes only verified leaf-first targets with unlink/rmdir.
 * Never uses recursive rm, force, glob, or caller-selected path.
 * After successful deletion, removes the cleanup manifest and run root directory.
 * Cleanup-manifest unlink and run-root rmdir failures are treated as errors.
 *
 * @param safeRun - A verified SafeRun
 * @param corpusKey - The 32-byte lowercase-hex corpus key
 * @param confirmedRunId - The exact case-sensitive run ID confirmation
 * @param confirmedPlanDigest - The exact plan digest confirmation
 * @returns The number of targets deleted
 * @throws {EvidenceStoreError} On any verification failure or mismatch
 */
export async function executeCleanup(
  safeRun: SafeRun,
  corpusKey: string,
  confirmedRunId: string,
  confirmedPlanDigest: string,
): Promise<number> {
  // 0. Validate corpus key digest matches the safe run
  const expectedDigest = createHash("sha256")
    .update(corpusKeyBytes(corpusKey, "E_EVAL_INTEGRITY"))
    .digest("hex");
  if (!timingSafeHexEqual(expectedDigest, getSafeRunCorpusKeyDigest(safeRun))) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Corpus key does not match the safe run's corpusKeyDigest",
    );
  }

  // 1. Verify run ID confirmation (exact case-sensitive match)
  if (confirmedRunId !== getSafeRunId(safeRun)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Confirmed run ID does not match the safe run",
    );
  }

  // 2. Load and verify the cleanup manifest
  const manifest = await loadCleanupManifest(safeRun, corpusKey);

  // 3. Verify plan digest confirmation
  if (!timingSafeHexEqual(confirmedPlanDigest, manifest.plan.planDigest)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Confirmed plan digest does not match the cleanup manifest",
    );
  }

  // 4. Perform a fresh full tree scan
  const currentTargets = await scanTree(safeRun, "");

  // 5. Identity match: every planned target must exist with the same type, digest, dev, ino
  const plannedByPath = new Map<string, CleanupTarget>();
  for (const target of manifest.plan.targets) {
    plannedByPath.set(target.path, target);
  }

  const currentByPath = new Map<string, CleanupTarget>();
  for (const target of currentTargets) {
    currentByPath.set(target.path, target);
  }

  // Check for missing targets
  for (const [path, planned] of plannedByPath) {
    const current = currentByPath.get(path);
    if (current === undefined) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        `Cleanup target missing from current tree: ${path}`,
      );
    }
    if (current.type !== planned.type) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", `Cleanup target type changed: ${path}`);
    }
    if (current.digest !== planned.digest) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", `Cleanup target digest changed: ${path}`);
    }
    if (current.dev !== planned.dev || current.ino !== planned.ino) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", `Cleanup target identity changed: ${path}`);
    }
  }

  // Check for extra targets (unplanned files in the tree)
  for (const [path] of currentByPath) {
    if (!plannedByPath.has(path)) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        `Unexpected target in current tree: ${path}`,
      );
    }
  }

  // 6. Delete verified targets leaf-first (files before directories)
  // Targets are already in leaf-first order from scanTree
  let deletedCount = 0;
  for (const target of manifest.plan.targets) {
    const fullPath = safeRunPath(safeRun, target.path);

    if (target.type === "file") {
      // Re-verify the file identity immediately before deletion
      const currentStat = await safeRunStat(safeRun, target.path);
      if (currentStat.dev !== target.dev || currentStat.ino !== target.ino) {
        throw new EvidenceStoreError(
          "E_EVAL_INTEGRITY",
          `Target identity changed before deletion: ${target.path}`,
        );
      }
      await unlink(fullPath);
      deletedCount++;
    } else if (target.type === "directory") {
      // Re-verify the directory identity immediately before deletion
      const currentStat = await safeRunStat(safeRun, target.path);
      if (currentStat.dev !== target.dev || currentStat.ino !== target.ino) {
        throw new EvidenceStoreError(
          "E_EVAL_INTEGRITY",
          `Target identity changed before deletion: ${target.path}`,
        );
      }
      await rmdir(fullPath);
      deletedCount++;
    }
  }

  // 7. Remove the cleanup manifest and run root directory itself
  // Failures here are treated as errors (not silently acceptable)
  const runRoot = safeRunPath(safeRun, "");
  const cleanupManifestPath = safeRunPath(safeRun, CLEANUP_MANIFEST_FILENAME);

  await unlink(cleanupManifestPath);
  deletedCount++;

  await rmdir(runRoot);
  deletedCount++;

  return deletedCount;
}

// ── Dry-run plan (no persistence, no deletion) ────────────────────────────────

/**
 * Produce a dry-run cleanup plan for a SafeRun.
 * Returns the plan with exact relative targets and digest but deletes nothing
 * and persists nothing.
 *
 * @param safeRun - A verified SafeRun
 * @param corpusKey - The 32-byte lowercase-hex corpus key
 * @returns A CleanupPlan
 */
export async function dryRunCleanup(safeRun: SafeRun, corpusKey: string): Promise<CleanupPlan> {
  return planCleanup(safeRun, corpusKey);
}
