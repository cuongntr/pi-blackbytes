/**
 * Streaming, content-free Pi session inventory.
 *
 * The parser deliberately has a small privacy allowlist: it copies only fixed
 * counters, numeric usage/cost channels, and HMAC pseudonyms into its result.
 * Content-bearing JSON values are inspected only where needed and discarded on
 * the same iteration; they are never retained in an output-shaped object.
 *
 * @module
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { BranchTopologyAccumulator } from "./branch-topology.js";
import { hmacDigest } from "./evidence-store.js";
import type { SafeRun } from "./path-safety.js";
import { ensurePrivateDir, safeRunPath, safeRunStat } from "./path-safety.js";
import {
  createSourceGuard,
  pseudonymizeGuardedValue,
  streamGuardedSourceTo,
  validateGuardedCopyDescriptor,
  verifySourceIntegrity,
} from "./source-guard.js";
import type { SourceGuard } from "./source-guard.js";
import { EvidenceStoreError, SCHEMA_VERSION } from "./types.js";
import type { InventoryEntryType, InventoryRecord, InventoryRole } from "./types.js";

const ENTRY_TYPES = [
  "session",
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "label",
  "session_info",
  "custom_message",
  "unknown",
  "malformed",
] as const satisfies readonly InventoryEntryType[];

const KNOWN_ENTRY_TYPES = new Set<string>(ENTRY_TYPES.slice(0, -2));
const USAGE_CHANNELS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_CHANNELS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const EMPTY_BYTES = new Uint8Array();
const FALLBACK_DOMAIN = "pi-blackbytes:context-pruning:inventory:v1";

/** Fixed coarse reason codes. No source value can become an exclusion reason. */
export const INVENTORY_EXCLUSION_REASONS = [
  "canonical-path-unavailable",
  "duplicate-header",
  "duplicate-lineage",
  "duplicate-structural-id",
  "incomplete-usage",
  "invalid-header",
  "invalid-line-index",
  "invalid-source-metadata",
  "invalid-structural-id",
  "lineage-cycle",
  "malformed-jsonl",
  "missing-parent",
  "no-terminal-leaf",
  "missing-header",
  "source-integrity-failed",
  "structural-cycle",
  "unresolved-parent-session",
  "unknown-entry-type",
  "unreadable-source",
] as const;

type ExclusionReason = (typeof INVENTORY_EXCLUSION_REASONS)[number];

/** Resolves a frozen provider/model context window without serializing either identifier. */
export type ModelContextWindowResolver = (provider: string, model: string) => number | undefined;

/**
 * Optional, frozen context-window metadata. Nested maps require an exact
 * provider/model match; the resolver has precedence over the map.
 */
