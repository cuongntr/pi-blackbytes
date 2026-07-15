/**
 * Capability-based canonical run/path safety for the context-pruning evidence store.
 *
 * A `SafeRun` is an opaque handle backed by a module-private WeakMap.
 * It cannot be forged by external code. All operations validate membership
 * in the WeakMap and revalidate the canonical root dev/inode.
 *
 * A `PreManifestRun` is similarly opaque — its root and runId are accessible
 * only through registry-backed accessors. Forged handles are rejected.
 *
 * This module uses only Node `fs` and `crypto`. No external dependencies.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { canonicalJson } from "./canonical-json.js";
import { EVIDENCE_ROOT_SEGMENTS, EvidenceStoreError } from "./types.js";
import type { RunManifest } from "./types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Pattern for valid run IDs: 1-128 safe ASCII characters, single path component. */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Pattern for a valid lowercase-hex SHA-256 digest. */
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const RUN_MANIFEST_KEYS = [
  "corpusKeyDigest",
  "createdAt",
  "eventCount",
  "runId",
  "schemaVersion",
] as const;

// ── Module-private SafeRun data ──────────────────────────────────────────────

/**
 * Internal data stored in the module-private WeakMap for each SafeRun handle.
 * Contains no serializable path information in error messages.
 */
interface SafeRunData {
  /** The canonical absolute path to the run root. */
  readonly root: string;
  /** The verified run ID (case-sensitive). */
  readonly runId: string;
  /** The SHA-256 digest of the corpus key from the run manifest. */
  readonly corpusKeyDigest: string;
  /** Device number of the run root directory (for revalidation). */
  readonly dev: number;
  /** Inode number of the run root directory (for revalidation). */
  readonly ino: number;
}

/**
 * WeakMap storing SafeRun data keyed by an opaque handle.
 * External code cannot access this map, making SafeRun unforgeable.
 */
const safeRunRegistry = new WeakMap<object, SafeRunData>();

// ── SafeRun capability ────────────────────────────────────────────────────────

/**
 * An opaque handle that grants access to files within one verified run root.
 *
 * The handle is backed by a module-private WeakMap. External code cannot
 * construct a valid SafeRun — all operations validate membership in the
 * registry and revalidate the canonical root dev/inode.
 *
 * No path constructed from this capability can escape the run root.
 */
export interface SafeRun {
  /** Opaque brand to prevent construction outside this module. */
  readonly __brand: "SafeRun";
}

// ── Pre-manifest handle (distinguished from verified SafeRun) ────────────────

/**
 * A pre-manifest SafeRun handle returned by `ensurePrivateRunRoot()`.
 * This handle has an empty corpusKeyDigest and is only valid for
 * initialization operations (writing the manifest, creating corpus key).
 * It cannot be used for evidence operations.
 *
 * The root and runId are NOT exposed on the interface — they are accessible
 * only through registry-backed accessors. Forged handles are rejected.
 */
export interface PreManifestRun {
  /** Opaque brand to distinguish from verified SafeRun. */
  readonly __brand: "PreManifestRun";
}

interface PreManifestRunData {
  readonly root: string;
  readonly runId: string;
}

const preManifestRegistry = new WeakMap<object, PreManifestRunData>();

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Get SafeRun data from the registry, throwing if the handle is invalid.
 */
function getSafeRunData(safeRun: SafeRun): SafeRunData {
  const data = safeRunRegistry.get(safeRun);
  if (data === undefined) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Invalid SafeRun capability");
  }
  return data;
}

/**
 * Revalidate that the stored root still resolves to the same dev/inode.
 * This detects directory replacement attacks.
 */
async function syncPrivateDirectory(dirPath: string): Promise<void> {
  const handle = await open(dirPath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function revalidateRoot(data: SafeRunData): Promise<void> {
  let stats: import("node:fs").Stats;
  try {
    stats = await lstat(data.root);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "SafeRun root is no longer accessible");
  }
  if (!stats.isDirectory()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "SafeRun root is no longer a directory");
  }
  if (stats.dev !== data.dev || stats.ino !== data.ino) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "SafeRun root was replaced (different device or inode)",
    );
  }
}

/**
 * Walk each component of a path with lstat, rejecting symlinks, special files,
 * and cross-device paths.
 */
