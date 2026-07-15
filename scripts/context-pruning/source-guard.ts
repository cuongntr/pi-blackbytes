/**
 * Path-free before/after source integrity guards for the context-pruning evidence store.
 *
 * This module provides a `SourceGuard` that opens a source file read-only with
 * real O_NOFOLLOW flag, rejects symlinks and non-regular files, streams HMAC-SHA256
 * in bounded chunks from the same descriptor, and checks dev/inode/size/mtime
 * before and after an operation.
 *
 * The source path, canonical path, and corpus key are stored only in module-private
 * WeakMap state and are never serialized. Errors emit generic `E_EVAL_INTEGRITY`
 * codes with no source path or basename in the message.
 *
 * `verifySourceIntegrity(guard)` uses the stored path (no caller-supplied path),
 * re-checks that the original path resolves to the same canonical target, and
 * returns path-free before/after digest evidence.
 *
 * @module
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { EvidenceStoreError } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Read chunk size for streaming HMAC computation (64 KB). */
const HMAC_CHUNK_SIZE = 65536;

/** Pattern for a valid lowercase-hex SHA-256 digest. */
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

function timingSafeDigestEqual(left: string, right: string): boolean {
  if (!HEX64_PATTERN.test(left) || !HEX64_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

// ── Source identity snapshot ──────────────────────────────────────────────────

/**
 * Immutable snapshot of a source file's identity at a point in time.
 * Contains no path information in serialized form.
 */
interface SourceIdentity {
  /** The original path as provided at guard creation. */
  readonly originalPath: string;
  /** The canonical (realpath-resolved) path at guard creation. */
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** HMAC-SHA256 digest of the file content using the corpus key. */
  readonly digest: string;
  /** The corpus key bytes (never serialized, never exposed). */
  readonly keyBytes: Buffer;
}

// ── Module-private state ──────────────────────────────────────────────────────

/**
 * WeakMap storing source identity snapshots keyed by an opaque handle.
 * The handle is never serialized and never exposed in error messages.
 * The source path is stored only in the WeakMap, never in the handle.
 */
const sourceIdentities = new WeakMap<object, SourceIdentity>();

// ── Source guard handle ──────────────────────────────────────────────────────

/**
 * An opaque handle representing a verified source file.
 * The source path, canonical path, and corpus key are stored only in the
 * module-private WeakMap. This handle can be serialized as a generic reference
 * but contains no path.
 */
export interface SourceDigestEvidence {
  readonly algorithm: "hmac-sha256";
  readonly digest: string;
  readonly byteLength: number;
}

export interface SourceGuard {
  /** Opaque brand to prevent construction outside this module. */
  readonly __brand: "SourceGuard";
  /** Path-free digest evidence captured before the guarded operation. */
  readonly before: SourceDigestEvidence;
}

const SOURCE_GUARD_BRAND = "SourceGuard" as const;

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 of a file's content in bounded chunks from an already-open
 * file handle. The handle must have been opened with O_NOFOLLOW flag.
 */
async function computeFileHmacFromHandle(
  handle: import("node:fs").promises.FileHandle,
  keyBytes: Buffer,
): Promise<string> {
  const hmac = createHmac("sha256", keyBytes);
  const buffer = Buffer.alloc(HMAC_CHUNK_SIZE);
  let bytesRead: number;

  do {
    const result = await handle.read(buffer, 0, HMAC_CHUNK_SIZE, null);
    bytesRead = result.bytesRead;
    if (bytesRead > 0) {
      hmac.update(buffer.subarray(0, bytesRead));
    }
  } while (bytesRead > 0);

  return hmac.digest("hex");
}

/**
 * Open a file with real O_NOFOLLOW flag, fstat the handle,
 * verify it's a regular file, and return the handle + stats.
 * This prevents TOCTOU attacks between lstat and open.
 */
async function openWithNoFollowVerify(
  filePath: string,
): Promise<{ handle: import("node:fs").promises.FileHandle; stats: import("node:fs").Stats }> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(filePath, flags);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Path is not a regular file");
    }
    return { handle, stats };
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
}

