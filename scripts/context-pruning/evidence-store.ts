/**
 * Private evidence run store with atomic records.
 *
 * This module is evaluation-only. It has no provider or Pi session access.
 *
 * Public API accepts only runtime-validated capabilities:
 * - `loadOrCreateCorpusKey(preRun)` — PreManifestRun
 * - `atomicManifestWrite(preRun|safeRun, manifest)` — PreManifestRun or SafeRun
 * - `appendEvent(safeRun, relativePath, event)` — SafeRun + validated relative path
 * - `loadExistingEventIds(safeRun, relativePath)` — SafeRun + validated relative path
 *
 * No exported function accepts arbitrary `runRoot`, `dirPath`, `eventsPath`,
 * or returns a raw run root for writes.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, link, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { canonicalJson } from "./canonical-json.js";
import type { PreManifestRun, SafeRun } from "./path-safety.js";
import { preManifestRunPath, safeRunPath } from "./path-safety.js";
import type { EvalErrorCode, EvidenceError, EvidenceEvent, RunManifest } from "./types.js";
import { EVIDENCE_ROOT_SEGMENTS, EvidenceStoreError } from "./types.js";

/** Content-free path segments below `$PI_AGENT_DIR`. */
export const CORPUS_KEY_FILENAME = "corpus.key";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CORPUS_KEY_PATTERN = /^[0-9a-f]{64}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Test-only interruption hook for deterministic atomic-write verification. */
export interface AtomicManifestWriteOptions {
  readonly beforeRename?: (tempPath: string, manifestPath: string) => void | Promise<void>;
}

type PathQueue = Map<string, Promise<void>>;

const manifestWriteQueues: PathQueue = new Map();
const eventWriteQueues: PathQueue = new Map();

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function queueByPath<T>(
  queue: PathQueue,
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = resolve(filePath);
  const previous = queue.get(queueKey) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );

  queue.set(queueKey, tail);
  void tail.then(() => {
    if (queue.get(queueKey) === tail) {
      queue.delete(queueKey);
    }
  });

  return result;
}

function privateTempPath(parentDir: string, prefix: string): string {
  return join(parentDir, `.${prefix}.tmp.${process.pid}.${randomBytes(12).toString("hex")}`);
}

async function removeOwnTemp(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) {
      // The artifact remains private at 0600. T-002B owns bounded stale cleanup.
    }
  }
}

async function writeExclusivePrivateFile(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}

async function syncDirectory(dirPath: string): Promise<void> {
  const handle = await open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function corpusKeyBytes(key: string, code: EvalErrorCode): Buffer {
  if (!CORPUS_KEY_PATTERN.test(key)) {
    throw new EvidenceStoreError(code, "Corpus key must be exactly 32 lowercase-hex bytes");
  }
  return Buffer.from(key, "hex");
}

function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    throw new EvidenceStoreError(
      "E_EVAL_UNSAFE_PATH",
      "Run ID must be 1-128 safe ASCII characters and a single path component",
    );
  }
}

function assertNoRawCorpusKeyField(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoRawCorpusKeyField(entry, seen);
    }
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
    if (normalizedKey === "corpuskey") {
      throw new EvidenceStoreError(
        "E_EVAL_PRIVACY",
        "Raw corpus-key fields are forbidden in manifests and event records",
      );
    }
    assertNoRawCorpusKeyField(entry, seen);
  }
}

/** Resolve the content-free evidence root below an explicit Pi agent directory. */
export function resolveEvidenceRoot(piAgentDir: string): string {
  if (piAgentDir.length === 0) {
    throw new EvidenceStoreError("E_EVAL_CONFIG", "PI_AGENT_DIR must not be empty");
  }
  return resolve(piAgentDir, ...EVIDENCE_ROOT_SEGMENTS);
}

/** Resolve a validated run root below the canonical evidence root. */
export function resolveRunRoot(piAgentDir: string, runId: string): string {
  assertSafeRunId(runId);
  const evidenceRoot = resolveEvidenceRoot(piAgentDir);
  const runRoot = resolve(evidenceRoot, runId);

  if (dirname(runRoot) !== evidenceRoot) {
    throw new EvidenceStoreError("E_EVAL_UNSAFE_PATH", "Run root escaped the evidence root");
  }
  return runRoot;
}

// ── Module-private directory/file operations ─────────────────────────────────