export interface InventoryOptions {
  readonly resolveContextWindow?: ModelContextWindowResolver;
  readonly modelContextWindows?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

interface MutableUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface HeaderState {
  validCount: number;
  invalid: boolean;
  corpusId?: string;
  rawId?: string;
  rawParentSession?: string;
  version?: number;
  parentStatus: "parent" | "fork";
}

interface SourceMetadata {
  readonly canonicalPath: string;
  readonly headerId: string;
  readonly parentSession?: string;
  readonly guard: SourceGuard;
  readonly corpusKey: string;
  readonly ownCorpusId: string;
}

const sourceMetadata = new WeakMap<InventoryRecord, SourceMetadata>();

function registerSourceMetadata(record: InventoryRecord, metadata: SourceMetadata): void {
  sourceMetadata.set(record, metadata);
}

interface ParseState {
  readonly entryCounts: Record<InventoryEntryType, number>;
  readonly roleCounts: Record<InventoryRole, number>;
  readonly usageTotals: MutableUsageTotals;
  readonly topology: BranchTopologyAccumulator;
  readonly reasons: Set<ExclusionReason>;
  readonly header: HeaderState;
  requestCount: number;
  completeUsageRecordCount: number;
  compactionCount: number;
  maxContextRatio?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function addFiniteAggregate(current: number, value: number): number | undefined {
  const aggregate = current + value;
  return Number.isFinite(aggregate) ? aggregate : undefined;
}

function timingSafeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function createEntryCounts(): Record<InventoryEntryType, number> {
  return {
    session: 0,
    message: 0,
    thinking_level_change: 0,
    model_change: 0,
    compaction: 0,
    branch_summary: 0,
    custom: 0,
    label: 0,
    session_info: 0,
    custom_message: 0,
    unknown: 0,
    malformed: 0,
  };
}

function createRoleCounts(): Record<InventoryRole, number> {
  return { user: 0, assistant: 0, toolResult: 0, unknown: 0 };
}

function createUsageTotals(): MutableUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createParseState(corpusKey: string): ParseState {
  return {
    entryCounts: createEntryCounts(),
    roleCounts: createRoleCounts(),
    usageTotals: createUsageTotals(),
    topology: new BranchTopologyAccumulator(corpusKey),
    reasons: new Set(),
    header: { validCount: 0, invalid: false, parentStatus: "parent" },
    requestCount: 0,
    completeUsageRecordCount: 0,
    compactionCount: 0,
  };
}

function addReason(state: ParseState, reason: ExclusionReason): void {
  state.reasons.add(reason);
}

/** Validate the key before touching a source, without retaining it or emitting it. */
function validateCorpusKey(corpusKey: string): void {
  hmacDigest(corpusKey, EMPTY_BYTES);
}

function pseudonymizeStructuralId(corpusKey: string, id: string): string {
  return hmacDigest(corpusKey, Buffer.from(id, "utf8"));
}

function fallbackDigest(corpusKey: string, kind: string, sourceIdentity: string): string {
  // This deliberately cannot be mistaken for an HMAC of raw source bytes.
  const domain = Buffer.from(`${FALLBACK_DOMAIN}:${kind}\0`, "utf8");
  return hmacDigest(corpusKey, Buffer.concat([domain, Buffer.from(sourceIdentity, "utf8")]));
}

/** Domain-separated, length-framed root session identity. */
/** HMAC pseudonym for the canonical source parent directory; never expose the directory itself. */
function repositoryIdentity(corpusKey: string, canonicalPath: string): string {
  return hmacDigest(corpusKey, Buffer.from(dirname(canonicalPath), "utf8"));
}

function rootIdentity(corpusKey: string, canonicalPath: string, headerId: string): string {
  const domain = Buffer.from("pi-blackbytes:context-pruning:lineage-root:v1\0", "utf8");
  const pathBytes = Buffer.from(canonicalPath, "utf8");
  const idBytes = Buffer.from(headerId, "utf8");
  const frame = Buffer.allocUnsafe(8);
  frame.writeUInt32BE(pathBytes.length, 0);
  frame.writeUInt32BE(idBytes.length, 4);
  return hmacDigest(corpusKey, Buffer.concat([domain, frame, pathBytes, idBytes]));
}

function updateStructuralTopology(
  record: Record<string, unknown>,
  state: ParseState,
  lineIndex: number,
  isAssistantUsage: boolean,
): void {
  const { id, parentId } = record;
  const isRoot = parentId === undefined || parentId === null;
  if (!isNonEmptyString(id) || (!isRoot && !isNonEmptyString(parentId))) {
    addReason(state, "invalid-structural-id");
    return;
  }
  state.topology.add(id, parentId, lineIndex, isAssistantUsage);
}

function resolveContextWindow(
  options: InventoryOptions,
  provider: string,
  model: string,
): number | undefined {
  try {
    const resolved = options.resolveContextWindow?.(provider, model);
    if (isFiniteNonnegativeNumber(resolved) && resolved > 0) return resolved;

    const fromMap = options.modelContextWindows?.get(provider)?.get(model);
    return isFiniteNonnegativeNumber(fromMap) && fromMap > 0 ? fromMap : undefined;
  } catch {
    // A caller-supplied resolver is optional metadata; its diagnostics are not safe to emit.
    return undefined;
  }
}

function updateMaxContextRatio(state: ParseState, ratio: number): void {
  if (state.maxContextRatio === undefined || ratio > state.maxContextRatio) {
    state.maxContextRatio = ratio;
  }
}

function processUsage(
  message: Record<string, unknown>,
  state: ParseState,
  options: InventoryOptions,
): void {
  const usage = message.usage;
  if (!isObject(usage)) return;

  state.requestCount += 1;
  let complete = true;
  const values: Partial<Record<(typeof USAGE_CHANNELS)[number], number>> = {};

  for (const channel of USAGE_CHANNELS) {
    const value = usage[channel];
    if (isFiniteNonnegativeNumber(value)) {
      const aggregate = addFiniteAggregate(state.usageTotals[channel], value);
      if (aggregate === undefined) {
        complete = false;
      } else {
        state.usageTotals[channel] = aggregate;
        values[channel] = value;
      }
    } else {
      complete = false;
    }
  }

  const cost = usage.cost;
  if (isObject(cost)) {
    for (const channel of COST_CHANNELS) {
      const value = cost[channel];
      if (isFiniteNonnegativeNumber(value)) {
        const aggregate = addFiniteAggregate(state.usageTotals.cost[channel], value);
        if (aggregate === undefined) {
          complete = false;
        } else {
          state.usageTotals.cost[channel] = aggregate;
        }
      } else {
        complete = false;
      }
    }
  } else {
    complete = false;
  }

  if (complete) {
    state.completeUsageRecordCount += 1;
  } else {
    addReason(state, "incomplete-usage");
  }

  const contextPercent = usage.contextPercent;
  if (isFiniteNonnegativeNumber(contextPercent)) {
    updateMaxContextRatio(state, contextPercent / 100);
    return;
  }

  const provider = message.provider;
  const model = message.model;
  const totalTokens = values.totalTokens;
  if (!isNonEmptyString(provider) || !isNonEmptyString(model) || totalTokens === undefined) return;

  const window = resolveContextWindow(options, provider, model);
  if (window !== undefined) updateMaxContextRatio(state, totalTokens / window);
}

function processMessage(
  record: Record<string, unknown>,
  state: ParseState,
  options: InventoryOptions,
): boolean {
  const message = record.message;
  if (!isObject(message)) return false;

  const role = message.role;
  const bucket: InventoryRole =
    role === "user" || role === "assistant" || role === "toolResult" ? role : "unknown";
  state.roleCounts[bucket] += 1;
  if (bucket === "assistant") {
    const hasUsage = isObject(message.usage);
    if (hasUsage) processUsage(message, state, options);
    return hasUsage;
  }
  return false;
}

function processHeader(
  record: Record<string, unknown>,
  state: ParseState,
  corpusKey: string,
  canonicalPath: string | undefined,
): void {
  const { id, version, parentSession } = record;
  const validVersion =
    version === undefined || (Number.isInteger(version) && (version as number) >= 0);
  const validParent = parentSession === undefined || isNonEmptyString(parentSession);
  if (!isNonEmptyString(id) || !validVersion || !validParent) {
    state.header.invalid = true;
    addReason(state, "invalid-header");
    return;
  }

  state.header.validCount += 1;
  if (state.header.validCount > 1) {
    addReason(state, "duplicate-header");
    return;
  }

  // These private fields are transferred only to the module-private source capability map.
  state.header.rawId = id;
  state.header.rawParentSession = parentSession as string | undefined;
  // T-004 contract: plain UTF-8 byte concatenation, with no domain/frame bytes.
  state.header.corpusId =
    canonicalPath === undefined
      ? undefined
      : hmacDigest(
          corpusKey,
          Buffer.concat([Buffer.from(canonicalPath, "utf8"), Buffer.from(id, "utf8")]),
        );
  state.header.version = version as number | undefined;
  state.header.parentStatus = parentSession === undefined ? "parent" : "fork";
}

function processParsedLine(
  parsed: unknown,
  state: ParseState,
  corpusKey: string,
  options: InventoryOptions,
  canonicalPath: string | undefined,
  lineIndex: number,
): void {
  if (!isObject(parsed)) {
    state.entryCounts.malformed += 1;
    addReason(state, "malformed-jsonl");
    return;
  }

  const type = parsed.type;
  if (type === "session") {
    state.entryCounts.session += 1;
    processHeader(parsed, state, corpusKey, canonicalPath);
    return;
  }

  const bucket: InventoryEntryType =
    typeof type === "string" && KNOWN_ENTRY_TYPES.has(type)
      ? (type as InventoryEntryType)
      : "unknown";
  state.entryCounts[bucket] += 1;
  if (bucket === "unknown") addReason(state, "unknown-entry-type");
  if (bucket === "compaction") state.compactionCount += 1;
  const isAssistantUsage = bucket === "message" && processMessage(parsed, state, options);
  updateStructuralTopology(parsed, state, lineIndex, isAssistantUsage);
}

function parseLine(
  line: string,
  state: ParseState,
  corpusKey: string,
  options: InventoryOptions,
  canonicalPath: string | undefined,
  lineIndex: number,
): void {
  try {
    processParsedLine(
      JSON.parse(line) as unknown,
      state,
      corpusKey,
      options,
      canonicalPath,
      lineIndex,
    );
  } catch {
    // JSON.parse and arbitrary malformed values produce the same fixed bucket.
    state.entryCounts.malformed += 1;
    addReason(state, "malformed-jsonl");
  }
}

function freezeRecord(record: InventoryRecord): InventoryRecord {
  Object.freeze(record.entryCounts);
  Object.freeze(record.roleCounts);
  Object.freeze(record.usageTotals.cost);
  Object.freeze(record.usageTotals);
  Object.freeze(record.exclusionReasons);
  return Object.freeze(record);
}

function buildRecord(
  state: ParseState,
  source: {
    readonly corpusId: string;
    readonly sourceDigest: string;
    readonly repositoryId?: string;
    readonly bytes: number;
    readonly mtimeMs: number;
    readonly unreadable: boolean;
    readonly canonicalAvailable: boolean;
    readonly integrityFailed: boolean;
    readonly topologyTrusted: boolean;
  },
): InventoryRecord {
  const headerIsUsable = state.header.validCount === 1 && !state.header.invalid;
  if (!headerIsUsable) {
    addReason(state, state.header.validCount > 1 ? "duplicate-header" : "missing-header");
  }
  if (!source.canonicalAvailable) addReason(state, "canonical-path-unavailable");
  if (headerIsUsable && state.header.parentStatus === "fork") {
    addReason(state, "unresolved-parent-session");
  }
  if (source.integrityFailed) addReason(state, "source-integrity-failed");
  if (source.unreadable) addReason(state, "unreadable-source");

  const topology = source.topologyTrusted
    ? state.topology.finalize()
    : {
        branchCount: 0,
        finalBranchEntryCount: 0,
        finalBranchRequestCount: 0,
        abandonedEntryCount: 0,
        reasons: [],
      };
  for (const reason of topology.reasons) addReason(state, reason);
  const reasons = [...state.reasons].sort();
  const parseStatus: InventoryRecord["parseStatus"] = source.unreadable
    ? "unreadable"
    : reasons.length === 0
      ? "valid"
      : "partial";
  // The denominator is every assistant message with a usage object, never an estimate.
  const usageCompleteness =
    state.requestCount === 0 ? 0 : state.completeUsageRecordCount / state.requestCount;

  const record: InventoryRecord = {
    schemaVersion: SCHEMA_VERSION,
    corpusId: source.corpusId,
    ...(source.repositoryId === undefined ? {} : { repositoryId: source.repositoryId }),
    sourceDigest: source.sourceDigest,
    bytes: source.bytes,
    mtimeMs: source.mtimeMs,
    ...(headerIsUsable && !source.unreadable && source.canonicalAvailable
      ? { sessionVersion: state.header.version }
      : {}),
    parentStatus:
      headerIsUsable && !source.unreadable && source.canonicalAvailable
        ? state.header.parentStatus
        : "unknown",
    parseStatus,
    entryCounts: state.entryCounts,
    roleCounts: state.roleCounts,
    usageTotals: state.usageTotals,
    requestCount: state.requestCount,
    branchCount: topology.branchCount,
    ...(topology.selectedLeafId === undefined
      ? {}
      : {
          selectedLeafId: topology.selectedLeafId,
          selectedLeafLineIndex: topology.selectedLeafLineIndex,
        }),
    finalBranchEntryCount: topology.finalBranchEntryCount,
    finalBranchRequestCount: topology.finalBranchRequestCount,
    abandonedEntryCount: topology.abandonedEntryCount,
    lineageStatus:
      headerIsUsable && !source.unreadable && source.canonicalAvailable
        ? state.header.parentStatus === "parent"
          ? "root"
          : "unresolved"
        : "unknown",
    lineageDisposition:
      headerIsUsable && !source.unreadable && source.canonicalAvailable ? "unique" : "excluded",
    usageCompleteness,
    ...(state.maxContextRatio === undefined ? {} : { maxContextRatio: state.maxContextRatio }),
    compactionCount: state.compactionCount,
    exclusionReasons: reasons,
  };
  return freezeRecord(record);
}

function unreadableRecord(sourcePath: string, corpusKey: string): InventoryRecord {
  const state = createParseState(corpusKey);
  const sourceIdentity = sourcePath;
  return buildRecord(state, {
    corpusId: fallbackDigest(corpusKey, "unreadable-corpus-id", sourceIdentity),
    sourceDigest: fallbackDigest(corpusKey, "unreadable-source-digest", sourceIdentity),
    bytes: 0,
    mtimeMs: 0,
    unreadable: true,
    canonicalAvailable: false,
    integrityFailed: false,
    topologyTrusted: false,
  });
}

/**
 * Inventory one JSONL source with bounded memory. The source is guarded before
 * parsing and re-verified afterwards; failures become path-free records.
 */
export async function inventorySource(
  sourcePath: string,
  corpusKey: string,
  options: InventoryOptions = {},
): Promise<InventoryRecord> {
  validateCorpusKey(corpusKey);

  let guard: Awaited<ReturnType<typeof createSourceGuard>>;
  try {
    guard = await createSourceGuard(sourcePath, corpusKey);
  } catch {
    return unreadableRecord(sourcePath, corpusKey);
  }

  const state = createParseState(corpusKey);
  let canonicalPath: string | undefined;
  let mtimeMs = 0;
  let metadataValid = true;
  try {
    canonicalPath = await realpath(sourcePath);
    const metadata = await stat(sourcePath);
    if (
      !isFiniteNonnegativeNumber(metadata.mtimeMs) ||
      !isFiniteNonnegativeNumber(guard.before.byteLength)
    ) {
      metadataValid = false;
      addReason(state, "invalid-source-metadata");
    } else {
      mtimeMs = metadata.mtimeMs;
    }
  } catch {
    metadataValid = false;
    addReason(state, "invalid-source-metadata");
  }

  let unreadable = false;
  let parsedDigestMatches = false;
  try {
    const parseHmac = createHmac("sha256", Buffer.from(corpusKey, "hex"));
    const parseHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const input = parseHandle.createReadStream({ autoClose: false });
      input.on("data", (chunk: Buffer | string) => parseHmac.update(chunk));
      const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
      let lineIndex = 0;
      for await (const line of lines) {
        lineIndex += 1;
        parseLine(line, state, corpusKey, options, canonicalPath, lineIndex);
      }
      parsedDigestMatches = timingSafeDigestEqual(parseHmac.digest("hex"), guard.before.digest);
    } finally {
      await parseHandle.close();
    }
  } catch {
    unreadable = true;
  }