// ── Source guard creation ─────────────────────────────────────────────────────

/**
 * Open a source file read-only with real O_NOFOLLOW flag, verify it is a
 * regular file (not a symlink), compute its HMAC-SHA256 digest from the same
 * descriptor, and return a `SourceGuard`.
 *
 * The source path, canonical path, and corpus key are stored only in
 * module-private WeakMap state. The returned handle contains no path information.
 *
 * @param sourcePath - Absolute path to the source file (opened read-only)
 * @param corpusKey - 32-byte lowercase-hex corpus key for HMAC
 * @returns A SourceGuard handle
 * @throws {EvidenceStoreError} E_EVAL_INTEGRITY if the file is not a regular file,
 *   is a symlink, or cannot be read
 */
export async function createSourceGuard(
  sourcePath: string,
  corpusKey: string,
): Promise<SourceGuard> {
  // Validate corpus key format
  if (!HEX64_PATTERN.test(corpusKey)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Corpus key must be exactly 32 lowercase-hex bytes",
    );
  }

  const keyBytes = Buffer.from(corpusKey, "hex");

  // Lstat the file first to check it's a regular file and not a symlink
  let lstatStats: import("node:fs").Stats;
  try {
    lstatStats = await lstat(sourcePath);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Cannot stat source file");
  }

  if (lstatStats.isSymbolicLink()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source path is a symlink");
  }

  if (!lstatStats.isFile()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source path is not a regular file");
  }

  // Resolve the canonical path
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(sourcePath);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Cannot resolve canonical source path");
  }

  // Open with real O_NOFOLLOW flag, fstat the handle,
  // verify identity against lstat result
  const { handle, stats: openStats } = await openWithNoFollowVerify(sourcePath);

  try {
    // Verify the opened file matches the lstat identity (detects TOCTOU swap)
    if (openStats.dev !== lstatStats.dev || openStats.ino !== lstatStats.ino) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        "Source file identity changed between lstat and open",
      );
    }

    // Compute HMAC-SHA256 from the same descriptor
    const digest = await computeFileHmacFromHandle(handle, keyBytes);

    // Fstat after reading to verify stability
    const afterStats = await handle.stat();
    if (afterStats.dev !== openStats.dev || afterStats.ino !== openStats.ino) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source file identity changed during read");
    }
    if (afterStats.size !== openStats.size || afterStats.mtimeMs !== openStats.mtimeMs) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source file changed during read");
    }

    // Store the identity snapshot in module-private state
    const identity: SourceIdentity = {
      originalPath: sourcePath,
      canonicalPath,
      dev: lstatStats.dev,
      ino: lstatStats.ino,
      size: lstatStats.size,
      mtimeMs: lstatStats.mtimeMs,
      digest,
      keyBytes,
    };

    const before = Object.freeze({
      algorithm: "hmac-sha256" as const,
      digest,
      byteLength: openStats.size,
    });
    const guard = Object.freeze({ __brand: SOURCE_GUARD_BRAND, before });
    sourceIdentities.set(guard, identity);

    return guard;
  } finally {
    await handle.close();
  }
}

// ── Source integrity verification ─────────────────────────────────────────────

/**
 * Verify that a source file has not been modified, replaced, or retargeted
 * since the `SourceGuard` was created.
 *
 * Uses the stored original path (no caller-supplied path). Re-checks that
 * the original path resolves to the same canonical target.
 *
 * Checks:
 * - original path still resolves to the same canonical path
 * - dev/inode unchanged (not replaced by a different file)
 * - size unchanged
 * - mtime unchanged
 * - still a regular file (not symlinked)
 * - HMAC-SHA256 digest unchanged
 *
 * On any mismatch, throws `E_EVAL_INTEGRITY` with a generic message containing
 * no source path or basename.
 *
 * @param guard - The SourceGuard to verify
 * @throws {EvidenceStoreError} E_EVAL_INTEGRITY on any mutation, replacement, or retarget
 */