async function walkComponentsWithLstat(
  basePath: string,
  relativePath: string,
  baseDev: number,
): Promise<void> {
  if (relativePath.length === 0) return;
  const components = relativePath.split("/");
  let current = basePath;

  for (const component of components) {
    current = join(current, component);
    let stats: import("node:fs").Stats;
    try {
      stats = await lstat(current);
    } catch {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path component is not accessible");
    }

    if (stats.isSymbolicLink()) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path component is a symlink");
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path component is a special file");
    }
    if (stats.dev !== baseDev) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path component crosses device boundary");
    }
  }
}

/**
 * Open a file with real O_NOFOLLOW flag, fstat the handle, verify identity
 * against the expected dev/inode, and return the handle + content.
 * Rejects symlinks at the kernel level.
 */
async function openWithNoFollowRead(
  filePath: string,
  expectedDev: number,
  expectedIno: number,
): Promise<Buffer> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(filePath, flags);
  try {
    const stats = await handle.stat();
    if (stats.dev !== expectedDev || stats.ino !== expectedIno) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        "File identity changed between lstat and open",
      );
    }
    if (!stats.isFile()) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path is not a regular file");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// ── Internal brand implementation ─────────────────────────────────────────────

function brandPreManifestRun(root: string, runId: string): PreManifestRun {
  const handle = Object.freeze({ __brand: "PreManifestRun" as const });
  preManifestRegistry.set(handle, { root, runId });
  return handle;
}

// ── PreManifestRun accessors ─────────────────────────────────────────────────

/**
 * Get the root path from a PreManifestRun.
 * Throws if the handle is invalid (forged).
 */
export function preManifestRunPath(preRun: PreManifestRun): string {
  const data = preManifestRegistry.get(preRun);
  if (data === undefined) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Invalid PreManifestRun capability");
  }
  return data.root;
}

/**
 * Get the run ID from a PreManifestRun.
 * Throws if the handle is invalid (forged).
 */
export function preManifestRunId(preRun: PreManifestRun): string {
  const data = preManifestRegistry.get(preRun);
  if (data === undefined) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Invalid PreManifestRun capability");
  }
  return data.runId;
}

// ── Path validation helpers ───────────────────────────────────────────────────

/**
 * Check whether a resolved path is strictly inside the run root.
 * Both paths must already be canonical (resolved).
 */
function isStrictlyInside(child: string, parent: string): boolean {
  if (child === parent) return false; // must be strictly inside, not equal
  if (!child.startsWith(parent)) return false;
  const suffix = child.slice(parent.length);
  return suffix.startsWith(sep) || suffix.startsWith("/");
}

/**
 * Validate a single path component (between separators).
 * Rejects empty, dot, dot-dot, glob characters, and control characters.
 */
function isValidComponent(component: string): boolean {
  if (component.length === 0) return false;
  if (component === "." || component === "..") return false;
  // Reject glob characters: * ? [ ] { }
  if (/[*?[\]{}]/.test(component)) return false;
  // Reject control characters and NUL
  for (let i = 0; i < component.length; i++) {
    const code = component.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Validate a relative path for use within a SafeRun.
 * The path must be relative, use forward slashes, contain no traversal,
 * no globs, no NUL, no empty/dot components, and no backslashes.
 */
export function validateSafeRelativePath(relativePath: string): void {
  if (relativePath.length === 0) {
    return; // empty path means the root of the SafeRun
  }
  if (relativePath.startsWith("/")) {
    throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Relative path must not start with /");
  }
  if (relativePath.includes("\\")) {
    throw new EvidenceStoreError(
      "E_EVAL_UNSAFE_PATH",
      "Relative path must not contain backslashes",
    );
  }
  if (relativePath.includes("\x00")) {
    throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Relative path must not contain NUL bytes");
  }
  if (/[*?[\]{}]/.test(relativePath)) {
    throw new EvidenceStoreError(
      "E_EVAL_UNSAFE_PATH",
      "Relative path must not contain glob characters",
    );
  }
  if (relativePath === "." || relativePath === "..") {
    throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Relative path must not be . or ..");
  }

  // Check each component
  const components = relativePath.split("/");
  for (const component of components) {
    if (!isValidComponent(component)) {
      throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", `Invalid path component: ${component}`);
    }
  }

  // After splitting and re-joining, ensure no traversal remains
  const normalized = normalize(relativePath);
  if (normalized.startsWith("..")) {
    throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Relative path must not traverse upward");
  }
}

// ── Run ID validation ─────────────────────────────────────────────────────────

/** Validate a run ID string. Throws `E_EVAL_UNSAFE_PATH` on invalid input. */
export function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    throw new EvidenceStoreError(
      "E_EVAL_UNSAFE_PATH",
      "Run ID must be 1-128 safe ASCII characters and a single path component",
    );
  }
}

