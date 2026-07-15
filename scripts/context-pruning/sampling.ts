/**
 * Deterministic, metadata-only first-40 sampling.
 *
 * This module accepts InventoryRecord values only. It deliberately has no source,
 * provider, content, or path access.
 *
 * @module
 */

import { Buffer } from "node:buffer";

import { canonicalDigest, canonicalJson, sha256 } from "./canonical-json.js";
import { validateSamplingProtocolLock } from "./protocol.js";
import type { SamplingProtocolLock } from "./protocol.js";
import { EvidenceStoreError, SCHEMA_VERSION } from "./types.js";
import type {
  InventoryRecord,
  RepositoryConcentration,
  SampleManifest,
  SampleManifestEntry,
  SamplingResult,
  SamplingSensitivitySummary,
} from "./types.js";

export const SAMPLE_SIZE = 40;
export const SENSITIVITY_REQUEST_THRESHOLDS = [10, 15, 20, 25] as const;

/** Reasons that make topology, source, header, or lineage unsafe for sampling. */
export const SAMPLING_DISQUALIFYING_REASONS = [
  "canonical-path-unavailable",
  "duplicate-header",
  "duplicate-lineage",
  "duplicate-structural-id",
  "invalid-header",
  "invalid-line-index",
  "invalid-source-metadata",
  "invalid-structural-id",
  "lineage-cycle",
  "malformed-jsonl",
  "missing-header",
  "missing-parent",
  "no-terminal-leaf",
  "source-integrity-failed",
  "structural-cycle",
  "unreadable-source",
  "unresolved-parent-session",
] as const;

const INVENTORY_ENTRY_FIELDS = [
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
] as const;
const INVENTORY_ROLE_FIELDS = ["user", "assistant", "toolResult", "unknown"] as const;
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const INVENTORY_REQUIRED_FIELDS = [
  "schemaVersion",
  "corpusId",
  "sourceDigest",
  "bytes",
  "mtimeMs",
  "parentStatus",
  "parseStatus",
  "entryCounts",
  "roleCounts",
  "usageTotals",
  "requestCount",
  "branchCount",
  "finalBranchEntryCount",
  "finalBranchRequestCount",
  "abandonedEntryCount",
  "lineageStatus",
  "lineageDisposition",
  "usageCompleteness",
  "compactionCount",
  "exclusionReasons",
] as const;
const INVENTORY_OPTIONAL_FIELDS = [
  "repositoryId",
  "lineageRootId",
  "sessionVersion",
  "selectedLeafId",
  "selectedLeafLineIndex",
  "maxContextRatio",
] as const;
const ALLOWED_EXCLUSION_REASONS = new Set<string>([
  ...SAMPLING_DISQUALIFYING_REASONS,
  "incomplete-usage",
  "unknown-entry-type",
]);
const DISQUALIFYING_REASONS = new Set<string>(SAMPLING_DISQUALIFYING_REASONS);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface SamplingRequest {
  readonly samplingLock: SamplingProtocolLock;
  readonly inventoryRecords: readonly InventoryRecord[];
  readonly attemptIndex: number;
  readonly now: Date | string;
  /** A prior frozen manifest for the same run prevents any redraw under that run ID. */
  readonly priorManifest?: SampleManifest;
}

interface RankedRecord {
  readonly record: InventoryRecord;
  readonly selectionKey: string;
}

function schemaError(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}

function integrityError(message: string): never {
  throw new EvidenceStoreError("E_EVAL_INTEGRITY", message);
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !allowed.has(field))
  ) {
    schemaError(`${label} has invalid fields`);
  }
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    schemaError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    schemaError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNonnegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    schemaError(`${field} must be a finite non-negative number`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, field: string): number {
  const number = requireFiniteNonnegative(value, field);
  if (!Number.isInteger(number)) schemaError(`${field} must be a non-negative integer`);
  return number;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const number = requireNonnegativeInteger(value, field);
  if (number === 0) schemaError(`${field} must be a positive integer`);
  return number;
}

function requireOneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    schemaError(`${field} has an unsupported value`);
  }
  return value as T;
}