/** Pseudonymize one ephemeral structural value with a registered guard's private key. */
export function pseudonymizeGuardedValue(guard: SourceGuard, value: string): string {
  const identity = sourceIdentities.get(guard);
  if (identity === undefined) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source guard is not registered");
  }
  return createHmac("sha256", identity.keyBytes).update(Buffer.from(value, "utf8")).digest("hex");
}

/**
 * Copy a guarded source to an already-exclusive destination descriptor in bounded
 * chunks. The caller never receives the source path; it is read only from this
 * module's private guard registry.
 */
export async function streamGuardedSourceTo(
  guard: SourceGuard,
  destination: import("node:fs").promises.FileHandle,
): Promise<void> {
  const identity = sourceIdentities.get(guard);
  if (identity === undefined) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source guard is not registered");
  }
  await verifySourceIntegrity(guard);
  const { handle, stats } = await openWithNoFollowVerify(identity.originalPath);
  try {
    const destinationStats = await destination.stat();
    if (
      stats.dev !== identity.dev ||
      stats.ino !== identity.ino ||
      stats.nlink !== 1 ||
      !destinationStats.isFile() ||
      destinationStats.nlink !== 1 ||
      (destinationStats.dev === stats.dev && destinationStats.ino === stats.ino)
    ) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        "Source identity is not eligible for copying",
      );
    }
    const buffer = Buffer.alloc(HMAC_CHUNK_SIZE);
    let position = 0;
    let bytesRead: number;
    do {
      const read = await handle.read(buffer, 0, buffer.length, null);
      bytesRead = read.bytesRead;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten === 0) {
          throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Copy write did not make progress");
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    } while (bytesRead > 0);
    const after = await handle.stat();
    if (
      after.dev !== stats.dev ||
      after.ino !== stats.ino ||
      after.size !== stats.size ||
      after.mtimeMs !== stats.mtimeMs
    ) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source changed during copy");
    }
  } finally {
    await handle.close();
    await verifySourceIntegrity(guard);
  }
}

/**
 * Verify an already-open, read-only copy descriptor against a registered guard.
 * The key, source path, and expected digest remain private to this module.
 */
export async function validateGuardedCopyDescriptor(
  guard: SourceGuard,
  handle: import("node:fs").promises.FileHandle,
): Promise<void> {
  const identity = sourceIdentities.get(guard);
  if (identity === undefined) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source guard is not registered");
  }
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Disposable copy is not a private regular file",
    );
  }
  const digest = await computeFileHmacFromHandle(handle, identity.keyBytes);
  const after = await handle.stat();
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.nlink !== before.nlink ||
    !timingSafeDigestEqual(digest, identity.digest)
  ) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Disposable copy integrity check failed");
  }
}

