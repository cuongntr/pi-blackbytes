/** Evaluation-only orchestration for the T-017 formal sampling sequence. */
import { Buffer } from "node:buffer";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalDigest, canonicalJson } from "./canonical-json.js";
import {
  atomicManifestWrite,
  corpusKeyDigest,
  hmacDigest,
  loadOrCreateCorpusKey,
  resolveRunRoot,
} from "./evidence-store.js";
import {
  createDisposableSessionCopy,
  deriveSelectedSessionCatalogFromPersistedCopy,
  inventoryCorpus,
} from "./inventory.js";
import {
  ensurePrivateRunRoot,
  openSafeRun,
  safeRunFileExists,
  safeRunPublishExclusiveFile,
  safeRunReadFile,
  safeRunReaddir,
} from "./path-safety.js";
import {
  assertLockImmutable,
  validateSamplingProtocolLock,
  validateTargetSelectionRecord,
} from "./protocol.js";
import { verifyT009BIfPresent } from "./provider-runner.js";
import {
  inventoryDigest,
  isEligibleInventoryRecord,
  sampleInventory,
  sampleManifestDigest,
  validateSampleManifest,
} from "./sampling.js";
import { createSourceGuard, verifySourceIntegrity } from "./source-guard.js";
import { EvidenceStoreError, SCHEMA_VERSION } from "./types.js";
import type { InventoryRecord, RunManifest, SamplingResult } from "./types.js";

const LOCK_FILE = "sampling.lock.json";
const SAMPLE_FILE = "sample.json";
const TARGET_FILE = "target-selection.json";
const INVENTORY_DIRECTORY = "inventory";
const PRIVATE_DIRECTORY = "private";
const DIGEST = /^[0-9a-f]{64}$/;
const ROOT_ANCHOR_DOMAIN = "pi-blackbytes:context-pruning:source-root:v1\0";
const DISPOSITION_AUTH_DOMAIN = "pi-blackbytes:context-pruning:underflow:v1\0";
const TARGET_ANCHOR_AUTH_DOMAIN = "pi-blackbytes:context-pruning:target-anchor:v1\0";
const TARGET_ANCHOR_FILE = `${PRIVATE_DIRECTORY}/target-selection.anchor.json`;

function underflowFile(attemptIndex: number): string {
  return `sampling/attempt-${attemptIndex}-underflow.json`;
}

function terminalUnderflowFile(attemptIndex: number): string {
  return `sampling/attempt-${attemptIndex}-underflow-terminal.json`;
}

function collectionWindowExpired(collectionWindowEndsAt: string): boolean {
  return Date.now() >= Date.parse(collectionWindowEndsAt);
}

type FormalCommand = "init" | "inventory" | "sample" | "select-target" | "verify";
interface Options {
  readonly [key: string]: string | undefined;
}
interface LocalSource {
  readonly corpusId: string;
  readonly path: string;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly record: InventoryRecord;
}

interface PrivateInventoryEvidence {
  readonly root: string;
  readonly rootAnchor: string;
  readonly sources: readonly LocalSource[];
}

interface UnderflowDisposition {
  readonly status: "underflow-pending" | "underflow-hard-stop";
  readonly code: "E_EVAL_INCOMPLETE";
  readonly attemptIndex: number;
  readonly frameSize: number;
  readonly requiredSampleSize: number;
  readonly maxInventoryRefreshes: number;
  readonly collectionWindowEndsAt: string;
  readonly runId: string;
  readonly samplingLockDigest: string;
  readonly inventoryDigest: string;
  readonly dispositionDigest: string;
  readonly authenticationTag: string;
}

interface TargetAnchor {
  readonly schemaVersion: 1;
  readonly targetSelectionDigest: string;
  readonly authenticationTag: string;
}
interface InventoryArtifact {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attemptIndex: number;
  readonly samplingLockDigest: string;
  readonly inventoryDigest: string;
  readonly sourceCount: number;
  readonly eligibleFrameSize: number;
  readonly records: readonly InventoryRecord[];
}

function fail(
  code:
    | "E_EVAL_CONFIG"
    | "E_EVAL_SCHEMA"
    | "E_EVAL_INTEGRITY"
    | "E_EVAL_INCOMPLETE"
    | "E_EVAL_UNSAFE_PATH",
  message: string,
): never {
  throw new EvidenceStoreError(code, message);
}

/** Strict command-local parser: options cannot silently change formal evidence. */
function parse(
  args: readonly string[],
  allowed: readonly string[],
  required: readonly string[],
): Options {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === undefined || !allowed.includes(name) || Object.hasOwn(values, name))
      fail("E_EVAL_CONFIG", "Formal command options are duplicated or unsupported");
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      fail("E_EVAL_CONFIG", "Formal command option has no value");
    values[name] = value;
    index += 1;
  }
  for (const name of required)
    if (values[name] === undefined)
      fail("E_EVAL_CONFIG", "Formal command is missing a required option");
  return values;
}

function agentDir(options: Options): string {
  const value =
    options["--pi-agent-dir"] ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  if (value.length === 0) fail("E_EVAL_CONFIG", "PI agent directory is empty");
  return value;
}

async function jsonFile(path: string, context: string): Promise<unknown> {
  try {
    return JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
  } catch {
    fail("E_EVAL_SCHEMA", `${context} cannot be read or parsed`);
  }
}