function validateEntryCounts(value: unknown): InventoryRecord["entryCounts"] {
  if (!isRecord(value)) schemaError("entryCounts must be an object");
  assertExactFields(value, INVENTORY_ENTRY_FIELDS, [], "entryCounts");
  return Object.freeze({
    session: requireNonnegativeInteger(value.session, "entryCounts.session"),
    message: requireNonnegativeInteger(value.message, "entryCounts.message"),
    thinking_level_change: requireNonnegativeInteger(
      value.thinking_level_change,
      "entryCounts.thinking_level_change",
    ),
    model_change: requireNonnegativeInteger(value.model_change, "entryCounts.model_change"),
    compaction: requireNonnegativeInteger(value.compaction, "entryCounts.compaction"),
    branch_summary: requireNonnegativeInteger(value.branch_summary, "entryCounts.branch_summary"),
    custom: requireNonnegativeInteger(value.custom, "entryCounts.custom"),
    label: requireNonnegativeInteger(value.label, "entryCounts.label"),
    session_info: requireNonnegativeInteger(value.session_info, "entryCounts.session_info"),
    custom_message: requireNonnegativeInteger(value.custom_message, "entryCounts.custom_message"),
    unknown: requireNonnegativeInteger(value.unknown, "entryCounts.unknown"),
    malformed: requireNonnegativeInteger(value.malformed, "entryCounts.malformed"),
  });
}

function validateRoleCounts(value: unknown): InventoryRecord["roleCounts"] {
  if (!isRecord(value)) schemaError("roleCounts must be an object");
  assertExactFields(value, INVENTORY_ROLE_FIELDS, [], "roleCounts");
  return Object.freeze({
    user: requireNonnegativeInteger(value.user, "roleCounts.user"),
    assistant: requireNonnegativeInteger(value.assistant, "roleCounts.assistant"),
    toolResult: requireNonnegativeInteger(value.toolResult, "roleCounts.toolResult"),
    unknown: requireNonnegativeInteger(value.unknown, "roleCounts.unknown"),
  });
}

function validateUsageTotals(value: unknown): InventoryRecord["usageTotals"] {
  if (!isRecord(value)) schemaError("usageTotals must be an object");
  assertExactFields(value, [...USAGE_FIELDS, "cost"], [], "usageTotals");
  if (!isRecord(value.cost)) schemaError("usageTotals.cost must be an object");
  assertExactFields(value.cost, COST_FIELDS, [], "usageTotals.cost");
  return Object.freeze({
    input: requireFiniteNonnegative(value.input, "usageTotals.input"),
    output: requireFiniteNonnegative(value.output, "usageTotals.output"),
    cacheRead: requireFiniteNonnegative(value.cacheRead, "usageTotals.cacheRead"),
    cacheWrite: requireFiniteNonnegative(value.cacheWrite, "usageTotals.cacheWrite"),
    totalTokens: requireFiniteNonnegative(value.totalTokens, "usageTotals.totalTokens"),
    cost: Object.freeze({
      input: requireFiniteNonnegative(value.cost.input, "usageTotals.cost.input"),
      output: requireFiniteNonnegative(value.cost.output, "usageTotals.cost.output"),
      cacheRead: requireFiniteNonnegative(value.cost.cacheRead, "usageTotals.cost.cacheRead"),
      cacheWrite: requireFiniteNonnegative(value.cost.cacheWrite, "usageTotals.cost.cacheWrite"),
      total: requireFiniteNonnegative(value.cost.total, "usageTotals.cost.total"),
    }),
  });
}

function validateExclusionReasons(value: unknown): readonly string[] {
  if (!Array.isArray(value)) schemaError("exclusionReasons must be an array");
  const reasons = value.map((reason) => {
    if (typeof reason !== "string" || !ALLOWED_EXCLUSION_REASONS.has(reason)) {
      return schemaError("exclusionReasons contains an unsupported reason");
    }
    return reason;
  });
  if (
    reasons.some(
      (reason, index) => index > 0 && compareBytes(reasons[index - 1] as string, reason) >= 0,
    )
  ) {
    schemaError("exclusionReasons must be uniquely byte-sorted");
  }
  return Object.freeze(reasons);
}