/**
 * Create or harden one directory to mode `0700`.
 * This is module-private to prevent external callers from using raw paths.
 */
async function ensurePrivateDir(dirPath: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  await chmod(dirPath, 0o700);
}

/**
 * Create or harden one file to mode `0600`.
 * This is module-private to prevent external callers from using raw paths.
 */
async function ensurePrivateFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
  await syncDirectory(dirname(filePath));
}

// ── Public API (capability-based only) ──────────────────────────────────────

/** Generate a cryptographically random 32-byte lowercase-hex corpus key. */
export function generateCorpusKey(): string {
  return randomBytes(32).toString("hex");
}

/** Return the unkeyed verification digest stored in the run manifest. */
export function corpusKeyDigest(key: string): string {
  return createHash("sha256").update(corpusKeyBytes(key, "E_EVAL_SCHEMA")).digest("hex");
}

/** Compute HMAC-SHA256 over source bytes using the decoded 32-byte corpus key. */
export function hmacDigest(key: string, sourceBytes: Uint8Array): string {
  return createHmac("sha256", corpusKeyBytes(key, "E_EVAL_SCHEMA"))
    .update(sourceBytes)
    .digest("hex");
}

async function readPersistedCorpusKey(keyPath: string): Promise<string | undefined> {
  try {
    await chmod(keyPath, 0o600);
    const key = await readFile(keyPath, "utf8");
    corpusKeyBytes(key, "E_EVAL_INTEGRITY");
    return key;
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Load the run's private corpus key, or publish one atomically without overwrite.
 * Accepts a runtime-validated PreManifestRun.
 */
export async function loadOrCreateCorpusKey(preRun: PreManifestRun): Promise<string> {
  const runRoot = preManifestRunPath(preRun);
  await ensurePrivateDir(runRoot);
  const keyPath = join(runRoot, CORPUS_KEY_FILENAME);
  const existing = await readPersistedCorpusKey(keyPath);
  if (existing !== undefined) {
    return existing;
  }

  const generated = generateCorpusKey();
  const tempPath = privateTempPath(runRoot, CORPUS_KEY_FILENAME);
  try {
    await writeExclusivePrivateFile(tempPath, generated);
    try {
      await link(tempPath, keyPath);
      await chmod(keyPath, 0o600);
      await syncDirectory(runRoot);
      return generated;
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      const concurrentlyCreated = await readPersistedCorpusKey(keyPath);
      if (concurrentlyCreated === undefined) {
        throw new EvidenceStoreError(
          "E_EVAL_INTEGRITY",
          "Corpus key disappeared during concurrent creation",
        );
      }
      await syncDirectory(runRoot);
      return concurrentlyCreated;
    }
  } finally {
    await removeOwnTemp(tempPath);
  }
}

/**
 * Write a canonical manifest through a same-directory atomic rename.
 * Accepts a PreManifestRun (for init) or SafeRun (for post-init).
 * Fixed key/manifest artifacts take no caller path.
 */
export function atomicManifestWrite(
  run: PreManifestRun | SafeRun,
  manifest: RunManifest,
  options: AtomicManifestWriteOptions = {},
): Promise<void> {
  const dirPath =
    "__brand" in run && run.__brand === "SafeRun"
      ? safeRunPath(run as SafeRun, "")
      : preManifestRunPath(run as PreManifestRun);

  const manifestPath = join(dirPath, "manifest.json");
  return queueByPath(manifestWriteQueues, manifestPath, async () => {
    assertNoRawCorpusKeyField(manifest);
    await ensurePrivateDir(dirPath);
    const content = canonicalJson(manifest);
    const tempPath = privateTempPath(dirPath, "manifest");

    try {
      await writeExclusivePrivateFile(tempPath, content);
      await options.beforeRename?.(tempPath, manifestPath);
      await rename(tempPath, manifestPath);
      await chmod(manifestPath, 0o600);
      await syncDirectory(dirPath);
    } catch (error: unknown) {
      await removeOwnTemp(tempPath);
      throw error;
    }
  });
}

interface ExistingEventIndex {
  readonly recordsById: ReadonlyMap<string, string>;
  readonly needsSeparator: boolean;
}

interface ValidatedEventRecord extends Record<string, unknown> {
  readonly eventId: string;
  readonly timestamp: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly failed?: boolean;
  readonly error?: string;
}

function validateEventRecord(
  value: unknown,
  code: EvalErrorCode,
  context: string,
): asserts value is ValidatedEventRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvidenceStoreError(code, `${context} is not an object`);
  }

  const record = value as Record<string, unknown>;
  const recordId = typeof record.eventId === "string" ? record.eventId : undefined;
  if (recordId === undefined || recordId.trim().length === 0) {
    throw new EvidenceStoreError(code, `${context} has no stable eventId`);
  }
  if (
    typeof record.timestamp !== "string" ||
    typeof record.type !== "string" ||
    record.data === null ||
    typeof record.data !== "object" ||
    Array.isArray(record.data) ||
    (record.failed !== undefined && typeof record.failed !== "boolean") ||
    (record.error !== undefined && typeof record.error !== "string")
  ) {
    throw new EvidenceStoreError(
      code,
      `${context} does not match the evidence-event contract`,
      recordId,
    );
  }
}