// ── Canonical path resolution ─────────────────────────────────────────────────

/**
 * Resolve the canonical evidence root below an explicit Pi agent directory.
 * This is the same as `resolveEvidenceRoot` in evidence-store.ts but re-exported
 * here for convenience.
 */
export function resolveEvidenceRoot(piAgentDir: string): string {
  if (piAgentDir.length === 0) {
    throw new EvidenceStoreError("E_EVAL_CONFIG", "PI_AGENT_DIR must not be empty");
  }
  return resolve(piAgentDir, ...EVIDENCE_ROOT_SEGMENTS);
}

/**
 * Resolve a validated run root below the canonical evidence root.
 * This is the same as `resolveRunRoot` in evidence-store.ts but re-exported
 * here for convenience.
 */
export function resolveRunRoot(piAgentDir: string, runId: string): string {
  assertSafeRunId(runId);
  const evidenceRoot = resolveEvidenceRoot(piAgentDir);
  const runRoot = resolve(evidenceRoot, runId);

  if (dirname(runRoot) !== evidenceRoot) {
    throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Run root escaped the evidence root");
  }
  return runRoot;
}

// ── SafeRun creation ──────────────────────────────────────────────────────────

/**
 * Open a SafeRun for a known run ID.
 *
 * This function:
 * 1. Validates the run ID
 * 2. Resolves the canonical run root
 * 3. Realpath-resolves the run root to detect symlink escape
 * 4. Lstats each existing evidence-root/run component before mkdir and rejects
 *    any symlink/special/cross-device
 * 5. O_NOFOLLOW-reads canonical exact-schema manifest.json and corpus.key
 * 6. Verifies canonical manifest bytes and actual key digest
 * 7. Returns a SafeRun capability backed by module-private WeakMap
 *
 * The SafeRun's root is guaranteed to be a canonical path strictly inside
 * the evidence root.
 */
