/**
 * Immutable, staged protocol locks for the context-pruning evaluation.
 *
 * These records are evaluation-only contracts. They neither read source content
 * nor invoke a provider.
 *
 * @module
 */

import { createHash } from "node:crypto";

import { canonicalDigest, canonicalJson, sha256 } from "./canonical-json.js";
import { EvidenceStoreError, SCHEMA_VERSION } from "./types.js";

export const SAMPLING_LOCK_STAGE = "sampling-lock";
export const TARGET_SELECTION_STAGE = "target-selection";
export const EVALUATION_LOCK_STAGE = "evaluation-lock";

export const LOCK_STAGES = Object.freeze({
  sampling: SAMPLING_LOCK_STAGE,
  targetSelection: TARGET_SELECTION_STAGE,
  evaluation: EVALUATION_LOCK_STAGE,
});

/** Qualification-only estimator; it is not a billing or savings measure. */
export const QUALIFICATION_ESTIMATOR_POLICY = Object.freeze({
  formula: "ceil(UTF8 bytes of canonical model-visible candidate content / 4)",
  bytesPerEstimatedToken: 4,
  rounding: "ceil",
});

export const SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY = Object.freeze({
  domain: "snapshot-cluster-bootstrap-v1",
  resamples: 10_000,
  lowerPercentile: 0.025,
  upperPercentile: 0.975,
  lowerNearestRank: 250,
  upperNearestRank: 9_750,
  drawDomain: "draw-v1",
});

export const INDEPENDENT_AGGREGATE_SUPPRESSION_POLICY = Object.freeze({
  suppressWhenIndependentNLessThan: 5,
});

export const PROVIDER_REQUEST_POLICY = Object.freeze({
  maxRetries: 1,
  retryableErrorClasses: "bound by providerPolicyDigest",
  timeoutValues: "bound by providerPolicyDigest",
  confirmationPolicy: "bound by providerPolicyDigest",
});

export const COMPLETE_RANGE_PROVENANCE_POLICY = Object.freeze({
  requiredCompleteQualifyingRangesPerApplicableScenario: 1,
  falsePositiveOwnershipOrBoundaryClaimsAllowed: 0,
  qualificationEstimatedTokenMinimum: 2_048,
});

export interface SamplingProtocolLock {
  readonly stage: typeof SAMPLING_LOCK_STAGE;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly protocolSeed: string;
  readonly longSessionMinRequests: 20;
  readonly collectionWindowEndsAt: string;
  readonly maxInventoryRefreshes: number;
  readonly modelRegistryDigest: string;
  readonly estimatorPolicyDigest: string;
}

export interface TargetSelectionRecord {
  readonly stage: typeof TARGET_SELECTION_STAGE;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly api: string;
  readonly reasoning: string;
  readonly samplingLockDigest: string;
  readonly inventoryDigest: string;
  readonly sampleDigest: string;
  readonly providerPolicyDigest: string;
}

export interface EvaluationProtocolLock {
  readonly stage: typeof EVALUATION_LOCK_STAGE;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly samplingLockDigest: string;
  readonly targetSelectionDigest: string;
  readonly inventoryDigest: string;
  readonly sampleDigest: string;
  readonly estimatorPolicyDigest: string;
  readonly providerPolicyDigest: string;
  readonly rubricDigest: string;
  readonly pricingDigest: string;
  readonly goldDigest: string;
  readonly fixtureDigest: string;
  readonly bootstrapDigest: string;
  readonly reportPolicyDigest: string;
}

export type ProtocolLock = SamplingProtocolLock | TargetSelectionRecord | EvaluationProtocolLock;