  let integrityFailed = !unreadable && !parsedDigestMatches;
  try {
    await verifySourceIntegrity(guard);
  } catch {
    integrityFailed = true;
  }

  // Never retain aggregates parsed from bytes that failed source verification.
  const trustedState = unreadable || integrityFailed ? createParseState(corpusKey) : state;
  if (!metadataValid) addReason(trustedState, "invalid-source-metadata");

  const sourceIdentity = canonicalPath ?? sourcePath;
  const headerIsUsable =
    trustedState.header.validCount === 1 &&
    !trustedState.header.invalid &&
    canonicalPath !== undefined &&
    !unreadable &&
    !integrityFailed;
  const corpusId =
    headerIsUsable && trustedState.header.corpusId !== undefined
      ? trustedState.header.corpusId
      : fallbackDigest(corpusKey, "no-header-or-unreadable-corpus-id", sourceIdentity);
  const sourceDigest =
    !unreadable && !integrityFailed
      ? guard.before.digest
      : fallbackDigest(corpusKey, "unreadable-or-unverified-source-digest", sourceIdentity);

  const record = buildRecord(trustedState, {
    corpusId,
    ...(headerIsUsable && canonicalPath !== undefined
      ? { repositoryId: repositoryIdentity(corpusKey, canonicalPath) }
      : {}),
    sourceDigest,
    bytes: unreadable || integrityFailed || !metadataValid ? 0 : guard.before.byteLength,
    mtimeMs: unreadable || integrityFailed || !metadataValid ? 0 : mtimeMs,
    unreadable,
    canonicalAvailable: canonicalPath !== undefined,
    integrityFailed,
    topologyTrusted: !unreadable && !integrityFailed,
  });
  if (headerIsUsable && canonicalPath !== undefined && trustedState.header.rawId !== undefined) {
    registerSourceMetadata(record, {
      canonicalPath,
      headerId: trustedState.header.rawId,
      ...(trustedState.header.rawParentSession === undefined
        ? {}
        : { parentSession: trustedState.header.rawParentSession }),
      guard,
      corpusKey,
      ownCorpusId: corpusId,
    });
  }
  return record;
}

function cloneRecord(
  record: InventoryRecord,
  patch: Partial<
    Pick<InventoryRecord, "lineageRootId" | "lineageStatus" | "lineageDisposition">
  > & {
    readonly exclusionReasons?: readonly string[];
  },
): InventoryRecord {
  const exclusionReasons =
    patch.exclusionReasons === undefined ? record.exclusionReasons : [...patch.exclusionReasons];
  return freezeRecord({
    ...record,
    ...patch,
    ...(record.parseStatus === "unreadable"
      ? {}
      : { parseStatus: exclusionReasons.length === 0 ? "valid" : "partial" }),
    exclusionReasons,
  });
}

function resolveParentPath(metadata: SourceMetadata): string | undefined {
  if (metadata.parentSession === undefined) return undefined;
  return isAbsolute(metadata.parentSession)
    ? metadata.parentSession
    : resolve(dirname(metadata.canonicalPath), metadata.parentSession);
}

/** Finalize in-corpus-only fork lineage without opening or discovering any parent path. */
function finalizeCorpusLineage(records: readonly InventoryRecord[]): readonly InventoryRecord[] {
  const metadata = records.map((record) => sourceMetadata.get(record));
  const byPath = new Map<string, number[]>();
  for (let index = 0; index < metadata.length; index += 1) {
    const canonicalPath = metadata[index]?.canonicalPath;
    if (canonicalPath === undefined) continue;
    const matches = byPath.get(canonicalPath) ?? [];
    matches.push(index);
    byPath.set(canonicalPath, matches);
  }

  const parent = new Array<number | undefined>(records.length);
  const status: InventoryRecord["lineageStatus"][] = records.map((record, index) =>
    metadata[index] === undefined ? record.lineageStatus : "root",
  );
  for (let index = 0; index < metadata.length; index += 1) {
    const child = metadata[index];
    if (child === undefined || child.parentSession === undefined) continue;
    const matches = byPath.get(resolveParentPath(child) ?? "") ?? [];
    if (matches.length === 1 && matches[0] !== undefined) {
      parent[index] = matches[0];
    } else {
      status[index] = "unresolved";
    }
  }

  // Memoized iterative tri-state path walks avoid recursive stack growth and
  // resolve each in-corpus parent edge at most once.
  const roots = new Array<number | undefined>(records.length);
  const state = new Array<0 | 1 | 2>(records.length).fill(0);
  for (let start = 0; start < records.length; start += 1) {
    if (state[start] === 2 || status[start] === "unknown" || status[start] === "unresolved") {
      continue;
    }
    const path: number[] = [];
    const positions = new Map<number, number>();
    let current: number | undefined = start;
    while (current !== undefined && state[current] !== 2) {
      if (status[current] === "unknown" || status[current] === "unresolved") break;
      const position = positions.get(current);
      if (position !== undefined) {
        for (let index = position; index < path.length; index += 1) {
          const node = path[index];
          if (node !== undefined) status[node] = "cycle";
        }
        break;
      }
      state[current] = 1;
      positions.set(current, path.length);
      path.push(current);
      current = parent[current];
    }

    let root: number | undefined;
    if (current === undefined) {
      const last = path[path.length - 1];
      root = last;
    } else if (state[current] === 2) {
      root = roots[current];
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const node = path[index];
      if (node === undefined) continue;
      if (status[node] === "cycle") {
        root = undefined;
      } else if (root === undefined) {
        status[node] = "unresolved";
      } else {
        roots[node] = root;
        status[node] = node === root ? "root" : "resolved";
      }
      state[node] = 2;
    }
  }

  // Dedupe by the root identity, not a transient input index. This also makes
  // repeated paths and input permutations deterministic.
  const groups = new Map<string, number[]>();
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    const rootMeta = root === undefined ? undefined : metadata[root];
    if (
      rootMeta === undefined ||
      status[index] === "cycle" ||
      status[index] === "unresolved" ||
      status[index] === "unknown"
    ) {
      continue;
    }
    const rootId = rootIdentity(rootMeta.corpusKey, rootMeta.canonicalPath, rootMeta.headerId);
    const members = groups.get(rootId) ?? [];
    members.push(index);
    groups.set(rootId, members);
  }