function validateInventoryRecord(value: unknown): InventoryRecord {
  if (!isRecord(value)) schemaError("inventory record must be an object");
  assertExactFields(
    value,
    INVENTORY_REQUIRED_FIELDS,
    INVENTORY_OPTIONAL_FIELDS,
    "inventory record",
  );
  if (value.schemaVersion !== SCHEMA_VERSION) {
    schemaError(`schemaVersion must equal ${SCHEMA_VERSION}`);
  }

  const selectedLeafId = Object.hasOwn(value, "selectedLeafId")
    ? requireDigest(value.selectedLeafId, "selectedLeafId")
    : undefined;
  const selectedLeafLineIndex = Object.hasOwn(value, "selectedLeafLineIndex")
    ? requirePositiveInteger(value.selectedLeafLineIndex, "selectedLeafLineIndex")
    : undefined;
  if ((selectedLeafId === undefined) !== (selectedLeafLineIndex === undefined)) {
    schemaError("selected leaf ID and line index must appear together");
  }

  const usageCompleteness = requireFiniteNonnegative(value.usageCompleteness, "usageCompleteness");
  if (usageCompleteness > 1) schemaError("usageCompleteness must not exceed 1");

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    corpusId: requireDigest(value.corpusId, "corpusId"),
    ...(Object.hasOwn(value, "repositoryId")
      ? { repositoryId: requireDigest(value.repositoryId, "repositoryId") }
      : {}),
    ...(Object.hasOwn(value, "lineageRootId")
      ? { lineageRootId: requireDigest(value.lineageRootId, "lineageRootId") }
      : {}),
    sourceDigest: requireDigest(value.sourceDigest, "sourceDigest"),
    bytes: requireNonnegativeInteger(value.bytes, "bytes"),
    mtimeMs: requireFiniteNonnegative(value.mtimeMs, "mtimeMs"),
    ...(Object.hasOwn(value, "sessionVersion")
      ? { sessionVersion: requireNonnegativeInteger(value.sessionVersion, "sessionVersion") }
      : {}),
    parentStatus: requireOneOf(value.parentStatus, ["parent", "fork", "unknown"], "parentStatus"),
    parseStatus: requireOneOf(value.parseStatus, ["valid", "partial", "unreadable"], "parseStatus"),
    entryCounts: validateEntryCounts(value.entryCounts),
    roleCounts: validateRoleCounts(value.roleCounts),
    usageTotals: validateUsageTotals(value.usageTotals),
    requestCount: requireNonnegativeInteger(value.requestCount, "requestCount"),
    branchCount: requireNonnegativeInteger(value.branchCount, "branchCount"),
    ...(selectedLeafId === undefined ? {} : { selectedLeafId, selectedLeafLineIndex }),
    finalBranchEntryCount: requireNonnegativeInteger(
      value.finalBranchEntryCount,
      "finalBranchEntryCount",
    ),
    finalBranchRequestCount: requireNonnegativeInteger(
      value.finalBranchRequestCount,
      "finalBranchRequestCount",
    ),
    abandonedEntryCount: requireNonnegativeInteger(
      value.abandonedEntryCount,
      "abandonedEntryCount",
    ),
    lineageStatus: requireOneOf(
      value.lineageStatus,
      ["root", "resolved", "unresolved", "cycle", "unknown"],
      "lineageStatus",
    ),
    lineageDisposition: requireOneOf(
      value.lineageDisposition,
      ["unique", "duplicate-lineage", "excluded"],
      "lineageDisposition",
    ),
    usageCompleteness,
    ...(Object.hasOwn(value, "maxContextRatio")
      ? { maxContextRatio: requireFiniteNonnegative(value.maxContextRatio, "maxContextRatio") }
      : {}),
    compactionCount: requireNonnegativeInteger(value.compactionCount, "compactionCount"),
    exclusionReasons: validateExclusionReasons(value.exclusionReasons),
  });
}

function normalizeInventoryRecords(value: unknown): readonly InventoryRecord[] {
  if (!Array.isArray(value)) schemaError("inventory records must be an array");
  return Object.freeze(value.map((record) => validateInventoryRecord(record)));
}