async function canonicalRunJson(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
  file: string,
): Promise<unknown> {
  const text = (await safeRunReadFile(safeRun, file)).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("E_EVAL_INTEGRITY", "Persisted formal artifact is not JSON");
  }
  if (canonicalJson(value) !== text)
    fail("E_EVAL_INTEGRITY", "Persisted formal artifact is not canonical");
  return value;
}

async function publishImmutable(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
  file: string,
  value: unknown,
): Promise<void> {
  const content = canonicalJson(value);
  if (await safeRunPublishExclusiveFile(safeRun, file, content)) return;
  const existing = (await safeRunReadFile(safeRun, file)).toString("utf8");
  if (existing !== content) fail("E_EVAL_INTEGRITY", "Immutable formal artifact drifted");
}

async function loadLock(safeRun: Awaited<ReturnType<typeof openSafeRun>>) {
  return validateSamplingProtocolLock(await canonicalRunJson(safeRun, LOCK_FILE));
}

async function discover(rootInput: string): Promise<{ root: string; paths: readonly string[] }> {
  let root: string;
  try {
    const stated = await lstat(rootInput);
    if (stated.isSymbolicLink() || !stated.isDirectory())
      fail("E_EVAL_UNSAFE_PATH", "Approved source root is not a regular directory");
    root = await realpath(rootInput);
  } catch (error) {
    if (error instanceof EvidenceStoreError) throw error;
    fail("E_EVAL_UNSAFE_PATH", "Approved source root cannot be resolved");
  }
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      fail("E_EVAL_UNSAFE_PATH", "Approved source root cannot be traversed");
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stats = await lstat(path).catch(() =>
        fail("E_EVAL_UNSAFE_PATH", "Approved source entry cannot be inspected"),
      );
      if (stats.isSymbolicLink()) fail("E_EVAL_UNSAFE_PATH", "Approved source contains a symlink");
      if (stats.isDirectory()) await walk(path);
      else if (stats.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  }
  await walk(root);
  found.sort((left, right) => left.localeCompare(right));
  return { root, paths: Object.freeze(found) };
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index]))
    fail("E_EVAL_INTEGRITY", `${label} fields are invalid`);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0)
    fail("E_EVAL_INTEGRITY", `${label} is invalid`);
  return value as number;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value))
    fail("E_EVAL_INTEGRITY", `${label} is invalid`);
  return value;
}

function validArtifact(value: unknown, expectedIndex?: number): InventoryArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("E_EVAL_INTEGRITY", "Inventory artifact is invalid");
  const item = value as Record<string, unknown>;
  exactFields(
    item,
    [
      "attemptIndex",
      "eligibleFrameSize",
      "inventoryDigest",
      "records",
      "runId",
      "samplingLockDigest",
      "schemaVersion",
      "sourceCount",
    ],
    "Inventory artifact",
  );
  if (
    item.schemaVersion !== SCHEMA_VERSION ||
    typeof item.runId !== "string" ||
    item.runId.length === 0
  )
    fail("E_EVAL_INTEGRITY", "Inventory artifact values are invalid");
  const attemptIndex = nonnegativeInteger(item.attemptIndex, "Inventory attempt index");
  if (expectedIndex !== undefined && attemptIndex !== expectedIndex)
    fail("E_EVAL_INTEGRITY", "Inventory filename does not bind its attempt index");
  if (!Array.isArray(item.records)) fail("E_EVAL_INTEGRITY", "Inventory records are invalid");
  let computedDigest: string;
  let eligibleFrameSize: number;
  try {
    computedDigest = inventoryDigest(item.records as InventoryRecord[]);
    eligibleFrameSize = (item.records as InventoryRecord[]).filter((record) =>
      isEligibleInventoryRecord(record, 20),
    ).length;
  } catch {
    fail("E_EVAL_INTEGRITY", "Inventory records are invalid");
  }
  const sourceCount = nonnegativeInteger(item.sourceCount, "Inventory source count");
  if (
    sourceCount !== item.records.length ||
    nonnegativeInteger(item.eligibleFrameSize, "Inventory eligible frame size") !==
      eligibleFrameSize ||
    digest(item.inventoryDigest, "Inventory digest") !== computedDigest
  )
    fail("E_EVAL_INTEGRITY", "Inventory summary does not match records");
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    runId: item.runId,
    attemptIndex,
    samplingLockDigest: digest(item.samplingLockDigest, "Sampling lock digest"),
    inventoryDigest: computedDigest,
    sourceCount,
    eligibleFrameSize,
    records: Object.freeze([...item.records] as InventoryRecord[]),
  });
}

async function attempts(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
): Promise<readonly number[]> {
  let entries: Awaited<ReturnType<typeof safeRunReaddir>>;
  try {
    entries = await safeRunReaddir(safeRun, INVENTORY_DIRECTORY);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return [];
    // safeRunReaddir rejects a missing directory while walking its components.
    if (error instanceof EvidenceStoreError && error.message === "Path component is not accessible")
      return [];
    if (error instanceof EvidenceStoreError) throw error;
    fail("E_EVAL_INTEGRITY", "Inventory directory cannot be inspected");
  }
  const indices = entries
    .map((entry) => {
      const match = entry.isFile ? /^attempt-(0|[1-9]\d*)\.json$/.exec(entry.name) : null;
      if (match === null)
        fail("E_EVAL_INTEGRITY", "Inventory directory contains an invalid artifact");
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index))
        fail("E_EVAL_INTEGRITY", "Inventory attempt index is invalid");
      return index;
    })
    .sort((left, right) => left - right);
  if (new Set(indices).size !== indices.length || indices.some((value, index) => value !== index))
    fail("E_EVAL_INTEGRITY", "Inventory attempt sequence is invalid");
  return Object.freeze(indices);
}