export async function openSafeRun(piAgentDir: string, runId: string): Promise<SafeRun> {
  assertSafeRunId(runId);

  const evidenceRoot = resolveEvidenceRoot(piAgentDir);
  const runRoot = resolveRunRoot(piAgentDir, runId);

  // Resolve the run root to its real path to detect symlink escape
  let realRunRoot: string;
  try {
    realRunRoot = await realpathSafe(runRoot);
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) {
      if ((error as EvidenceStoreError).code === "E_EVAL_UNSAFE_PATH") {
        throw new EvidenceStoreError(
          "E_EVAL_INTEGRITY",
          "Run root does not exist or is not accessible",
        );
      }
      throw error;
    }
    throw new EvidenceStoreError(
      "E_EVAL_UNSAFE_PATH",
      `Cannot resolve run root: ${(error as Error).message}`,
    );
  }

  // Verify the real path is strictly inside the evidence root
  const realEvidenceRoot = await realpathSafe(evidenceRoot);
  if (!isStrictlyInside(realRunRoot, realEvidenceRoot)) {
    throw new EvidenceStoreError(
      "E_EVAL_UNSAFE_PATH",
      "Run root escaped the evidence root via symlink",
    );
  }

  // Verify the run root's basename matches the run ID
  const basename = realRunRoot.split(sep).pop() ?? "";
  if (basename !== runId) {
    throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Run root basename does not match run ID");
  }

  // Lstat the run root to verify it's a real directory (not a symlink)
  let rootStats: import("node:fs").Stats;
  try {
    rootStats = await lstat(realRunRoot);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Run root is not accessible");
  }
  if (!rootStats.isDirectory()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Run root is not a directory");
  }
  if (rootStats.isSymbolicLink()) {
    throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Run root is a symlink");
  }

  // Lstat each existing evidence-root/run component before reading
  // Walk the evidence root components
  let current = resolve(piAgentDir);
  for (const segment of EVIDENCE_ROOT_SEGMENTS) {
    current = join(current, segment);
    let segStats: import("node:fs").Stats;
    try {
      segStats = await lstat(current);
    } catch {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Evidence root component is not accessible");
    }
    if (segStats.isSymbolicLink()) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Evidence root component is a symlink");
    }
    if (!segStats.isDirectory()) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        "Evidence root component is not a directory",
      );
    }
  }

  // O_NOFOLLOW-read the manifest.json
  const manifestPath = join(realRunRoot, "manifest.json");
  let manifestStats: import("node:fs").Stats;
  try {
    manifestStats = await lstat(manifestPath);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Cannot stat run manifest");
  }
  if (manifestStats.isSymbolicLink()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Run manifest is a symlink");
  }
  if (!manifestStats.isFile()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Run manifest is not a regular file");
  }

  let manifestContent: Buffer;
  try {
    manifestContent = await openWithNoFollowRead(
      manifestPath,
      manifestStats.dev,
      manifestStats.ino,
    );
  } catch (error: unknown) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      `Cannot read run manifest: ${(error as Error).message}`,
    );
  }

  let manifestText: string;
  let manifest: RunManifest;
  try {
    manifestText = UTF8_DECODER.decode(manifestContent);
    manifest = JSON.parse(manifestText) as RunManifest;
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Run manifest is not valid UTF-8 JSON");
  }

  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Run manifest is not an object");
  }
  const manifestRecord = manifest as unknown as Record<string, unknown>;
  const manifestKeys = Object.keys(manifestRecord).sort();
  if (
    manifestKeys.length !== RUN_MANIFEST_KEYS.length ||
    manifestKeys.some((key, index) => key !== RUN_MANIFEST_KEYS[index]) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.runId !== "string" ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.eventCount !== "number" ||
    !Number.isSafeInteger(manifest.eventCount) ||
    manifest.eventCount < 0 ||
    typeof manifest.corpusKeyDigest !== "string"
  ) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Run manifest schema is invalid");
  }
  if (manifestText !== canonicalJson(manifest)) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Run manifest is not canonical JSON");
  }

  if (manifest.runId !== runId) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Run manifest runId does not match the requested run ID",
    );
  }

  if (!HEX64_PATTERN.test(manifest.corpusKeyDigest)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Run manifest corpusKeyDigest is not a valid SHA-256 hex digest",
    );
  }

  // O_NOFOLLOW-read the corpus.key to verify the actual key digest
  const corpusKeyPath = join(realRunRoot, "corpus.key");
  let corpusKeyStats: import("node:fs").Stats;
  try {
    corpusKeyStats = await lstat(corpusKeyPath);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Cannot stat corpus key");
  }
  if (corpusKeyStats.isSymbolicLink()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Corpus key is a symlink");
  }
  if (!corpusKeyStats.isFile()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Corpus key is not a regular file");
  }

  let corpusKeyContent: Buffer;
  try {
    corpusKeyContent = await openWithNoFollowRead(
      corpusKeyPath,
      corpusKeyStats.dev,
      corpusKeyStats.ino,
    );
  } catch (error: unknown) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      `Cannot read corpus key: ${(error as Error).message}`,
    );
  }

  let actualKey: string;
  try {
    actualKey = UTF8_DECODER.decode(corpusKeyContent);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Corpus key is not valid UTF-8");
  }
  if (!HEX64_PATTERN.test(actualKey)) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Corpus key is not a valid hex string");
  }

  // Verify the actual key digest matches the manifest
  const { createHash } = await import("node:crypto");
  const actualDigest = createHash("sha256").update(Buffer.from(actualKey, "hex")).digest("hex");
  if (actualDigest !== manifest.corpusKeyDigest) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Corpus key digest does not match manifest corpusKeyDigest",
    );
  }

  // Create the opaque handle and store data in the module-private WeakMap
  const handle = Object.freeze({ __brand: "SafeRun" as const });
  safeRunRegistry.set(handle, {
    root: realRunRoot,
    runId,
    corpusKeyDigest: manifest.corpusKeyDigest,
    dev: rootStats.dev,
    ino: rootStats.ino,
  });

  return handle;
}

// ── SafeRun property accessors (for cleanup and other internal consumers) ──

/**
 * Get the run ID from a SafeRun.
 * Throws if the handle is invalid.
 */
export function getSafeRunId(safeRun: SafeRun): string {
  return getSafeRunData(safeRun).runId;
}

/**
 * Get the corpus key digest from a SafeRun.
 * Throws if the handle is invalid.
 */
export function getSafeRunCorpusKeyDigest(safeRun: SafeRun): string {
  return getSafeRunData(safeRun).corpusKeyDigest;
}

// ── SafeRun path construction ─────────────────────────────────────────────────