export async function verifySourceIntegrity(guard: SourceGuard): Promise<SourceDigestEvidence> {
  const identity = sourceIdentities.get(guard);
  if (identity === undefined) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source guard is not registered");
  }

  // Re-check that the original path resolves to the same canonical target
  let currentCanonical: string;
  try {
    currentCanonical = await realpath(identity.originalPath);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source integrity check failed");
  }

  if (currentCanonical !== identity.canonicalPath) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Source file was redirected to a different target",
    );
  }

  // Lstat the current file
  let currentStats: import("node:fs").Stats;
  try {
    currentStats = await lstat(identity.originalPath);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source integrity check failed");
  }

  // Check it's still a regular file (not replaced by symlink)
  if (currentStats.isSymbolicLink()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source file was replaced by a symlink");
  }

  if (!currentStats.isFile()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source file is no longer a regular file");
  }

  // Check dev/inode (detects file replacement or retarget)
  if (currentStats.dev !== identity.dev || currentStats.ino !== identity.ino) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Source file was replaced (different device or inode)",
    );
  }

  // Check size
  if (currentStats.size !== identity.size) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source file size changed");
  }

  // Check mtime
  if (currentStats.mtimeMs !== identity.mtimeMs) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source file modification time changed");
  }

  // Open with real O_NOFOLLOW and recompute HMAC digest from the same descriptor
  const { handle, stats: openStats } = await openWithNoFollowVerify(identity.originalPath);

  try {
    // Verify identity against lstat
    if (openStats.dev !== currentStats.dev || openStats.ino !== currentStats.ino) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        "Source file identity changed between lstat and open",
      );
    }

    const currentDigest = await computeFileHmacFromHandle(handle, identity.keyBytes);
    const afterStats = await handle.stat();
    if (
      afterStats.dev !== openStats.dev ||
      afterStats.ino !== openStats.ino ||
      afterStats.size !== openStats.size ||
      afterStats.mtimeMs !== openStats.mtimeMs
    ) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source file changed during verification");
    }
    if (!timingSafeDigestEqual(currentDigest, identity.digest)) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source file content digest mismatch");
    }
    return Object.freeze({
      algorithm: "hmac-sha256" as const,
      digest: currentDigest,
      byteLength: afterStats.size,
    });
  } finally {
    await handle.close();
  }
}

// ── Full HMAC verification (standalone, no guard needed) ─────────────────────

/**
 * Full HMAC-SHA256 verification of a source file against an expected digest.
 * Uses real O_NOFOLLOW descriptor pattern: opens the file, fstats the handle,
 * streams HMAC from the same descriptor, and verifies stability.
 *
 * @param sourcePath - The source file path
 * @param corpusKey - The 32-byte lowercase-hex corpus key
 * @param expectedDigest - The expected HMAC-SHA256 digest
 * @throws {EvidenceStoreError} E_EVAL_INTEGRITY on mismatch
 */
export async function verifySourceDigest(
  sourcePath: string,
  corpusKey: string,
  expectedDigest: string,
): Promise<void> {
  if (!HEX64_PATTERN.test(corpusKey)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Corpus key must be exactly 32 lowercase-hex bytes",
    );
  }

  if (!HEX64_PATTERN.test(expectedDigest)) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Expected digest must be a 64-character lowercase hex string",
    );
  }

  const keyBytes = Buffer.from(corpusKey, "hex");

  // Check it's a regular file, not a symlink
  let lstatStats: import("node:fs").Stats;
  try {
    lstatStats = await lstat(sourcePath);
  } catch {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Cannot stat source file for digest verification",
    );
  }

  if (lstatStats.isSymbolicLink()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source path is a symlink");
  }

  if (!lstatStats.isFile()) {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source path is not a regular file");
  }

  // Open with real O_NOFOLLOW flag
  const { handle, stats: openStats } = await openWithNoFollowVerify(sourcePath);

  try {
    // Verify identity against lstat
    if (openStats.dev !== lstatStats.dev || openStats.ino !== lstatStats.ino) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        "Source file identity changed between lstat and open",
      );
    }

    const actualDigest = await computeFileHmacFromHandle(handle, keyBytes);
    const afterStats = await handle.stat();
    if (
      afterStats.dev !== openStats.dev ||
      afterStats.ino !== openStats.ino ||
      afterStats.size !== openStats.size ||
      afterStats.mtimeMs !== openStats.mtimeMs
    ) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source file changed during verification");
    }

    if (!timingSafeDigestEqual(actualDigest, expectedDigest)) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Source file content digest mismatch");
    }
  } finally {
    await handle.close();
  }
}

// ── Source guard cleanup ──────────────────────────────────────────────────────

/**
 * Release the stored identity for a SourceGuard.
 * After this call, the guard can no longer be verified.
 */
export function releaseSourceGuard(guard: SourceGuard): void {
  sourceIdentities.delete(guard);
}