async function inventoryAt(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
  index: number,
): Promise<InventoryArtifact> {
  return validArtifact(
    await canonicalRunJson(safeRun, `${INVENTORY_DIRECTORY}/attempt-${index}.json`),
    index,
  );
}

async function latestInventory(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
): Promise<InventoryArtifact> {
  const indices = await attempts(safeRun);
  const index = indices.at(-1);
  if (index === undefined) fail("E_EVAL_INCOMPLETE", "No inventory attempt is available");
  return inventoryAt(safeRun, index);
}

function assertInventoryBinding(
  inventory: InventoryArtifact,
  lock: Awaited<ReturnType<typeof loadLock>>,
): void {
  if (
    inventory.runId !== lock.runId ||
    inventory.samplingLockDigest !== canonicalDigest(lock) ||
    inventory.inventoryDigest !== inventoryDigest(inventory.records)
  )
    fail("E_EVAL_INTEGRITY", "Inventory does not bind sampling lock");
}

function localSources(value: unknown): PrivateInventoryEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("E_EVAL_INTEGRITY", "Private inventory evidence is invalid");
  const input = value as Record<string, unknown>;
  exactFields(input, ["root", "rootAnchor", "sources"], "Private inventory evidence");
  if (typeof input.root !== "string" || input.root.length === 0 || !Array.isArray(input.sources))
    fail("E_EVAL_INTEGRITY", "Private inventory evidence is invalid");
  const sources = input.sources.map((source): LocalSource => {
    if (source === null || typeof source !== "object" || Array.isArray(source))
      fail("E_EVAL_INTEGRITY", "Private source evidence is invalid");
    const item = source as Record<string, unknown>;
    exactFields(
      item,
      ["afterDigest", "beforeDigest", "corpusId", "path", "record"],
      "Private source evidence",
    );
    if (typeof item.path !== "string" || item.path.length === 0)
      fail("E_EVAL_INTEGRITY", "Private source evidence is invalid");
    let recordDigest: string;
    try {
      recordDigest = inventoryDigest([item.record as InventoryRecord]);
    } catch {
      fail("E_EVAL_INTEGRITY", "Private source record is invalid");
    }
    if (
      recordDigest.length === 0 ||
      digest(item.corpusId, "Private corpus ID") !== (item.record as InventoryRecord).corpusId
    )
      fail("E_EVAL_INTEGRITY", "Private source evidence is invalid");
    return Object.freeze({
      corpusId: item.corpusId as string,
      path: item.path,
      beforeDigest: digest(item.beforeDigest, "Private before digest"),
      afterDigest: digest(item.afterDigest, "Private after digest"),
      record: item.record as InventoryRecord,
    });
  });
  return Object.freeze({
    root: input.root,
    rootAnchor: digest(input.rootAnchor, "Private root anchor"),
    sources: Object.freeze(sources),
  });
}

function rootAnchor(key: string, root: string, rootStats: { dev: number; ino: number }): string {
  return hmacDigest(
    key,
    Buffer.from(`${ROOT_ANCHOR_DOMAIN}${root}\0${rootStats.dev}\0${rootStats.ino}`, "utf8"),
  );
}

function underflowUnsigned(
  result: Exclude<SamplingResult, { readonly status: "frozen" }>,
  inventory: InventoryArtifact,
  lockDigest: string,
): Omit<UnderflowDisposition, "dispositionDigest" | "authenticationTag"> {
  return {
    ...result,
    runId: inventory.runId,
    samplingLockDigest: lockDigest,
    inventoryDigest: inventory.inventoryDigest,
  };
}

function stableDispositionNow(
  status: UnderflowDisposition["status"],
  collectionWindowEndsAt: string,
): Date {
  const endsAt = Date.parse(collectionWindowEndsAt);
  return new Date(status === "underflow-pending" ? endsAt - 1 : endsAt);
}

function dispositionAuthentication(key: string, unsigned: object): string {
  return hmacDigest(
    key,
    Buffer.from(`${DISPOSITION_AUTH_DOMAIN}${canonicalJson(unsigned)}`, "utf8"),
  );
}