export interface EvaluationLockPredecessors {
  readonly samplingLock: SamplingProtocolLock;
  readonly targetSelection: TargetSelectionRecord;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function schemaError(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}

function integrityError(message: string): never {
  throw new EvidenceStoreError("E_EVAL_INTEGRITY", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    schemaError(`Expected exactly fields: ${expected.join(", ")}`);
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    schemaError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireNonEmptyString(value, field);
  if (!DIGEST_PATTERN.test(digest)) {
    schemaError(`${field} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function requireSchemaVersion(value: unknown): typeof SCHEMA_VERSION {
  if (value !== SCHEMA_VERSION) {
    schemaError(`schemaVersion must equal ${SCHEMA_VERSION}`);
  }
  return SCHEMA_VERSION;
}

function requireIsoInstant(value: unknown): string {
  const instant = requireNonEmptyString(value, "collectionWindowEndsAt");
  const parsed = Date.parse(instant);
  if (
    !ISO_INSTANT_PATTERN.test(instant) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString() !== instant
  ) {
    schemaError("collectionWindowEndsAt must be a valid ISO UTC instant with milliseconds");
  }
  return instant;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    schemaError(`${field} must be a non-negative integer`);
  }
  return value;
}

/** Validate the pre-inventory sampling lock without accepting extra fields. */
export function validateSamplingProtocolLock(value: unknown): SamplingProtocolLock {
  if (!isRecord(value)) schemaError("sampling lock must be an object");
  requireExactFields(value, [
    "collectionWindowEndsAt",
    "estimatorPolicyDigest",
    "longSessionMinRequests",
    "maxInventoryRefreshes",
    "modelRegistryDigest",
    "protocolSeed",
    "runId",
    "schemaVersion",
    "stage",
  ]);
  if (value.stage !== SAMPLING_LOCK_STAGE) schemaError("invalid sampling lock stage");
  if (value.longSessionMinRequests !== 20) schemaError("longSessionMinRequests must equal 20");

  return Object.freeze({
    stage: SAMPLING_LOCK_STAGE,
    schemaVersion: requireSchemaVersion(value.schemaVersion),
    runId: requireNonEmptyString(value.runId, "runId"),
    protocolSeed: requireNonEmptyString(value.protocolSeed, "protocolSeed"),
    longSessionMinRequests: 20,
    collectionWindowEndsAt: requireIsoInstant(value.collectionWindowEndsAt),
    maxInventoryRefreshes: requireNonNegativeInteger(
      value.maxInventoryRefreshes,
      "maxInventoryRefreshes",
    ),
    modelRegistryDigest: requireDigest(value.modelRegistryDigest, "modelRegistryDigest"),
    estimatorPolicyDigest: requireDigest(value.estimatorPolicyDigest, "estimatorPolicyDigest"),
  });
}

/** Validate the post-sample target record and optionally bind its sampling predecessor. */
export function validateTargetSelectionRecord(
  value: unknown,
  samplingLock?: SamplingProtocolLock,
): TargetSelectionRecord {
  if (!isRecord(value)) schemaError("target-selection record must be an object");
  requireExactFields(value, [
    "api",
    "inventoryDigest",
    "model",
    "provider",
    "providerPolicyDigest",
    "reasoning",
    "runId",
    "sampleDigest",
    "samplingLockDigest",
    "schemaVersion",
    "stage",
  ]);
  if (value.stage !== TARGET_SELECTION_STAGE) schemaError("invalid target-selection stage");

  const record = Object.freeze({
    stage: TARGET_SELECTION_STAGE,
    schemaVersion: requireSchemaVersion(value.schemaVersion),
    runId: requireNonEmptyString(value.runId, "runId"),
    provider: requireNonEmptyString(value.provider, "provider"),
    model: requireNonEmptyString(value.model, "model"),
    api: requireNonEmptyString(value.api, "api"),
    reasoning: requireNonEmptyString(value.reasoning, "reasoning"),
    samplingLockDigest: requireDigest(value.samplingLockDigest, "samplingLockDigest"),
    inventoryDigest: requireDigest(value.inventoryDigest, "inventoryDigest"),
    sampleDigest: requireDigest(value.sampleDigest, "sampleDigest"),
    providerPolicyDigest: requireDigest(value.providerPolicyDigest, "providerPolicyDigest"),
  });

  if (samplingLock !== undefined) assertTargetSelectionPredecessor(record, samplingLock);
  return record;
}

/** Validate the final pre-replay lock and optionally bind both predecessors. */
export function validateEvaluationProtocolLock(
  value: unknown,
  predecessors?: EvaluationLockPredecessors,
): EvaluationProtocolLock {
  if (!isRecord(value)) schemaError("evaluation lock must be an object");
  requireExactFields(value, [
    "bootstrapDigest",
    "estimatorPolicyDigest",
    "fixtureDigest",
    "goldDigest",
    "inventoryDigest",
    "pricingDigest",
    "providerPolicyDigest",
    "reportPolicyDigest",
    "rubricDigest",
    "runId",
    "sampleDigest",
    "samplingLockDigest",
    "schemaVersion",
    "stage",
    "targetSelectionDigest",
  ]);
  if (value.stage !== EVALUATION_LOCK_STAGE) schemaError("invalid evaluation lock stage");

  const record = Object.freeze({
    stage: EVALUATION_LOCK_STAGE,
    schemaVersion: requireSchemaVersion(value.schemaVersion),
    runId: requireNonEmptyString(value.runId, "runId"),
    samplingLockDigest: requireDigest(value.samplingLockDigest, "samplingLockDigest"),
    targetSelectionDigest: requireDigest(value.targetSelectionDigest, "targetSelectionDigest"),
    inventoryDigest: requireDigest(value.inventoryDigest, "inventoryDigest"),
    sampleDigest: requireDigest(value.sampleDigest, "sampleDigest"),
    estimatorPolicyDigest: requireDigest(value.estimatorPolicyDigest, "estimatorPolicyDigest"),
    providerPolicyDigest: requireDigest(value.providerPolicyDigest, "providerPolicyDigest"),
    rubricDigest: requireDigest(value.rubricDigest, "rubricDigest"),
    pricingDigest: requireDigest(value.pricingDigest, "pricingDigest"),
    goldDigest: requireDigest(value.goldDigest, "goldDigest"),
    fixtureDigest: requireDigest(value.fixtureDigest, "fixtureDigest"),
    bootstrapDigest: requireDigest(value.bootstrapDigest, "bootstrapDigest"),
    reportPolicyDigest: requireDigest(value.reportPolicyDigest, "reportPolicyDigest"),
  });

  if (predecessors !== undefined) assertEvaluationLockPredecessors(record, predecessors);
  return record;
}

/** Validate a protocol lock by its declared stage. */
export function validateProtocolLock(value: unknown): ProtocolLock {
  if (!isRecord(value)) schemaError("protocol lock must be an object");
  switch (value.stage) {
    case SAMPLING_LOCK_STAGE:
      return validateSamplingProtocolLock(value);
    case TARGET_SELECTION_STAGE:
      return validateTargetSelectionRecord(value);
    case EVALUATION_LOCK_STAGE:
      return validateEvaluationProtocolLock(value);
    default:
      return schemaError("unknown protocol lock stage");
  }
}

/** Assert that a target record is owned by its pre-inventory sampling lock. */
export function assertTargetSelectionPredecessor(
  targetSelection: TargetSelectionRecord,
  samplingLock: SamplingProtocolLock,
): void {
  validateSamplingProtocolLock(samplingLock);
  validateTargetSelectionRecord(targetSelection);
  if (targetSelection.runId !== samplingLock.runId) {
    integrityError("target-selection runId must match the sampling lock runId");
  }
  if (targetSelection.samplingLockDigest !== canonicalDigest(samplingLock)) {
    integrityError("target-selection samplingLockDigest does not bind its sampling lock");
  }
}

/** Assert that the final lock preserves all predecessor identities and policies. */
export function assertEvaluationLockPredecessors(
  evaluationLock: EvaluationProtocolLock,
  predecessors: EvaluationLockPredecessors,
): void {
  const samplingLock = validateSamplingProtocolLock(predecessors.samplingLock);
  const targetSelection = validateTargetSelectionRecord(predecessors.targetSelection, samplingLock);
  validateEvaluationProtocolLock(evaluationLock);

  if (
    evaluationLock.runId !== samplingLock.runId ||
    evaluationLock.runId !== targetSelection.runId ||
    evaluationLock.samplingLockDigest !== canonicalDigest(samplingLock) ||
    evaluationLock.targetSelectionDigest !== canonicalDigest(targetSelection) ||
    evaluationLock.inventoryDigest !== targetSelection.inventoryDigest ||
    evaluationLock.sampleDigest !== targetSelection.sampleDigest ||
    evaluationLock.estimatorPolicyDigest !== samplingLock.estimatorPolicyDigest ||
    evaluationLock.providerPolicyDigest !== targetSelection.providerPolicyDigest
  ) {
    integrityError("evaluation lock does not preserve its predecessor identities and policies");
  }
}

/**
 * Reject a changed lock under its existing run ID. A changed run ID deliberately
 * starts a distinct immutable record and is therefore allowed.
 */
export function assertLockImmutable(persisted: unknown, current: unknown): void {
  const persistedLock = validateProtocolLock(persisted);
  const currentLock = validateProtocolLock(current);
  if (persistedLock.stage !== currentLock.stage) {
    schemaError("lock immutability comparison requires matching stages");
  }
  if (
    persistedLock.runId === currentLock.runId &&
    canonicalJson(persistedLock) !== canonicalJson(currentLock)
  ) {
    integrityError("a protocol lock cannot change under the same runId");
  }
}

/** Derive the canonical snapshot-cluster bootstrap seed as lowercase SHA-256 hex. */
export function deriveBootstrapSeed(protocolSeed: string, sampleDigest: string): string {
  requireNonEmptyString(protocolSeed, "protocolSeed");
  requireDigest(sampleDigest, "sampleDigest");
  return sha256(
    canonicalJson({
      domain: SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.domain,
      protocolSeed,
      sampleDigest,
    }),
  );
}

/** Encode an unsigned 32-bit counter in big-endian order. */
export function uint32BigEndian(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    schemaError("uint32 counter must be an integer in [0, 4294967295]");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

/**
 * Draw one snapshot index with SHA-256 counter/rejection sampling. The digest
 * is interpreted as an unsigned 256-bit big-endian integer before modulo mapping.
 */
export function drawBootstrapIndex(bootstrapSeed: string, n: number, r: number, j: number): number {
  requireDigest(bootstrapSeed, "bootstrapSeed");
  if (!Number.isInteger(n) || n < 1) schemaError("n must be a positive integer");
  const seedBytes = Buffer.from(bootstrapSeed, "hex");
  const max = 1n << 256n;
  const limit = max - (max % BigInt(n));

  for (let k = 0; k <= 0xffff_ffff; k += 1) {
    const digest = createHash("sha256")
      .update(seedBytes)
      .update(SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.drawDomain, "utf8")
      .update(uint32BigEndian(r))
      .update(uint32BigEndian(j))
      .update(uint32BigEndian(k))
      .digest("hex");
    const unsigned = BigInt(`0x${digest}`);
    if (unsigned < limit) return Number(unsigned % BigInt(n));
  }
  return schemaError("bootstrap rejection counter exhausted");
}

/** Return one deterministic snapshot-cluster resample as zero-based indices. */
export function drawBootstrapResample(
  bootstrapSeed: string,
  n: number,
  r: number,
): readonly number[] {
  requireDigest(bootstrapSeed, "bootstrapSeed");
  if (!Number.isInteger(n) || n < 1) schemaError("n must be a positive integer");
  uint32BigEndian(r);

  const resample: number[] = [];
  for (let j = 0; j < n; j += 1) resample.push(drawBootstrapIndex(bootstrapSeed, n, r, j));
  return resample;
}