/**
 * Resolve a validated relative path within a SafeRun.
 *
 * The returned path is guaranteed to be strictly inside the SafeRun's root.
 * Throws `E_EVAL_UNSAFE_PATH` if the path escapes.
 */
export function safeRunPath(safeRun: SafeRun, relativePath: string): string {
  const data = getSafeRunData(safeRun);
  validateSafeRelativePath(relativePath);
  const fullPath = resolve(data.root, relativePath);

  if (!fullPath.startsWith(data.root + sep) && fullPath !== data.root) {
    throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Resolved path escaped the safe run root");
  }

  return fullPath;
}

// ── SafeRun directory creation ────────────────────────────────────────────────

/**
 * Create or harden one directory to mode `0700` within a SafeRun.
 * Walks and validates parent components before creating.
 */
export async function ensurePrivateDir(safeRun: SafeRun, relativePath: string): Promise<string> {
  const data = getSafeRunData(safeRun);
  await revalidateRoot(data);
  const dirPath = safeRunPath(safeRun, relativePath);

  // Create one component at a time so every newly linked directory entry is
  // persisted in its parent before a deeper segment is created.
  let current = data.root;
  for (const component of relativePath.length === 0 ? [] : relativePath.split("/")) {
    const next = join(current, component);
    let created = false;
    try {
      await mkdir(next, { mode: 0o700 });
      created = true;
    } catch (error: unknown) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
      ) {
        throw error;
      }
    }
    const stats = await lstat(next);
    if (stats.isSymbolicLink() || !stats.isDirectory() || stats.dev !== data.dev) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Private directory component is unsafe");
    }
    await chmod(next, 0o700);
    if (created) {
      await syncPrivateDirectory(current);
      await syncPrivateDirectory(next);
    }
    current = next;
  }
  await walkComponentsWithLstat(data.root, relativePath, data.dev);
  await chmod(dirPath, 0o700);
  await syncPrivateDirectory(dirPath);
  return dirPath;
}

// ── SafeRun file creation ──────────────────────────────────────────────────────

/**
 * Create or harden one file to mode `0600` within a SafeRun.
 * Walks and validates parent components before creating.
 */
export async function ensurePrivateFile(safeRun: SafeRun, relativePath: string): Promise<string> {
  const data = getSafeRunData(safeRun);
  await revalidateRoot(data);
  const filePath = safeRunPath(safeRun, relativePath);

  // Walk and validate parent components
  const parentRelative = relativePath.includes("/")
    ? relativePath.split("/").slice(0, -1).join("/")
    : "";
  if (parentRelative.length > 0) {
    await walkComponentsWithLstat(data.root, parentRelative, data.dev);
  }

  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
  return filePath;
}

// ── SafeRun directory creation (full run root) ────────────────────────────────

/**
 * Create and harden every evidence directory below `$PI_AGENT_DIR` for a run.
 * Lstats each existing component before mkdir and rejects any symlink/special/cross-device.
 * Returns a PreManifestRun (not a verified SafeRun) because the manifest
 * has not been written yet. The caller must write the manifest and then
 * use openSafeRun for verification.
 */
export async function ensurePrivateRunRoot(
  piAgentDir: string,
  runId: string,
): Promise<PreManifestRun> {
  assertSafeRunId(runId);
  const resolvedAgentDir = resolve(piAgentDir);
  let current = resolvedAgentDir;

  for (const segment of EVIDENCE_ROOT_SEGMENTS) {
    current = join(current, segment);
    // Lstat existing component before mkdir
    let segStats: import("node:fs").Stats | null = null;
    try {
      segStats = await lstat(current);
    } catch {
      // Does not exist yet — will be created
    }
    if (segStats !== null) {
      if (segStats.isSymbolicLink()) {
        throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Evidence root component is a symlink");
      }
      if (!segStats.isDirectory()) {
        throw new EvidenceStoreError(
          "E_EVAL_UNSAFE_PATH",
          "Evidence root component is not a directory",
        );
      }
    }
    await mkdir(current, { recursive: true, mode: 0o700 });
    await chmod(current, 0o700);
  }

  const runRoot = resolveRunRoot(piAgentDir, runId);
  // Lstat existing run root before mkdir
  let runRootStats: import("node:fs").Stats | null = null;
  try {
    runRootStats = await lstat(runRoot);
  } catch {
    // Does not exist yet
  }
  if (runRootStats !== null) {
    if (runRootStats.isSymbolicLink()) {
      throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Run root is a symlink");
    }
    if (!runRootStats.isDirectory()) {
      throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Run root is not a directory");
    }
  }
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);

  return brandPreManifestRun(runRoot, runId);
}