async function loadDisposition(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
  inventory: InventoryArtifact,
  lock: Awaited<ReturnType<typeof loadLock>>,
  file = underflowFile(inventory.attemptIndex),
): Promise<UnderflowDisposition> {
  const value = await canonicalRunJson(safeRun, file);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("E_EVAL_INTEGRITY", "Sampling disposition is invalid");
  const item = value as Record<string, unknown>;
  exactFields(
    item,
    [
      "attemptIndex",
      "authenticationTag",
      "code",
      "collectionWindowEndsAt",
      "dispositionDigest",
      "frameSize",
      "inventoryDigest",
      "maxInventoryRefreshes",
      "requiredSampleSize",
      "runId",
      "samplingLockDigest",
      "status",
    ],
    "Sampling disposition",
  );
  if (
    (item.status !== "underflow-pending" && item.status !== "underflow-hard-stop") ||
    item.code !== "E_EVAL_INCOMPLETE" ||
    item.runId !== lock.runId ||
    item.samplingLockDigest !== canonicalDigest(lock) ||
    item.inventoryDigest !== inventory.inventoryDigest ||
    item.attemptIndex !== inventory.attemptIndex
  )
    fail("E_EVAL_INTEGRITY", "Sampling disposition is invalid");
  const status = item.status;
  const result = sampleInventory({
    samplingLock: lock,
    inventoryRecords: inventory.records,
    attemptIndex: inventory.attemptIndex,
    now: stableDispositionNow(status, lock.collectionWindowEndsAt),
  });
  if (result.status === "frozen" || result.status !== status)
    fail("E_EVAL_INTEGRITY", "Sampling disposition does not recompute");
  const unsigned = underflowUnsigned(result, inventory, canonicalDigest(lock));
  if (
    canonicalJson(unsigned) !==
    canonicalJson({
      status: item.status,
      code: item.code,
      attemptIndex: item.attemptIndex,
      frameSize: item.frameSize,
      requiredSampleSize: item.requiredSampleSize,
      maxInventoryRefreshes: item.maxInventoryRefreshes,
      collectionWindowEndsAt: item.collectionWindowEndsAt,
      runId: item.runId,
      samplingLockDigest: item.samplingLockDigest,
      inventoryDigest: item.inventoryDigest,
    })
  )
    fail("E_EVAL_INTEGRITY", "Sampling disposition summary does not recompute");
  const dispositionDigest = canonicalDigest(unsigned);
  const key = (await safeRunReadFile(safeRun, "corpus.key")).toString("utf8");
  if (
    item.dispositionDigest !== dispositionDigest ||
    item.authenticationTag !== dispositionAuthentication(key, unsigned)
  )
    fail("E_EVAL_INTEGRITY", "Sampling disposition authentication failed");
  return Object.freeze({
    ...unsigned,
    dispositionDigest,
    authenticationTag: item.authenticationTag as string,
  });
}

async function runInit(options: Options): Promise<object> {
  const runId = options["--run-id"]!;
  const config = await jsonFile(options["--config"]!, "Sampling config");
  const lock = validateSamplingProtocolLock(config);
  if (lock.runId !== runId)
    fail("E_EVAL_INTEGRITY", "Sampling lock run ID does not bind the command");
  const piAgentDir = agentDir(options);
  let safeRun: Awaited<ReturnType<typeof openSafeRun>> | undefined;
  try {
    safeRun = await openSafeRun(piAgentDir, runId);
  } catch {
    // A pre-existing manifest must never be overwritten merely because it is invalid.
    try {
      await lstat(join(resolveRunRoot(piAgentDir, runId), "manifest.json"));
      fail("E_EVAL_INTEGRITY", "Existing run manifest cannot be opened safely");
    } catch (error: unknown) {
      if (error instanceof EvidenceStoreError) throw error;
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      )
        fail("E_EVAL_INTEGRITY", "Existing run manifest cannot be inspected safely");
    }
  }
  if (safeRun !== undefined) {
    assertLockImmutable(await canonicalRunJson(safeRun, LOCK_FILE), lock);
    return { lockDigest: canonicalDigest(lock) };
  }
  const preRun = await ensurePrivateRunRoot(piAgentDir, runId);
  const corpusKey = await loadOrCreateCorpusKey(preRun);
  const manifest: RunManifest = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    createdAt: new Date().toISOString(),
    corpusKeyDigest: corpusKeyDigest(corpusKey),
    eventCount: 0,
  };
  await atomicManifestWrite(preRun, manifest);
  safeRun = await openSafeRun(piAgentDir, runId);
  await publishImmutable(safeRun, LOCK_FILE, lock);
  return { lockDigest: canonicalDigest(lock) };
}