function parseNow(now: Date | string): number {
  if (now instanceof Date) {
    const value = now.getTime();
    if (!Number.isFinite(value)) schemaError("now must be a valid UTC instant");
    return value;
  }
  if (typeof now !== "string" || !UTC_INSTANT_PATTERN.test(now)) {
    schemaError("now must be a valid ISO UTC instant with milliseconds");
  }
  const value = Date.parse(now);
  if (Number.isNaN(value) || new Date(value).toISOString() !== now) {
    schemaError("now must be a valid ISO UTC instant with milliseconds");
  }
  return value;
}

function assertAttemptIndex(attemptIndex: number, maxInventoryRefreshes: number): void {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0) {
    schemaError("attemptIndex must be a non-negative integer");
  }
  if (attemptIndex > maxInventoryRefreshes) {
    schemaError("attemptIndex exceeds maxInventoryRefreshes");
  }
}

function assertRequestThreshold(requestThreshold: number): void {
  if (!Number.isInteger(requestThreshold) || requestThreshold < 0) {
    schemaError("requestThreshold must be a non-negative integer");
  }
}

function assertUniqueCorpusIds(records: readonly InventoryRecord[]): void {
  const corpusIds = new Set<string>();
  for (const record of records) {
    if (corpusIds.has(record.corpusId)) integrityError("inventory contains duplicate corpusId");
    corpusIds.add(record.corpusId);
  }
}

function hasDisqualifyingReason(record: InventoryRecord): boolean {
  return record.exclusionReasons.some((reason) => DISQUALIFYING_REASONS.has(reason));
}

function isEligibleValidated(record: InventoryRecord, requestThreshold: number): boolean {
  return (
    record.parseStatus !== "unreadable" &&
    (record.parentStatus === "parent" || record.parentStatus === "fork") &&
    record.selectedLeafId !== undefined &&
    (record.lineageStatus === "root" || record.lineageStatus === "resolved") &&
    record.lineageDisposition === "unique" &&
    record.repositoryId !== undefined &&
    record.lineageRootId !== undefined &&
    !hasDisqualifyingReason(record) &&
    record.finalBranchRequestCount >= requestThreshold
  );
}

/** Evaluate frame membership using normalized InventoryRecord metadata alone. */
export function isEligibleInventoryRecord(
  record: InventoryRecord,
  requestThreshold: number,
): boolean {
  assertRequestThreshold(requestThreshold);
  return isEligibleValidated(validateInventoryRecord(record), requestThreshold);
}

function buildEligibleFrameValidated(
  records: readonly InventoryRecord[],
  requestThreshold: number,
): readonly InventoryRecord[] {
  const frame = records.filter((record) => isEligibleValidated(record, requestThreshold));
  const lineageRoots = new Set<string>();
  for (const record of frame) {
    const lineageRootId = record.lineageRootId;
    if (lineageRootId === undefined) integrityError("eligible record is missing lineageRootId");
    if (lineageRoots.has(lineageRootId)) {
      integrityError("inventory has ambiguous unique lineageRootId");
    }
    lineageRoots.add(lineageRootId);
  }
  return Object.freeze([...frame]);
}

/** Build the eligible frame from one exact, privacy-allowlisted inventory snapshot. */
export function buildEligibleFrame(
  records: readonly InventoryRecord[],
  requestThreshold: number,
): readonly InventoryRecord[] {
  assertRequestThreshold(requestThreshold);
  const normalized = normalizeInventoryRecords(records);
  assertUniqueCorpusIds(normalized);
  return buildEligibleFrameValidated(normalized, requestThreshold);
}

function inventoryDigestValidated(records: readonly InventoryRecord[]): string {
  return canonicalDigest(
    [...records].sort((left, right) => compareBytes(left.corpusId, right.corpusId)),
  );
}

/** Digest every exact inventory record in byte-stable corpusId order without mutating input. */
export function inventoryDigest(records: readonly InventoryRecord[]): string {
  const normalized = normalizeInventoryRecords(records);
  assertUniqueCorpusIds(normalized);
  return inventoryDigestValidated(normalized);
}

/** Exact accepted-design selection key: SHA256(UTF8(protocolSeed || inventoryDigest || corpusId)). */
export function selectionKey(protocolSeed: string, digest: string, corpusId: string): string {
  return sha256(
    `${requireNonEmptyString(protocolSeed, "protocolSeed")}${requireDigest(digest, "inventoryDigest")}${requireDigest(corpusId, "corpusId")}`,
  );
}

