import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { safeRealpath } from "./index.js";

/**
 * Filesystem error codes we surface as `E_WRITE_FAILED` with friendly messages.
 *
 * Anything else (including `ELOOP`, `ENOTDIR`, etc.) is rethrown so the outer
 * try/catch in `applyHashlineEdits` wraps it via the generic catch path.
 */
const FRIENDLY_FS_CODES = new Set(["EACCES", "EPERM", "ENOSPC", "EROFS"]);

export interface WriteTarget {
  /** Canonical (symlink-resolved) absolute path to write to. */
  canonicalPath: string;
  /** Whether the caller-supplied path was a symlink. */
  isSymlink: boolean;
  /** Hard-link count of the existing file; 1 for fresh files. */
  hardLinkCount: number;
  /** Permission bits (mode & 0o7777). Defaults to 0o644 when the file is new. */
  mode: number;
  /** True if the existing path resolves to something that is not a regular file. */
  isNonRegularFile: boolean;
}

/**
 * Resolve filesystem metadata for the write target.
 *
 * Behaviour:
 * - When the path exists, returns its canonical (realpath) location plus
 *   `nlink`, `mode`, and a flag indicating whether the caller path was a
 *   symlink (so the renderer can warn about indirection).
 * - When the path does NOT exist (ENOENT), returns `{ canonicalPath: path,
 *   isSymlink: false, hardLinkCount: 1, mode: 0o644 }` so callers can treat
 *   a rename-target-creation as an atomic write into the parent directory.
 *
 * Other errors (`EACCES`, `ELOOP`, …) propagate — the caller's catch path
 * turns them into `E_WRITE_FAILED`.
 */
export function resolveWriteTarget(path: string): WriteTarget {
  // lstat first so we can detect symlink-ness without following.
  let isSymlink = false;
  try {
    isSymlink = lstatSync(path).isSymbolicLink();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw e;
    // New file: nothing to resolve, defaults below.
    return {
      canonicalPath: path,
      isSymlink: false,
      hardLinkCount: 1,
      mode: 0o644,
      isNonRegularFile: false,
    };
  }

  const canonicalPath = safeRealpath(path);

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(canonicalPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Dangling symlink → treat target as a fresh write into the link's path.
      return {
        canonicalPath,
        isSymlink,
        hardLinkCount: 1,
        mode: 0o644,
        isNonRegularFile: false,
      };
    }
    throw e;
  }

  return {
    canonicalPath,
    isSymlink,
    hardLinkCount: st.nlink,
    mode: st.mode & 0o7777,
    isNonRegularFile: !st.isFile(),
  };
}

/**
 * Atomically write `content` to `targetPath`.
 *
 * Two paths:
 * - **Hard-link preservation** (`hardLinkCount > 1`): open the canonical path
 *   with `O_WRONLY | O_TRUNC` and overwrite in place. This preserves the inode
 *   so other names linked to it continue to see the new content.
 *   Trade-off: not atomic against a kill mid-write — the file can be observed
 *   as empty between truncate and final flush. Documented in the bead's Risks.
 * - **Atomic rename** (`hardLinkCount === 1`): write to a sibling temp file in
 *   the SAME directory (so `rename` is atomic on POSIX filesystems), then
 *   `rename` over the target. The temp fd is `fchmod`d to the target mode
 *   before close so the resulting inode appears at the final name with the
 *   right mode in one step, bypassing the process umask.
 *
 * Filesystem error mapping: `EACCES` / `EPERM` / `ENOSPC` / `EROFS` are
 * rethrown with the `code` field preserved so the caller can wrap them in
 * `formatError("E_WRITE_FAILED", ...)`. All other errors propagate untouched.
 */
export function writeFileAtomically(
  targetPath: string,
  hardLinkCount: number,
  mode: number,
  content: string,
): void {
  const buffer = Buffer.from(content, "utf8");
  try {
    if (hardLinkCount > 1) {
      writeInPlaceTruncate(targetPath, mode, buffer);
      return;
    }
    writeViaTempRename(targetPath, mode, buffer);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code && FRIENDLY_FS_CODES.has(code)) {
      // Preserve the code so the caller can match it; just rethrow.
      throw e;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

type WriteBuffer = (fd: number, buffer: Buffer, offset: number, length: number) => number;

export function writeBufferFully(fd: number, buffer: Buffer, write: WriteBuffer = writeSync): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = write(fd, buffer, offset, buffer.length - offset);
    if (written === 0) {
      throw new Error("Filesystem write made no progress");
    }
    offset += written;
  }
}

function writeInPlaceTruncate(targetPath: string, mode: number, content: Buffer): void {
  // O_WRONLY | O_TRUNC: preserve inode (and therefore all hard-link aliases).
  // We intentionally do NOT chmod here — in-place writes preserve the existing
  // mode by construction, so a stale mode argument can't downgrade perms.
  void mode;
  const fd = openSync(targetPath, fsConstants.O_WRONLY | fsConstants.O_TRUNC);
  try {
    writeBufferFully(fd, content);
  } finally {
    closeSync(fd);
  }
}

function writeViaTempRename(targetPath: string, mode: number, content: Buffer): void {
  const dir = dirname(targetPath);
  const base = basename(targetPath);
  const tempName = buildTempName(base);
  const tempPath = join(dir, tempName);

  // `wx` (O_CREAT | O_EXCL): refuse to clobber a leftover temp with the same
  // name. Because the suffix includes `pid` + 64-bit randomness, collisions
  // are not a practical concern; the `wx` flag is belt-and-suspenders.
  const fd = openSync(
    tempPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    mode,
  );
  try {
    try {
      writeBufferFully(fd, content);
      // `openSync(..., mode)` is subject to umask, so the on-disk mode may be
      // narrower than `mode`. `fchmodSync` sets the mode unconditionally so
      // the rename target receives exactly the bits the caller asked for.
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore — original error is more useful
    }
    throw e;
  }

  try {
    renameSync(tempPath, targetPath);
  } catch (e) {
    // Best-effort cleanup of the temp file on rename failure.
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore — original error is more useful
    }
    throw e;
  }
}

function buildTempName(base: string): string {
  // Hidden dotfile so editors/listers don't pick it up between create and
  // rename; pid + 8 random bytes keeps the name unique even across crashed
  // prior runs that left temps behind.
  const rand = randomBytes(8).toString("hex");
  return `.${base}.tmp.${process.pid}.${rand}`;
}