  const finalized = records.map((record, index) => {
    const root = roots[index];
    const rootMeta = root === undefined ? undefined : metadata[root];
    const reasons = record.exclusionReasons.filter(
      (reason) => reason !== "unresolved-parent-session" && reason !== "lineage-cycle",
    );
    if (status[index] === "unresolved") reasons.push("unresolved-parent-session");
    if (status[index] === "cycle") reasons.push("lineage-cycle");
    return cloneRecord(record, {
      ...(rootMeta === undefined
        ? {}
        : {
            lineageRootId: rootIdentity(
              rootMeta.corpusKey,
              rootMeta.canonicalPath,
              rootMeta.headerId,
            ),
          }),
      lineageStatus: status[index] ?? "unknown",
      lineageDisposition:
        status[index] === "unknown" ||
        status[index] === "unresolved" ||
        status[index] === "cycle" ||
        record.parseStatus === "unreadable" ||
        reasons.length > 0
          ? "excluded"
          : "unique",
      exclusionReasons: [...new Set(reasons)].sort(),
    });
  });

  for (const members of groups.values()) {
    // A lineage with any invalid member is not safe to select through a valid
    // descendant: root resolution is metadata-only, so fail closed as a group.
    if (members.some((index) => finalized[index]?.lineageDisposition === "excluded")) {
      for (const index of members) {
        const record = finalized[index];
        if (record !== undefined && record.lineageDisposition !== "excluded") {
          finalized[index] = cloneRecord(record, { lineageDisposition: "excluded" });
        }
      }
      continue;
    }
    const representative = [...members].sort((left, right) => {
      // corpusId is the immutable per-file identity and the specified tie-break.
      const leftId = records[left]?.corpusId ?? "";
      const rightId = records[right]?.corpusId ?? "";
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    })[0];
    for (const index of members) {
      if (index === representative) continue;
      const record = finalized[index];
      if (record === undefined) continue;
      finalized[index] = cloneRecord(record, {
        lineageDisposition: "duplicate-lineage",
        exclusionReasons: [...new Set([...record.exclusionReasons, "duplicate-lineage"])].sort(),
      });
    }
  }