function concentration(records: readonly InventoryRecord[]): readonly RepositoryConcentration[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.repositoryId === undefined) {
      integrityError("eligible record is missing repositoryId");
    }
    counts.set(record.repositoryId, (counts.get(record.repositoryId) ?? 0) + 1);
  }
  const total = records.length;
  const summary = [...counts.entries()]
    .map(([repositoryId, count]) =>
      Object.freeze({ repositoryId, count, share: total === 0 ? 0 : count / total }),
    )
    .sort(
      (left, right) =>
        right.count - left.count || compareBytes(left.repositoryId, right.repositoryId),
    );
  return Object.freeze(summary);
}

function sensitivity(records: readonly InventoryRecord[]): readonly SamplingSensitivitySummary[] {
  return Object.freeze(
    SENSITIVITY_REQUEST_THRESHOLDS.map((requestThreshold) =>
      Object.freeze({
        requestThreshold,
        frameSize: buildEligibleFrameValidated(records, requestThreshold).length,
      }),
    ),
  );
}

function freezeManifest(manifest: SampleManifest): SampleManifest {
  for (const entry of manifest.entries) Object.freeze(entry);
  for (const entry of manifest.sensitivity) Object.freeze(entry);
  for (const entry of manifest.repositoryConcentration.frame) Object.freeze(entry);
  for (const entry of manifest.repositoryConcentration.sample) Object.freeze(entry);
  Object.freeze(manifest.entries);
  Object.freeze(manifest.sensitivity);
  Object.freeze(manifest.repositoryConcentration.frame);
  Object.freeze(manifest.repositoryConcentration.sample);
  Object.freeze(manifest.repositoryConcentration);
  return Object.freeze(manifest);
}

/** Canonical digest for a frozen sample manifest. */
export function sampleManifestDigest(manifest: SampleManifest): string {
  return canonicalDigest(validateSampleManifest(manifest));
}

function validateManifestEntry(value: unknown, expectedRank: number): SampleManifestEntry {
  if (!isRecord(value)) schemaError("sample manifest entry must be an object");
  assertExactFields(
    value,
    ["rank", "corpusId", "selectionKey", "repositoryId", "lineageRootId"],
    [],
    "sample manifest entry",
  );
  if (value.rank !== expectedRank) schemaError("sample manifest ranks must be contiguous");
  return Object.freeze({
    rank: expectedRank,
    corpusId: requireDigest(value.corpusId, "sample corpusId"),
    selectionKey: requireDigest(value.selectionKey, "selectionKey"),
    repositoryId: requireDigest(value.repositoryId, "sample repositoryId"),
    lineageRootId: requireDigest(value.lineageRootId, "sample lineageRootId"),
  });
}

function validateConcentration(
  value: unknown,
  label: string,
  expectedTotal: number,
): readonly RepositoryConcentration[] {
  if (!Array.isArray(value)) schemaError(`${label} must be an array`);
  const repositories = new Set<string>();
  const normalized = value.map((entry) => {
    if (!isRecord(entry)) schemaError(`${label} entry must be an object`);
    assertExactFields(entry, ["repositoryId", "count", "share"], [], `${label} entry`);
    const repositoryId = requireDigest(entry.repositoryId, `${label} repositoryId`);
    if (repositories.has(repositoryId)) schemaError(`${label} has a duplicate repositoryId`);
    repositories.add(repositoryId);
    const count = requirePositiveInteger(entry.count, `${label} count`);
    const share = requireFiniteNonnegative(entry.share, `${label} share`);
    if (share > 1) schemaError(`${label} share must not exceed 1`);
    return Object.freeze({ repositoryId, count, share });
  });
  if (normalized.reduce((sum, entry) => sum + entry.count, 0) !== expectedTotal) {
    schemaError(`${label} counts do not match their expected total`);
  }
  for (const entry of normalized) {
    if (entry.share !== entry.count / expectedTotal) {
      schemaError(`${label} share does not match its count`);
    }
  }
  if (
    normalized.some(
      (entry, index) =>
        index > 0 &&
        (normalized[index - 1]!.count < entry.count ||
          (normalized[index - 1]!.count === entry.count &&
            compareBytes(normalized[index - 1]!.repositoryId, entry.repositoryId) > 0)),
    )
  ) {
    schemaError(`${label} must be deterministically ordered`);
  }
  return Object.freeze(normalized);
}