function parseEventRecord(
  line: string,
  lineNumber: number,
): { eventId: string; canonical: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", `Malformed JSONL event at line ${lineNumber}`);
  }

  const context = `Event at line ${lineNumber}`;
  validateEventRecord(parsed, "E_EVAL_INTEGRITY", context);
  const record = parsed;

  let canonical: string;
  try {
    assertNoRawCorpusKeyField(record);
    canonical = canonicalJson(record);
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) {
      throw error;
    }
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      `Event at line ${lineNumber} is not canonicalizable`,
      record.eventId,
    );
  }

  if (line !== canonical) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      `Event at line ${lineNumber} is not canonical JSON`,
      record.eventId,
    );
  }
  return { eventId: record.eventId, canonical };
}

async function loadExistingEventIndex(eventsPath: string): Promise<ExistingEventIndex> {
  let bytes: Buffer;
  try {
    bytes = await readFile(eventsPath);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return { recordsById: new Map(), needsSeparator: false };
    }
    throw error;
  }

  let content: string;
  try {
    content = UTF8_DECODER.decode(bytes);
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Events file is not valid UTF-8");
  }

  if (content.length === 0) {
    return { recordsById: new Map(), needsSeparator: false };
  }

  const recordsById = new Map<string, string>();
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }

  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", `Blank JSONL event at line ${index + 1}`);
    }
    const record = parseEventRecord(line, index + 1);
    if (recordsById.has(record.eventId)) {
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        `Duplicate eventId in existing JSONL at line ${index + 1}`,
        record.eventId,
      );
    }
    recordsById.set(record.eventId, record.canonical);
  }

  return {
    recordsById,
    needsSeparator: !content.endsWith("\n"),
  };
}

/**
 * Load stable event IDs, failing closed if the existing JSONL is corrupt.
 * Accepts a SafeRun and a validated relative artifact path.
 */
export function loadExistingEventIds(safeRun: SafeRun, relativePath: string): Promise<Set<string>> {
  const eventsPath = safeRunPath(safeRun, relativePath);
  return queueByPath(eventWriteQueues, eventsPath, async () => {
    const index = await loadExistingEventIndex(eventsPath);
    return new Set(index.recordsById.keys());
  });
}

/**
 * Append one canonical event with resume-safe, in-process idempotency.
 * Accepts a SafeRun and a validated relative artifact path.
 */
export function appendEvent(
  safeRun: SafeRun,
  relativePath: string,
  event: EvidenceEvent,
): Promise<void> {
  const eventsPath = safeRunPath(safeRun, relativePath);
  return queueByPath(eventWriteQueues, eventsPath, async () => {
    validateEventRecord(event, "E_EVAL_SCHEMA", "Evidence event");
    assertNoRawCorpusKeyField(event);
    const canonicalEvent = canonicalJson(event);

    await ensurePrivateDir(dirname(eventsPath));
    await ensurePrivateFile(eventsPath);
    const index = await loadExistingEventIndex(eventsPath);
    const existing = index.recordsById.get(event.eventId);
    if (existing !== undefined) {
      if (existing === canonicalEvent) {
        return;
      }
      throw new EvidenceStoreError(
        "E_EVAL_INTEGRITY",
        "Existing eventId has different canonical content",
        event.eventId,
      );
    }

    const prefix = index.needsSeparator ? "\n" : "";
    const handle = await open(eventsPath, "a", 0o600);
    try {
      await handle.writeFile(`${prefix}${canonicalEvent}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(eventsPath, 0o600);
    await syncDirectory(dirname(eventsPath));
  });
}