  for (let index = 0; index < finalized.length; index += 1) {
    const record = finalized[index];
    const metadataForRecord = metadata[index];
    if (record !== undefined && metadataForRecord !== undefined) {
      registerSourceMetadata(record, metadataForRecord);
    }
  }
  return Object.freeze(finalized);
}

/**
 * Inventory a corpus sequentially. A bad source produces its own record and
 * never prevents later sources from being scanned. No paths are returned.
 */
export async function inventoryCorpus(
  sourcePaths: Iterable<string>,
  corpusKey: string,
  options: InventoryOptions = {},
): Promise<readonly InventoryRecord[]> {
  validateCorpusKey(corpusKey);
  const records: InventoryRecord[] = [];
  for (const sourcePath of sourcePaths) {
    records.push(await inventorySource(sourcePath, corpusKey, options));
  }
  return finalizeCorpusLineage(records);
}

const COPY_DIRECTORY = "copied-sessions";
const COPY_SUFFIX = ".jsonl";

export interface DisposableSessionCopy {
  readonly __brand: "DisposableSessionCopy";
}

export interface SessionValidation {
  readonly corpusId: string;
  readonly status:
    | "matched"
    | "mismatch"
    | "copy-failed"
    | "open-failed"
    | "source-integrity-failed";
}