async function runInventory(options: Options): Promise<object> {
  const safeRun = await openSafeRun(agentDir(options), options["--run-id"]!);
  const lock = await loadLock(safeRun);
  const seen = await attempts(safeRun);
  const attemptIndex = seen.length;
  if (attemptIndex > 0 && collectionWindowExpired(lock.collectionWindowEndsAt))
    fail(
      "E_EVAL_INCOMPLETE",
      "Inventory refresh window expired; sample must terminalize pending underflow",
    );
  if (attemptIndex > lock.maxInventoryRefreshes)
    fail("E_EVAL_INCOMPLETE", "Inventory refresh limit was reached");
  if (await safeRunFileExists(safeRun, SAMPLE_FILE))
    fail("E_EVAL_INTEGRITY", "Frozen samples cannot accept another inventory attempt");
  if (attemptIndex > 0) {
    const predecessor = await inventoryAt(safeRun, attemptIndex - 1);
    const disposition = await loadDisposition(safeRun, predecessor, lock);
    if (disposition.status !== "underflow-pending")
      fail("E_EVAL_INCOMPLETE", "Inventory refresh requires a pending underflow disposition");
  }
  const { root, paths } = await discover(options["--source-root"]!);
  const rootStats = await stat(root).catch(() =>
    fail("E_EVAL_UNSAFE_PATH", "Approved source root cannot be inspected"),
  );
  if (!rootStats.isDirectory()) fail("E_EVAL_UNSAFE_PATH", "Approved source root is unsafe");
  const corpusKey = (await safeRunReadFile(safeRun, "corpus.key")).toString("utf8");
  const anchoredRoot = rootAnchor(corpusKey, root, rootStats);
  if (attemptIndex > 0) {
    const first = localSources(
      await canonicalRunJson(safeRun, `${PRIVATE_DIRECTORY}/inventory-attempt-0.json`),
    );
    if (first.rootAnchor !== anchoredRoot)
      fail("E_EVAL_INTEGRITY", "Inventory refresh changed its approved source root");
  }
  const guards = await Promise.all(paths.map((path) => createSourceGuard(path, corpusKey)));
  const records = await inventoryCorpus(paths, corpusKey);
  if (records.length !== paths.length)
    fail("E_EVAL_INTEGRITY", "Inventory source count changed during scan");
  const evidence = await Promise.all(guards.map((guard) => verifySourceIntegrity(guard)));
  if (
    records.some(
      (record, index) =>
        record.sourceDigest !== guards[index]?.before.digest ||
        record.sourceDigest !== evidence[index]?.digest,
    )
  )
    fail("E_EVAL_INTEGRITY", "Inventory source changed during scan");
  const artifact: InventoryArtifact = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    runId: lock.runId,
    attemptIndex,
    samplingLockDigest: canonicalDigest(lock),
    inventoryDigest: inventoryDigest(records),
    sourceCount: records.length,
    eligibleFrameSize: records.filter((record) =>
      isEligibleInventoryRecord(record, lock.longSessionMinRequests),
    ).length,
    records,
  });
  const local: PrivateInventoryEvidence = Object.freeze({
    root,
    rootAnchor: anchoredRoot,
    sources: Object.freeze(
      records.map((record, index) =>
        Object.freeze({
          corpusId: record.corpusId,
          path: paths[index]!,
          beforeDigest: guards[index]!.before.digest,
          afterDigest: evidence[index]!.digest,
          record,
        }),
      ),
    ),
  });
  await publishImmutable(
    safeRun,
    `${PRIVATE_DIRECTORY}/inventory-attempt-${attemptIndex}.json`,
    local,
  );
  await publishImmutable(safeRun, `${INVENTORY_DIRECTORY}/attempt-${attemptIndex}.json`, artifact);
  return {
    attemptIndex,
    inventoryDigest: artifact.inventoryDigest,
    sourceCount: artifact.sourceCount,
    eligibleFrameSize: artifact.eligibleFrameSize,
  };
}

async function verifySources(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
  artifact: InventoryArtifact,
): Promise<{ local: PrivateInventoryEvidence; records: readonly InventoryRecord[] }> {
  const local = localSources(
    await canonicalRunJson(
      safeRun,
      `${PRIVATE_DIRECTORY}/inventory-attempt-${artifact.attemptIndex}.json`,
    ),
  );
  if (
    local.sources.length !== artifact.records.length ||
    local.sources.length !== artifact.sourceCount
  )
    fail("E_EVAL_INTEGRITY", "Private inventory evidence does not bind inventory");
  const discovered = await discover(local.root).catch((error: unknown) => {
    if (error instanceof EvidenceStoreError) throw error;
    fail("E_EVAL_INTEGRITY", "Approved source root is unavailable");
  });
  const rootStat = await lstat(discovered.root).catch(() =>
    fail("E_EVAL_INTEGRITY", "Approved source root is unavailable"),
  );
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail("E_EVAL_INTEGRITY", "Approved source root is unsafe");
  const key = (await safeRunReadFile(safeRun, "corpus.key")).toString("utf8");
  if (
    local.root !== discovered.root ||
    local.rootAnchor !== rootAnchor(key, discovered.root, rootStat)
  )
    fail("E_EVAL_INTEGRITY", "Approved source root identity changed");
  const paths = local.sources.map((source) => source.path);
  if (
    discovered.paths.length !== paths.length ||
    discovered.paths.some((path, index) => path !== paths[index])
  )
    fail("E_EVAL_INTEGRITY", "Approved source path set changed");
  const guards = await Promise.all(paths.map((path) => createSourceGuard(path, key)));
  const after = await Promise.all(guards.map((guard) => verifySourceIntegrity(guard)));
  const rehydrated = await inventoryCorpus(paths, key);
  if (rehydrated.length !== local.sources.length)
    fail("E_EVAL_INTEGRITY", "Persisted source inventory changed");
  for (const [index, source] of local.sources.entries()) {
    const record = artifact.records[index]!;
    const current = rehydrated[index];
    if (
      current === undefined ||
      source.corpusId !== record.corpusId ||
      source.beforeDigest !== guards[index]?.before.digest ||
      source.afterDigest !== after[index]?.digest ||
      record.sourceDigest !== source.beforeDigest ||
      canonicalJson(source.record) !== canonicalJson(record) ||
      canonicalJson(current) !== canonicalJson(source.record) ||
      current.corpusId !== source.corpusId
    )
      fail("E_EVAL_INTEGRITY", "Persisted source evidence changed");
  }
  return Object.freeze({ local, records: rehydrated });
}

async function selectedCopies(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
  entries: readonly { corpusId: string }[],
): Promise<void> {
  const listing = await safeRunReaddir(safeRun, "copied-session-descriptors");
  const expected = new Set(entries.map((entry) => `${entry.corpusId}.json`));
  if (
    listing.length !== expected.size ||
    listing.some((entry) => !entry.isFile || !expected.has(entry.name))
  )
    fail("E_EVAL_INTEGRITY", "Frozen sample copy set is incomplete");
  for (const entry of entries)
    await deriveSelectedSessionCatalogFromPersistedCopy(safeRun, entry.corpusId);
}