/** Validate and normalize a frozen content-free sample manifest. */
export function validateSampleManifest(value: unknown): SampleManifest {
  if (!isRecord(value)) schemaError("sample manifest must be an object");
  assertExactFields(
    value,
    [
      "schemaVersion",
      "runId",
      "samplingLockDigest",
      "inventoryDigest",
      "attemptIndex",
      "frameSize",
      "entries",
      "sensitivity",
      "repositoryConcentration",
    ],
    [],
    "sample manifest",
  );
  if (value.schemaVersion !== SCHEMA_VERSION) {
    schemaError(`schemaVersion must equal ${SCHEMA_VERSION}`);
  }
  const frameSize = requireNonnegativeInteger(value.frameSize, "frameSize");
  if (frameSize < SAMPLE_SIZE) schemaError("frozen sample frameSize must be at least 40");
  if (!Array.isArray(value.entries) || value.entries.length !== SAMPLE_SIZE) {
    schemaError("sample manifest must contain exactly 40 entries");
  }
  const entries = Object.freeze(
    value.entries.map((entry, index) => validateManifestEntry(entry, index + 1)),
  );
  if (new Set(entries.map((entry) => entry.corpusId)).size !== SAMPLE_SIZE) {
    schemaError("sample manifest corpusIds must be unique");
  }
  if (new Set(entries.map((entry) => entry.lineageRootId)).size !== SAMPLE_SIZE) {
    schemaError("sample manifest lineageRootIds must be unique");
  }

  if (!Array.isArray(value.sensitivity) || value.sensitivity.length !== 4) {
    schemaError("sample sensitivity must contain exactly four thresholds");
  }
  const sensitivitySummary = Object.freeze(
    value.sensitivity.map((entry, index) => {
      if (!isRecord(entry)) schemaError("sample sensitivity entry must be an object");
      assertExactFields(entry, ["requestThreshold", "frameSize"], [], "sample sensitivity entry");
      const requestThreshold = SENSITIVITY_REQUEST_THRESHOLDS[index];
      if (entry.requestThreshold !== requestThreshold || requestThreshold === undefined) {
        return schemaError("sample sensitivity thresholds must be 10, 15, 20, and 25");
      }
      return Object.freeze({
        requestThreshold,
        frameSize: requireNonnegativeInteger(entry.frameSize, "sensitivity frameSize"),
      });
    }),
  );
  if (sensitivitySummary[2]?.frameSize !== frameSize) {
    schemaError("the primary threshold sensitivity must match frameSize");
  }
  if (
    sensitivitySummary.some(
      (entry, index) => index > 0 && sensitivitySummary[index - 1]!.frameSize < entry.frameSize,
    )
  ) {
    schemaError("sample sensitivity frame sizes must be monotonic");
  }

  if (!isRecord(value.repositoryConcentration)) {
    schemaError("repositoryConcentration must be an object");
  }
  assertExactFields(
    value.repositoryConcentration,
    ["frame", "sample"],
    [],
    "repositoryConcentration",
  );
  const frameConcentration = validateConcentration(
    value.repositoryConcentration.frame,
    "frame repository concentration",
    frameSize,
  );
  const sampleConcentration = validateConcentration(
    value.repositoryConcentration.sample,
    "sample repository concentration",
    SAMPLE_SIZE,
  );
  const expectedSampleCounts = new Map<string, number>();
  for (const entry of entries) {
    expectedSampleCounts.set(
      entry.repositoryId,
      (expectedSampleCounts.get(entry.repositoryId) ?? 0) + 1,
    );
  }
  if (
    sampleConcentration.some(
      (entry) => expectedSampleCounts.get(entry.repositoryId) !== entry.count,
    ) ||
    sampleConcentration.length !== expectedSampleCounts.size
  ) {
    schemaError("sample repository concentration does not match sample entries");
  }

  return freezeManifest({
    schemaVersion: SCHEMA_VERSION,
    runId: requireNonEmptyString(value.runId, "runId"),
    samplingLockDigest: requireDigest(value.samplingLockDigest, "samplingLockDigest"),
    inventoryDigest: requireDigest(value.inventoryDigest, "inventoryDigest"),
    attemptIndex: requireNonnegativeInteger(value.attemptIndex, "attemptIndex"),
    frameSize,
    entries,
    sensitivity: sensitivitySummary,
    repositoryConcentration: Object.freeze({
      frame: frameConcentration,
      sample: sampleConcentration,
    }),
  });
}