interface CopyIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
  readonly nlink: number;
}

interface DisposableCopyData {
  readonly corpusId: string;
  readonly expectedLeafId: string;
  readonly copyPath: string;
  readonly copyDirectory: string;
  readonly safeRun: SafeRun;
  readonly relativePath: string;
  readonly guard: SourceGuard;
  readonly creation: CopyIdentity;
}

const disposableCopies = new WeakMap<object, DisposableCopyData>();

function copyValidationResult(
  corpusId: string,
  status: SessionValidation["status"],
): SessionValidation {
  return Object.freeze({ corpusId, status });
}

function isEligibleForDisposableCopy(record: InventoryRecord): boolean {
  return (
    record.parseStatus === "valid" &&
    record.lineageDisposition === "unique" &&
    record.lineageStatus !== "unknown" &&
    record.selectedLeafId !== undefined &&
    record.exclusionReasons.length === 0
  );
}

function copyIdentityMatches(stats: CopyIdentity, expected: CopyIdentity): boolean {
  return (
    stats.dev === expected.dev &&
    stats.ino === expected.ino &&
    stats.size === expected.size &&
    stats.mtimeMs === expected.mtimeMs &&
    stats.mode === expected.mode &&
    stats.nlink === expected.nlink
  );
}

function copyName(): string {
  return `${randomBytes(18).toString("hex")}${COPY_SUFFIX}`;
}