async function createOrResumeSelectedCopies(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
  entries: readonly { corpusId: string }[],
  byId: ReadonlyMap<string, InventoryRecord>,
): Promise<void> {
  for (const entry of entries) {
    const descriptor = `copied-session-descriptors/${entry.corpusId}.json`;
    if (await safeRunFileExists(safeRun, descriptor)) {
      await deriveSelectedSessionCatalogFromPersistedCopy(safeRun, entry.corpusId);
      continue;
    }
    const record = byId.get(entry.corpusId);
    if (record === undefined) fail("E_EVAL_INTEGRITY", "Selected inventory record is absent");
    const copy = await createDisposableSessionCopy(record, safeRun);
    const validation = await (await import("./inventory.js")).validateDisposableSessionCopy(copy);
    if (validation.status !== "matched")
      fail("E_EVAL_INTEGRITY", "Selected disposable copy did not validate");
  }
  await selectedCopies(safeRun, entries);
}

async function runSample(options: Options): Promise<object> {
  const safeRun = await openSafeRun(agentDir(options), options["--run-id"]!);
  const lock = await loadLock(safeRun);
  const inventory = await latestInventory(safeRun);
  assertInventoryBinding(inventory, lock);
  const verified = await verifySources(safeRun, inventory);
  if (await safeRunFileExists(safeRun, SAMPLE_FILE)) {
    const manifest = validateSampleManifest(await canonicalRunJson(safeRun, SAMPLE_FILE));
    const recomputed = sampleInventory({
      samplingLock: lock,
      inventoryRecords: inventory.records,
      attemptIndex: inventory.attemptIndex,
      now: lock.collectionWindowEndsAt,
    });
    if (
      manifest.runId !== lock.runId ||
      manifest.samplingLockDigest !== canonicalDigest(lock) ||
      manifest.inventoryDigest !== inventory.inventoryDigest ||
      manifest.attemptIndex !== inventory.attemptIndex ||
      recomputed.status !== "frozen" ||
      canonicalJson(recomputed.manifest) !== canonicalJson(manifest)
    )
      fail("E_EVAL_INTEGRITY", "Frozen sample does not exactly recompute from its inventory");
    await selectedCopies(safeRun, manifest.entries);
    return { status: "frozen", sampleDigest: sampleManifestDigest(manifest) };
  }
  const existingUnderflow = underflowFile(inventory.attemptIndex);
  if (await safeRunFileExists(safeRun, existingUnderflow)) {
    const disposition = await loadDisposition(safeRun, inventory, lock);
    if (
      disposition.status !== "underflow-pending" ||
      !collectionWindowExpired(lock.collectionWindowEndsAt)
    )
      return disposition;
    const terminalFile = terminalUnderflowFile(inventory.attemptIndex);
    const result = sampleInventory({
      samplingLock: lock,
      inventoryRecords: inventory.records,
      attemptIndex: inventory.attemptIndex,
      now: new Date(),
    });
    if (result.status !== "underflow-hard-stop")
      fail("E_EVAL_INTEGRITY", "Pending underflow did not terminalize at collection-window expiry");
    const unsigned = underflowUnsigned(result, inventory, canonicalDigest(lock));
    const key = (await safeRunReadFile(safeRun, "corpus.key")).toString("utf8");
    const terminal: UnderflowDisposition = Object.freeze({
      ...unsigned,
      dispositionDigest: canonicalDigest(unsigned),
      authenticationTag: dispositionAuthentication(key, unsigned),
    });
    await publishImmutable(safeRun, terminalFile, terminal);
    return await loadDisposition(safeRun, inventory, lock, terminalFile);
  }
  const result = sampleInventory({
    samplingLock: lock,
    inventoryRecords: inventory.records,
    attemptIndex: inventory.attemptIndex,
    now: new Date(),
  });
  if (result.status !== "frozen") {
    const unsigned = underflowUnsigned(result, inventory, canonicalDigest(lock));
    const key = (await safeRunReadFile(safeRun, "corpus.key")).toString("utf8");
    const disposition: UnderflowDisposition = Object.freeze({
      ...unsigned,
      dispositionDigest: canonicalDigest(unsigned),
      authenticationTag: dispositionAuthentication(key, unsigned),
    });
    await publishImmutable(safeRun, existingUnderflow, disposition);
    return disposition;
  }
  const byId = new Map(verified.records.map((record) => [record.corpusId, record]));
  await createOrResumeSelectedCopies(safeRun, result.manifest.entries, byId);
  await publishImmutable(safeRun, SAMPLE_FILE, result.manifest);
  return { status: "frozen", sampleDigest: sampleManifestDigest(result.manifest) };
}

async function targetAnchor(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
): Promise<TargetAnchor> {
  const value = await canonicalRunJson(safeRun, TARGET_ANCHOR_FILE);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("E_EVAL_INTEGRITY", "Target selection anchor is invalid");
  const item = value as Record<string, unknown>;
  exactFields(
    item,
    ["authenticationTag", "schemaVersion", "targetSelectionDigest"],
    "Target anchor",
  );
  if (item.schemaVersion !== SCHEMA_VERSION)
    fail("E_EVAL_INTEGRITY", "Target selection anchor is invalid");
  const targetSelectionDigest = digest(item.targetSelectionDigest, "Target selection digest");
  const key = (await safeRunReadFile(safeRun, "corpus.key")).toString("utf8");
  const unsigned = { schemaVersion: SCHEMA_VERSION, targetSelectionDigest };
  if (
    item.authenticationTag !==
    hmacDigest(key, Buffer.from(`${TARGET_ANCHOR_AUTH_DOMAIN}${canonicalJson(unsigned)}`, "utf8"))
  )
    fail("E_EVAL_INTEGRITY", "Target selection anchor authentication failed");
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    targetSelectionDigest,
    authenticationTag: item.authenticationTag as string,
  });
}