/** Reject any changed frozen manifest under the same run ID. */
export function assertSampleManifestImmutable(
  persisted: SampleManifest,
  current: SampleManifest,
): void {
  const persistedManifest = validateSampleManifest(persisted);
  const currentManifest = validateSampleManifest(current);
  if (
    persistedManifest.runId === currentManifest.runId &&
    canonicalJson(persistedManifest) !== canonicalJson(currentManifest)
  ) {
    integrityError("a sample manifest cannot change under the same runId");
  }
}

/**
 * Freeze a first-40 sample or return a content-free underflow disposition.
 * This is intentionally a pure metadata operation and never returns a partial
 * selected list.
 */
export function sampleInventory(request: SamplingRequest): SamplingResult {
  const lock = validateSamplingProtocolLock(request.samplingLock);
  assertAttemptIndex(request.attemptIndex, lock.maxInventoryRefreshes);
  const now = parseNow(request.now);
  const records = normalizeInventoryRecords(request.inventoryRecords);
  assertUniqueCorpusIds(records);
  const digest = inventoryDigestValidated(records);
  const lockDigest = canonicalDigest(lock);
  const prior =
    request.priorManifest === undefined ? undefined : validateSampleManifest(request.priorManifest);
  if (
    prior?.runId === lock.runId &&
    (prior.samplingLockDigest !== lockDigest ||
      prior.inventoryDigest !== digest ||
      prior.attemptIndex !== request.attemptIndex)
  ) {
    integrityError("a frozen run cannot change lock, inventory, or attempt identity");
  }
  const frame = buildEligibleFrameValidated(records, lock.longSessionMinRequests);

  if (frame.length < SAMPLE_SIZE) {
    const collectionEndsAt = Date.parse(lock.collectionWindowEndsAt);
    const status =
      request.attemptIndex < lock.maxInventoryRefreshes && now < collectionEndsAt
        ? "underflow-pending"
        : "underflow-hard-stop";
    return Object.freeze({
      status,
      code: "E_EVAL_INCOMPLETE",
      attemptIndex: request.attemptIndex,
      frameSize: frame.length,
      requiredSampleSize: SAMPLE_SIZE,
      maxInventoryRefreshes: lock.maxInventoryRefreshes,
      collectionWindowEndsAt: lock.collectionWindowEndsAt,
    });
  }

  const ranked: RankedRecord[] = frame.map((record) =>
    Object.freeze({
      record,
      selectionKey: selectionKey(lock.protocolSeed, digest, record.corpusId),
    }),
  );
  ranked.sort(
    (left, right) =>
      compareBytes(left.selectionKey, right.selectionKey) ||
      compareBytes(left.record.corpusId, right.record.corpusId),
  );
  const selected = ranked.slice(0, SAMPLE_SIZE);
  const entries: SampleManifestEntry[] = selected.map(({ record, selectionKey: key }, index) => {
    if (record.repositoryId === undefined || record.lineageRootId === undefined) {
      return integrityError("eligible record is missing pseudonym metadata");
    }
    return Object.freeze({
      rank: index + 1,
      corpusId: record.corpusId,
      selectionKey: key,
      repositoryId: record.repositoryId,
      lineageRootId: record.lineageRootId,
    });
  });
  const manifest = freezeManifest({
    schemaVersion: SCHEMA_VERSION,
    runId: lock.runId,
    samplingLockDigest: lockDigest,
    inventoryDigest: digest,
    attemptIndex: request.attemptIndex,
    frameSize: frame.length,
    entries: Object.freeze(entries),
    sensitivity: sensitivity(records),
    repositoryConcentration: Object.freeze({
      frame: concentration(frame),
      sample: concentration(selected.map(({ record }) => record)),
    }),
  });
  if (prior !== undefined) assertSampleManifestImmutable(prior, manifest);
  return Object.freeze({ status: "frozen", manifest });
}