/**
 * Create a 0600 single-link SafeRun copy for an eligible, registered record.
 * The source capability remains private to this module's WeakMap.
 */
export async function createDisposableSessionCopy(
  record: InventoryRecord,
  safeRun: SafeRun,
): Promise<DisposableSessionCopy> {
  const metadata = sourceMetadata.get(record);
  const expectedLeafId = record.selectedLeafId;
  if (
    metadata === undefined ||
    expectedLeafId === undefined ||
    !isEligibleForDisposableCopy(record)
  ) {
    throw new EvidenceStoreError(
      "E_EVAL_INTEGRITY",
      "Inventory record cannot create a session copy",
    );
  }

  let copyPath: string;
  let copyDirectory: string;
  let relativePath: string;
  let creation: CopyIdentity;
  try {
    copyDirectory = await ensurePrivateDir(safeRun, COPY_DIRECTORY);
    relativePath = `${COPY_DIRECTORY}/${copyName()}`;
    copyPath = safeRunPath(safeRun, relativePath);
    const destination = await open(
      copyPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const before = await destination.stat();
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600) {
        throw new EvidenceStoreError(
          "E_EVAL_INTEGRITY",
          "Disposable copy is not a private regular file",
        );
      }
      await streamGuardedSourceTo(metadata.guard, destination);
      await destination.sync();
    } finally {
      await destination.close();
    }
    const confined = await safeRunStat(safeRun, relativePath);
    const pathStats = await lstat(copyPath);
    if (
      !confined.isFile ||
      confined.nlink !== 1 ||
      (confined.mode & 0o777) !== 0o600 ||
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      pathStats.nlink !== 1 ||
      pathStats.dev !== confined.dev ||
      pathStats.ino !== confined.ino
    ) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Disposable copy failed confinement checks");
    }
    creation = {
      dev: confined.dev,
      ino: confined.ino,
      size: confined.size,
      mtimeMs: confined.mtimeMs,
      mode: confined.mode,
      nlink: confined.nlink,
    };
  } catch {
    throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Unable to create disposable session copy");
  }

  const copy = Object.freeze({ __brand: "DisposableSessionCopy" as const });
  disposableCopies.set(copy, {
    corpusId: record.corpusId,
    expectedLeafId,
    copyPath,
    copyDirectory,
    safeRun,
    relativePath,
    guard: metadata.guard,
    creation,
  });
  return copy;
}