async function publishTargetAnchor(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
  targetSelectionDigest: string,
): Promise<void> {
  const key = (await safeRunReadFile(safeRun, "corpus.key")).toString("utf8");
  const unsigned = { schemaVersion: SCHEMA_VERSION, targetSelectionDigest };
  await publishImmutable(safeRun, TARGET_ANCHOR_FILE, {
    ...unsigned,
    authenticationTag: hmacDigest(
      key,
      Buffer.from(`${TARGET_ANCHOR_AUTH_DOMAIN}${canonicalJson(unsigned)}`, "utf8"),
    ),
  });
  const anchor = await targetAnchor(safeRun);
  if (anchor.targetSelectionDigest !== targetSelectionDigest)
    fail("E_EVAL_INTEGRITY", "Target selection changed under this run");
}

async function verifyTargetAnchor(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
  target: unknown,
): Promise<void> {
  if (canonicalDigest(target) !== (await targetAnchor(safeRun)).targetSelectionDigest)
    fail("E_EVAL_INTEGRITY", "Target selection does not match its immutable anchor");
}

/** Authenticate the frozen target without opening a corpus or selected-session copy. */
export async function loadVerifiedTargetSelection(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
): Promise<import("./protocol.js").TargetSelectionRecord> {
  const lock = await loadLock(safeRun);
  if (!(await safeRunFileExists(safeRun, TARGET_FILE)))
    fail("E_EVAL_INCOMPLETE", "Viable sampling requires target selection");
  const target = validateTargetSelectionRecord(await canonicalRunJson(safeRun, TARGET_FILE), lock);
  await verifyTargetAnchor(safeRun, target);
  return target;
}

/** Full T-017 viable-state verification for every T-009B planning/execution boundary. */
export async function verifyFrozenT017SampleAndTarget(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
): Promise<import("./protocol.js").TargetSelectionRecord> {
  const lock = await loadLock(safeRun);
  const inventory = await latestInventory(safeRun);
  assertInventoryBinding(inventory, lock);
  await verifySources(safeRun, inventory);
  if (!(await safeRunFileExists(safeRun, SAMPLE_FILE)))
    fail("E_EVAL_INCOMPLETE", "T-009B requires a viable frozen T-017 sample");
  const sample = validateSampleManifest(await canonicalRunJson(safeRun, SAMPLE_FILE));
  const recomputed = sampleInventory({
    samplingLock: lock,
    inventoryRecords: inventory.records,
    attemptIndex: inventory.attemptIndex,
    now: lock.collectionWindowEndsAt,
  });
  if (
    sample.runId !== lock.runId ||
    sample.inventoryDigest !== inventory.inventoryDigest ||
    sample.samplingLockDigest !== canonicalDigest(lock) ||
    recomputed.status !== "frozen" ||
    canonicalJson(recomputed.manifest) !== canonicalJson(sample)
  )
    fail("E_EVAL_INTEGRITY", "T-009B frozen sample no longer verifies");
  await selectedCopies(safeRun, sample.entries);
  const target = await loadVerifiedTargetSelection(safeRun);
  if (
    target.inventoryDigest !== inventory.inventoryDigest ||
    target.sampleDigest !== sampleManifestDigest(sample) ||
    target.samplingLockDigest !== canonicalDigest(lock)
  )
    fail("E_EVAL_INTEGRITY", "T-009B target no longer binds the verified frozen sample");
  return target;
}

/** Authenticate the sole T-017 hard-stop disposition accepted by T-009B N/A. */
export async function verifyT017HardStopDisposition(
  safeRun: Awaited<ReturnType<typeof openSafeRun>>,
  expectedDigest: string,
): Promise<{ readonly dispositionDigest: string }> {
  if (!DIGEST.test(expectedDigest)) fail("E_EVAL_CONFIG", "T-009B hard-stop digest is invalid");
  const lock = await loadLock(safeRun);
  const inventory = await latestInventory(safeRun);
  assertInventoryBinding(inventory, lock);
  await verifySources(safeRun, inventory);
  if (await safeRunFileExists(safeRun, SAMPLE_FILE))
    fail("E_EVAL_INTEGRITY", "T-009B not-applicable is forbidden for a viable frozen T-017 run");
  const terminal = await loadDisposition(
    safeRun,
    inventory,
    lock,
    terminalUnderflowFile(inventory.attemptIndex),
  );
  if (terminal.status !== "underflow-hard-stop" || terminal.dispositionDigest !== expectedDigest)
    fail(
      "E_EVAL_INTEGRITY",
      "T-009B hard-stop disposition does not exactly match --not-applicable",
    );
  return Object.freeze({ dispositionDigest: terminal.dispositionDigest });
}