// ── SafeRun file stat (with symlink rejection) ────────────────────────────────

/** Return whether a validated SafeRun file exists, without creating parent directories. */
export async function safeRunFileExists(safeRun: SafeRun, relativePath: string): Promise<boolean> {
  const data = getSafeRunData(safeRun);
  await revalidateRoot(data);
  safeRunPath(safeRun, relativePath);
  const components = relativePath.split("/");
  let current = data.root;
  for (const component of components) {
    current = join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || stats.dev !== data.dev) {
        throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path is not a safe regular file");
      }
      if (component === components.at(-1)) {
        if (!stats.isFile()) {
          throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path is not a safe regular file");
        }
      } else if (!stats.isDirectory()) {
        throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path parent is not a safe directory");
      }
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

/**
 * Stat a file within a SafeRun, using lstat to reject symlinks.
 * Returns the stat result if the file is a regular file or directory.
 */
export async function safeRunStat(
  safeRun: SafeRun,
  relativePath: string,
): Promise<{
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
}> {
  const data = getSafeRunData(safeRun);
  await revalidateRoot(data);
  const fullPath = safeRunPath(safeRun, relativePath);

  // Walk each existing component with lstat to reject symlinks
  await walkComponentsWithLstat(data.root, relativePath, data.dev);

  // Use lstat on the final path to reject symlinks
  const stats = await lstat(fullPath);

  if (stats.isSymbolicLink()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path is a symlink");
  }

  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
  };
}

// ── SafeRun file read (with O_NOFOLLOW) ──────────────────────────────────────

/**
 * Read a file within a SafeRun, using O_NOFOLLOW and fstat identity verification.
 * Opens the file with real O_NOFOLLOW flag, stats the handle, verifies identity
 * against lstat result, reads content, and closes.
 */
export async function safeRunReadFile(safeRun: SafeRun, relativePath: string): Promise<Buffer> {
  const data = getSafeRunData(safeRun);
  await revalidateRoot(data);
  const fullPath = safeRunPath(safeRun, relativePath);

  // Walk each existing component with lstat to reject symlinks
  await walkComponentsWithLstat(data.root, relativePath, data.dev);

  // Lstat the final path to get expected identity
  let expectedStats: import("node:fs").Stats;
  try {
    expectedStats = await lstat(fullPath);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Cannot stat file");
  }

  if (expectedStats.isSymbolicLink()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path is a symlink");
  }

  if (!expectedStats.isFile()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path is not a regular file");
  }

  // Open with real O_NOFOLLOW flag, then verify fstat identity
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(fullPath, flags);
  try {
    const handleStats = await handle.stat();
    if (handleStats.dev !== expectedStats.dev || handleStats.ino !== expectedStats.ino) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        "File identity changed between lstat and open",
      );
    }
    if (!handleStats.isFile()) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Opened path is not a regular file");
    }

    // Read the content from the verified handle
    const content = await handle.readFile();
    return content;
  } finally {
    await handle.close();
  }
}

// ── SafeRun file write (with atomicity and parent validation) ─────────────────

/**
 * Write content to a file within a SafeRun using an atomic temp+rename pattern.
 * Validates parent directory components with lstat before writing.
 * The file is created with mode 0600.
 */
/**
 * Atomically publish one file without replacing an existing destination.
 * Returns true when this caller created the destination, false when it already existed.
 */
/** Durably persist an existing private directory after a separately synced file update. */
export async function safeRunSyncDirectory(safeRun: SafeRun, relativePath: string): Promise<void> {
  const data = getSafeRunData(safeRun);
  await revalidateRoot(data);
  safeRunPath(safeRun, relativePath);
  await walkComponentsWithLstat(data.root, relativePath, data.dev);
  const directory = relativePath.length === 0 ? data.root : safeRunPath(safeRun, relativePath);
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== data.dev) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path is not a safe private directory");
  }
  await syncPrivateDirectory(directory);
}