/** Validate Pi's leaf resolution against the leaf registered from the inventory record. */
export async function validateDisposableSessionCopy(
  copy: DisposableSessionCopy,
): Promise<SessionValidation> {
  const data = disposableCopies.get(copy);
  if (data === undefined) return copyValidationResult("", "copy-failed");

  let validation: SessionValidation = copyValidationResult(data.corpusId, "copy-failed");
  try {
    const confined = await safeRunStat(data.safeRun, data.relativePath);
    const listed = await lstat(data.copyPath);
    const listedIdentity: CopyIdentity = {
      dev: listed.dev,
      ino: listed.ino,
      size: listed.size,
      mtimeMs: listed.mtimeMs,
      mode: listed.mode,
      nlink: listed.nlink,
    };
    if (
      !confined.isFile ||
      (confined.mode & 0o777) !== 0o600 ||
      listed.isSymbolicLink() ||
      !listed.isFile() ||
      !copyIdentityMatches(listedIdentity, data.creation) ||
      !copyIdentityMatches(confined, data.creation)
    ) {
      throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Disposable copy validation failed");
    }

    const descriptor = await open(data.copyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const descriptorStats = await descriptor.stat();
      if (!copyIdentityMatches(descriptorStats, data.creation)) {
        throw new EvidenceStoreError("E_EVAL_INTEGRITY", "Disposable copy validation failed");
      }
      await validateGuardedCopyDescriptor(data.guard, descriptor);
    } finally {
      await descriptor.close();
    }

    try {
      // All paths are module-private SafeRun paths; no caller value reaches Pi.
      const manager = SessionManager.open(
        data.copyPath,
        data.copyDirectory,
        join(data.copyDirectory, "cwd"),
      );
      const rawLeaf = manager.getLeafId();
      const leaf = typeof rawLeaf === "string" ? rawLeaf : "";
      const leafId = pseudonymizeGuardedValue(data.guard, leaf);
      validation = copyValidationResult(
        data.corpusId,
        leafId === data.expectedLeafId ? "matched" : "mismatch",
      );
    } catch {
      validation = copyValidationResult(data.corpusId, "open-failed");
    }

    // Pi may migrate bytes in place, but it must not replace or link the copy.
    const after = await lstat(data.copyPath);
    const afterConfined = await safeRunStat(data.safeRun, data.relativePath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== data.creation.dev ||
      after.ino !== data.creation.ino ||
      after.nlink !== data.creation.nlink ||
      !afterConfined.isFile ||
      afterConfined.dev !== data.creation.dev ||
      afterConfined.ino !== data.creation.ino ||
      afterConfined.nlink !== data.creation.nlink
    ) {
      validation = copyValidationResult(data.corpusId, "copy-failed");
    }
  } catch {
    validation = copyValidationResult(data.corpusId, "copy-failed");
  } finally {
    try {
      await verifySourceIntegrity(data.guard);
    } catch {
      validation = copyValidationResult(data.corpusId, "source-integrity-failed");
    }
  }
  return validation;
}