async function runTarget(options: Options): Promise<object> {
  const safeRun = await openSafeRun(agentDir(options), options["--run-id"]!);
  const lock = await loadLock(safeRun);
  if (!(await safeRunFileExists(safeRun, SAMPLE_FILE)))
    fail("E_EVAL_INCOMPLETE", "Target selection requires a frozen sample");
  const sample = validateSampleManifest(await canonicalRunJson(safeRun, SAMPLE_FILE));
  const inventory = await latestInventory(safeRun);
  assertInventoryBinding(inventory, lock);
  await verifySources(safeRun, inventory);
  const recomputed = sampleInventory({
    samplingLock: lock,
    inventoryRecords: inventory.records,
    attemptIndex: inventory.attemptIndex,
    now: lock.collectionWindowEndsAt,
  });
  if (
    recomputed.status !== "frozen" ||
    canonicalJson(recomputed.manifest) !== canonicalJson(sample)
  )
    fail("E_EVAL_INTEGRITY", "Frozen sample does not exactly recompute from its inventory");
  await selectedCopies(safeRun, sample.entries);
  const target = validateTargetSelectionRecord(
    await jsonFile(options["--target"]!, "Target selection"),
    lock,
  );
  if (
    target.runId !== lock.runId ||
    target.inventoryDigest !== inventory.inventoryDigest ||
    target.sampleDigest !== sampleManifestDigest(sample) ||
    target.samplingLockDigest !== canonicalDigest(lock)
  )
    fail("E_EVAL_INTEGRITY", "Target selection predecessor binding is invalid");
  const targetSelectionDigest = canonicalDigest(target);
  await publishTargetAnchor(safeRun, targetSelectionDigest);
  await publishImmutable(safeRun, TARGET_FILE, target);
  await verifyTargetAnchor(safeRun, target);
  return { targetSelectionDigest };
}

async function runVerify(options: Options): Promise<object> {
  const safeRun = await openSafeRun(agentDir(options), options["--run-id"]!);
  const lock = await loadLock(safeRun);
  const inventory = await latestInventory(safeRun);
  assertInventoryBinding(inventory, lock);
  await verifySources(safeRun, inventory);
  if (await safeRunFileExists(safeRun, SAMPLE_FILE)) {
    const sample = validateSampleManifest(await canonicalRunJson(safeRun, SAMPLE_FILE));
    if (
      sample.runId !== lock.runId ||
      sample.inventoryDigest !== inventory.inventoryDigest ||
      sample.samplingLockDigest !== canonicalDigest(lock)
    )
      fail("E_EVAL_INTEGRITY", "Sample binding is invalid");
    const recomputed = sampleInventory({
      samplingLock: lock,
      inventoryRecords: inventory.records,
      attemptIndex: inventory.attemptIndex,
      now: lock.collectionWindowEndsAt,
    });
    if (
      recomputed.status !== "frozen" ||
      canonicalJson(recomputed.manifest) !== canonicalJson(sample)
    )
      fail("E_EVAL_INTEGRITY", "Frozen sample does not exactly recompute from its inventory");
    await selectedCopies(safeRun, sample.entries);
    if (!(await safeRunFileExists(safeRun, TARGET_FILE)))
      fail("E_EVAL_INCOMPLETE", "Viable sampling requires target selection");
    const target = validateTargetSelectionRecord(
      await canonicalRunJson(safeRun, TARGET_FILE),
      lock,
    );
    if (
      target.inventoryDigest !== inventory.inventoryDigest ||
      target.sampleDigest !== sampleManifestDigest(sample)
    )
      fail("E_EVAL_INTEGRITY", "Target binding is invalid");
    await verifyTargetAnchor(safeRun, target);
    const compaction = await verifyT009BIfPresent(safeRun, target);
    return {
      status: "verified",
      terminal: "frozen",
      inventoryDigest: inventory.inventoryDigest,
      sampleDigest: sampleManifestDigest(sample),
      targetSelectionDigest: canonicalDigest(target),
      ...(compaction ?? {}),
    };
  }
  const underflow = await loadDisposition(safeRun, inventory, lock);
  if (
    underflow.status === "underflow-pending" &&
    collectionWindowExpired(lock.collectionWindowEndsAt)
  ) {
    const terminalFile = terminalUnderflowFile(inventory.attemptIndex);
    if (!(await safeRunFileExists(safeRun, terminalFile)))
      fail("E_EVAL_INCOMPLETE", "Pending underflow expired; sample must terminalize it");
    const terminal = await loadDisposition(safeRun, inventory, lock, terminalFile);
    if (terminal.status !== "underflow-hard-stop")
      fail("E_EVAL_INTEGRITY", "Pending underflow terminal transition is invalid");
    return {
      status: "verified",
      terminal: terminal.status,
      inventoryDigest: inventory.inventoryDigest,
      dispositionDigest: terminal.dispositionDigest,
    };
  }
  const compaction = await verifyT009BIfPresent(safeRun);
  return {
    status: "verified",
    terminal: underflow.status,
    inventoryDigest: inventory.inventoryDigest,
    dispositionDigest: underflow.dispositionDigest,
    ...(compaction ?? {}),
  };
}

export async function runFormalCommand(
  command: FormalCommand,
  args: readonly string[],
): Promise<object> {
  const common = ["--run-id", "--pi-agent-dir"];
  switch (command) {
    case "init":
      return runInit(parse(args, [...common, "--config"], ["--run-id", "--config"]));
    case "inventory":
      return runInventory(parse(args, [...common, "--source-root"], ["--run-id", "--source-root"]));
    case "sample":
      return runSample(parse(args, common, ["--run-id"]));
    case "select-target":
      return runTarget(parse(args, [...common, "--target"], ["--run-id", "--target"]));
    case "verify":
      return runVerify(parse(args, common, ["--run-id"]));
  }
}