export async function safeRunPublishExclusiveFile(
  safeRun: SafeRun,
  relativePath: string,
  content: string,
): Promise<boolean> {
  const data = getSafeRunData(safeRun);
  await revalidateRoot(data);
  const parentRelative = relativePath.includes("/")
    ? relativePath.split("/").slice(0, -1).join("/")
    : "";
  if (parentRelative.length > 0) await ensurePrivateDir(safeRun, parentRelative);
  await walkComponentsWithLstat(data.root, parentRelative, data.dev);
  const fullPath = safeRunPath(safeRun, relativePath);
  const baseName = relativePath.split("/").at(-1)!;
  const tempRelative = `${parentRelative.length === 0 ? "" : `${parentRelative}/`}.${baseName}.${process.pid}.${randomUUID()}.tmp`;
  const tempPath = safeRunPath(safeRun, tempRelative);
  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const stats = await handle.stat();
    if (!stats.isFile() || stats.dev !== data.dev) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Exclusive publication temp is unsafe");
    }
  } finally {
    await handle.close();
  }
  let created = false;
  try {
    await walkComponentsWithLstat(data.root, parentRelative, data.dev);
    await link(tempPath, fullPath);
    created = true;
  } catch (error: unknown) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
    ) {
      throw error;
    }
  } finally {
    await unlink(tempPath).catch(() => {});
  }
  if (created) {
    await walkComponentsWithLstat(data.root, relativePath, data.dev);
    await chmod(fullPath, 0o600);
    // Persist the directory entry after the temp file itself was fsynced.
    await syncPrivateDirectory(
      parentRelative.length === 0 ? data.root : safeRunPath(safeRun, parentRelative),
    );
  }
  return created;
}

export async function safeRunWriteFile(
  safeRun: SafeRun,
  relativePath: string,
  content: string,
): Promise<void> {
  const data = getSafeRunData(safeRun);
  await revalidateRoot(data);
  const fullPath = safeRunPath(safeRun, relativePath);
  const dir = dirname(fullPath);

  // Validate the parent directory exists and is not a symlink
  const parentRelative = relativePath.includes("/")
    ? relativePath.split("/").slice(0, -1).join("/")
    : "";
  if (parentRelative.length > 0) {
    await walkComponentsWithLstat(data.root, parentRelative, data.dev);
  }

  // Write to a temp file first, then rename atomically
  const tempPath = join(dir, `.${relativePath.replace(/\//g, "_")}.tmp.${process.pid}`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  // Rename atomically
  const { rename, unlink } = await import("node:fs/promises");
  try {
    await rename(tempPath, fullPath);
  } catch (error: unknown) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  await chmod(fullPath, 0o600);
}

// ── Realpath with symlink rejection ───────────────────────────────────────────

/**
 * Resolve a path to its canonical real path, rejecting symlinks.
 * Uses lstat on each component to detect symlinks.
 */
async function realpathSafe(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  try {
    // First lstat the path to check it's not a symlink
    let stats: import("node:fs").Stats;
    try {
      stats = await lstat(path);
    } catch {
      // Path doesn't exist; resolve parent
      const parent = dirname(path);
      try {
        const realParent = await realpath(parent);
        return join(
          realParent,
          path
            .slice(parent.length + 1)
            .split(sep)
            .join(sep),
        );
      } catch {
        throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Cannot resolve parent path");
      }
    }

    if (stats.isSymbolicLink()) {
      throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Path is a symlink");
    }

    return await realpath(path);
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) throw error;
    throw error;
  }
}

// ── SafeRun listing (rejects symlinks) ──────────────────────────────────────

/**
 * List entries in a directory within a SafeRun.
 * Rejects symlinks and special files (does not skip them).
 * Returns only regular files and directories.
 */
export async function safeRunReaddir(
  safeRun: SafeRun,
  relativePath: string,
): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
  const data = getSafeRunData(safeRun);
  await revalidateRoot(data);
  const fullPath = safeRunPath(safeRun, relativePath);

  // Walk each existing component with lstat to reject symlinks
  if (relativePath.length > 0) {
    await walkComponentsWithLstat(data.root, relativePath, data.dev);
  }

  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(fullPath, { withFileTypes: true });

  const result: Array<{ name: string; isFile: boolean; isDirectory: boolean }> = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        `Directory contains a symlink: ${entry.name}`,
      );
    }
    if (entry.isFile() || entry.isDirectory()) {
      result.push({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() });
    } else {
      // Reject special files (sockets, FIFOs, etc.)
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        `Directory contains a special file: ${entry.name}`,
      );
    }
  }
  return result;
}
