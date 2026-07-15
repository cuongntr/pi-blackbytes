/** Blinded quality, safety, and deterministic snapshot-cluster scoring. */

import {
  SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY,
  deriveBootstrapSeed,
  drawBootstrapResample,
} from "./protocol.js";
import { EvidenceStoreError } from "./types.js";

export const RECALL_DELTA_THRESHOLD = -0.05;
export const FRAGILE_THRESHOLD_DISTANCE = 0.02;

export type FactJudgment = "correct" | "partial" | "omitted" | "incorrect" | "contradicted";
export type ReplayArm = "native" | "selective";

/** This is the complete scorer-facing contract. It deliberately has no arm or cost metadata. */
export interface BlindedFactInput {
  readonly factId: string;
  readonly judgment: FactJudgment;
}

export interface BlindedCheckpointInput {
  readonly snapshotId: string;
  readonly replicateIndex: number;
  readonly checkpointIndex: 1 | 2 | 3 | 4 | 5;
  readonly facts: readonly BlindedFactInput[];
  /** A locked blinded rubric result. It is available only once T-012C is available. */
  readonly taskCompletion?: boolean;
  readonly severeEvent?: boolean;
}

export interface FactScore {
  readonly factId: string;
  readonly score: 0 | 0.5 | 1;
  readonly contradiction: boolean;
}

export interface BlindedCheckpointScore {
  readonly snapshotId: string;
  readonly replicateIndex: number;
  readonly checkpointIndex: 1 | 2 | 3 | 4 | 5;
  readonly facts: readonly FactScore[];
  readonly recall: number;
  readonly taskCompletion?: boolean;
  readonly severeEvent: boolean;
}

/** Arm identity is introduced only after the blinded scorer has returned this score. */
export interface ArmCheckpointScore extends BlindedCheckpointScore {
  readonly arm: ReplayArm;
}

export interface SnapshotArmScore {
  readonly snapshotId: string;
  readonly arm: ReplayArm;
  readonly recall: number;
  readonly taskCompletion?: number;
  readonly severeEventRate: number;
  readonly replicateVariance: number;
}

export interface BootstrapInterval {
  readonly lower: number;
  readonly upper: number;
  readonly values: readonly number[];
  readonly flattenedIndices: readonly number[];
  readonly bootstrapSeed: string;
}

export interface QualityScoreReport {
  readonly recallDelta: number;
  readonly taskCompletionDelta?: number;
  readonly taskCompletionStatus: "available" | "unavailable";
  readonly severeEventRates: Readonly<Record<ReplayArm, number>>;
  readonly treatmentOnlySevereEvent: boolean;
  readonly safetyRegression: boolean;
  readonly snapshotScores: readonly SnapshotArmScore[];
  readonly bootstrap: BootstrapInterval;
  readonly fragileThresholds: readonly string[];
}

function fail(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail(`${field} must be a positive integer`);
  return value as number;
}

function checkpoint(value: unknown): 1 | 2 | 3 | 4 | 5 {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 5)
    fail("checkpointIndex must be in 1..5");
  return value as 1 | 2 | 3 | 4 | 5;
}

function judgment(value: unknown): FactJudgment {
  if (!["correct", "partial", "omitted", "incorrect", "contradicted"].includes(value as string))
    fail("fact judgment is invalid");
  return value as FactJudgment;
}

/** Rejects every metadata field that could reveal arm/order/cost/summary information to a scorer. */
export function validateBlindedCheckpointInput(value: unknown): BlindedCheckpointInput {
  if (!isRecord(value)) fail("blinded checkpoint input must be an object");
  const task = Object.hasOwn(value, "taskCompletion");
  const severe = Object.hasOwn(value, "severeEvent");
  if (
    !exactKeys(value, [
      "checkpointIndex",
      "facts",
      "replicateIndex",
      "snapshotId",
      ...(task ? ["taskCompletion"] : []),
      ...(severe ? ["severeEvent"] : []),
    ])
  ) {
    fail("blinded scorer input contains non-blinded metadata");
  }
  if (!Array.isArray(value.facts) || value.facts.length === 0)
    fail("facts must be a non-empty array");
  const factIds = new Set<string>();
  const facts = value.facts.map((item) => {
    if (!isRecord(item) || !exactKeys(item, ["factId", "judgment"])) fail("invalid blinded fact");
    const factId = nonEmptyString(item.factId, "factId");
    if (factIds.has(factId)) fail("factId must be unique per checkpoint");
    factIds.add(factId);
    return Object.freeze({ factId, judgment: judgment(item.judgment) });
  });
  if (task && typeof value.taskCompletion !== "boolean") fail("taskCompletion must be boolean");
  if (severe && typeof value.severeEvent !== "boolean") fail("severeEvent must be boolean");
  return Object.freeze({
    snapshotId: nonEmptyString(value.snapshotId, "snapshotId"),
    replicateIndex: positiveInteger(value.replicateIndex, "replicateIndex"),
    checkpointIndex: checkpoint(value.checkpointIndex),
    facts: Object.freeze(facts),
    ...(task ? { taskCompletion: value.taskCompletion as boolean } : {}),
    ...(severe ? { severeEvent: value.severeEvent as boolean } : {}),
  });
}

/** Score atomic facts exactly as the locked rubric specifies. */
export function scoreAtomicFact(input: BlindedFactInput): FactScore {
  const checked = validateBlindedCheckpointInput({
    snapshotId: "validation",
    replicateIndex: 1,
    checkpointIndex: 1,
    facts: [input],
  }).facts[0]!;
  const score: 0 | 0.5 | 1 =
    checked.judgment === "correct" ? 1 : checked.judgment === "partial" ? 0.5 : 0;
  return Object.freeze({
    factId: checked.factId,
    score,
    contradiction: checked.judgment === "incorrect" || checked.judgment === "contradicted",
  });
}

export function scoreBlindedCheckpoint(value: unknown): BlindedCheckpointScore {
  const input = validateBlindedCheckpointInput(value);
  const facts = Object.freeze(input.facts.map(scoreAtomicFact));
  return Object.freeze({
    snapshotId: input.snapshotId,
    replicateIndex: input.replicateIndex,
    checkpointIndex: input.checkpointIndex,
    facts,
    recall: facts.reduce((sum, fact) => sum + fact.score, 0) / facts.length,
    ...(input.taskCompletion === undefined ? {} : { taskCompletion: input.taskCompletion }),
    severeEvent: input.severeEvent ?? false,
  });
}

function mean(values: readonly number[]): number {
  if (values.length === 0) fail("metric requires at least one value");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return mean(values.map((value) => (value - average) ** 2));
}

function arm(value: unknown): ReplayArm {
  if (value !== "native" && value !== "selective") fail("arm must be native or selective");
  return value;
}

function validateArmCheckpointScore(value: unknown): ArmCheckpointScore {
  if (!isRecord(value)) fail("arm score must be an object");
  const { arm: suppliedArm, ...blinded } = value;
  const score = scoreBlindedCheckpoint(blinded);
  return Object.freeze({ ...score, arm: arm(suppliedArm) });
}

function snapshotArmScores(records: readonly ArmCheckpointScore[]): readonly SnapshotArmScore[] {
  const groups = new Map<string, ArmCheckpointScore[]>();
  for (const record of records) {
    const key = `${record.snapshotId}\u0000${record.arm}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return Object.freeze(
    [...groups.values()].map((group) => {
      const first = group[0]!;
      const byReplicate = new Map<number, ArmCheckpointScore[]>();
      for (const item of group) {
        const replicate = byReplicate.get(item.replicateIndex) ?? [];
        replicate.push(item);
        byReplicate.set(item.replicateIndex, replicate);
      }
      const replicateRecalls = [...byReplicate.values()].map((items) =>
        mean(items.map((item) => item.recall)),
      );
      const tasks = group.flatMap((item) =>
        item.taskCompletion === undefined ? [] : [item.taskCompletion ? 1 : 0],
      );
      return Object.freeze({
        snapshotId: first.snapshotId,
        arm: first.arm,
        recall: mean(group.map((item) => item.recall)),
        ...(tasks.length === 0 ? {} : { taskCompletion: mean(tasks) }),
        severeEventRate: mean(group.map((item) => (item.severeEvent ? 1 : 0))),
        replicateVariance: variance(replicateRecalls),
      });
    }),
  );
}

function percentile(values: readonly number[], rank: number): number {
  if (values.length < rank) fail("nearest-rank percentile is outside the bootstrap sample");
  return [...values].sort((left, right) => left - right)[rank - 1]!;
}

function normalizedSampleDigest(value: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) fail("sampleDigest must be a SHA-256 hex digest");
  return value.toLowerCase();
}

/**
 * Resample complete snapshot clusters. `metric` receives all records for every drawn cluster,
 * never individual arm or replicate records, so paired structure cannot be broken.
 */
export function bootstrapSnapshotClusters<T extends { readonly snapshotId: string }>(
  records: readonly T[],
  protocolSeed: string,
  sampleDigest: string,
  metric: (resample: readonly T[], clusters: readonly (readonly T[])[]) => number,
): BootstrapInterval {
  if (records.length === 0) fail("bootstrap requires snapshot records");
  const clusters = new Map<string, T[]>();
  for (const record of records) {
    const id = nonEmptyString(record.snapshotId, "snapshotId");
    const cluster = clusters.get(id) ?? [];
    cluster.push(record);
    clusters.set(id, cluster);
  }
  const clusterValues = [...clusters.values()].map((cluster) => Object.freeze([...cluster]));
  const seed = deriveBootstrapSeed(protocolSeed, normalizedSampleDigest(sampleDigest));
  const values: number[] = [];
  const flattenedIndices: number[] = [];
  for (let r = 0; r < SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.resamples; r += 1) {
    const indices = drawBootstrapResample(seed, clusterValues.length, r);
    flattenedIndices.push(...indices);
    const sampledClusters = indices.map((index) => clusterValues[index]!);
    const sampled = sampledClusters.flat();
    const value = metric(Object.freeze(sampled), Object.freeze(sampledClusters));
    if (!Number.isFinite(value)) fail("bootstrap metric must be finite");
    values.push(value);
  }
  return Object.freeze({
    lower: percentile(values, SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.lowerNearestRank),
    upper: percentile(values, SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.upperNearestRank),
    values: Object.freeze(values),
    flattenedIndices: Object.freeze(flattenedIndices),
    bootstrapSeed: seed,
  });
}

function pairedSnapshotDelta(scores: readonly SnapshotArmScore[]): number {
  const bySnapshot = new Map<string, Partial<Record<ReplayArm, SnapshotArmScore>>>();
  for (const score of scores) {
    const pair = bySnapshot.get(score.snapshotId) ?? {};
    pair[score.arm] = score;
    bySnapshot.set(score.snapshotId, pair);
  }
  const deltas = [...bySnapshot.values()].map((pair) => {
    if (pair.native === undefined || pair.selective === undefined)
      fail("each snapshot requires both arms");
    return pair.selective.recall - pair.native.recall;
  });
  return mean(deltas);
}

function fragile(value: number, threshold: number): boolean {
  return Math.abs(value - threshold) <= FRAGILE_THRESHOLD_DISTANCE;
}

/** Aggregate arm-labelled blinded scores with equal weight for every snapshot. */
export function scoreQuality(
  inputs: readonly unknown[],
  protocolSeed: string,
  sampleDigest: string,
  taskCompletionAvailable: boolean,
): QualityScoreReport {
  if (inputs.length === 0) fail("quality scoring requires checkpoint scores");
  const records = Object.freeze(inputs.map(validateArmCheckpointScore));
  const snapshots = snapshotArmScores(records);
  const recallDelta = pairedSnapshotDelta(snapshots);
  const byArm = (which: ReplayArm) => snapshots.filter((score) => score.arm === which);
  const native = byArm("native");
  const selective = byArm("selective");
  if (native.length !== selective.length || native.length === 0)
    fail("each snapshot requires both arms");
  const taskPairs = snapshots.filter((score) => score.taskCompletion !== undefined);
  if (taskCompletionAvailable && taskPairs.length !== snapshots.length)
    fail("T-012C task-completion scoring is incomplete");
  const taskCompletionDelta = taskCompletionAvailable
    ? mean(selective.map((score) => score.taskCompletion!)) -
      mean(native.map((score) => score.taskCompletion!))
    : undefined;
  const severeEventRates = Object.freeze({
    native: mean(native.map((score) => score.severeEventRate)),
    selective: mean(selective.map((score) => score.severeEventRate)),
  });
  const treatmentOnlySevereEvent = selective.some(
    (score) =>
      score.severeEventRate > 0 &&
      native.find((item) => item.snapshotId === score.snapshotId)!.severeEventRate === 0,
  );
  const thresholds = [
    ...(fragile(recallDelta, RECALL_DELTA_THRESHOLD) ? ["recall-delta"] : []),
    ...(taskCompletionDelta !== undefined && fragile(taskCompletionDelta, 0)
      ? ["task-completion-delta"]
      : []),
  ];
  return Object.freeze({
    recallDelta,
    ...(taskCompletionDelta === undefined ? {} : { taskCompletionDelta }),
    taskCompletionStatus: taskCompletionAvailable ? "available" : "unavailable",
    severeEventRates,
    treatmentOnlySevereEvent,
    safetyRegression: severeEventRates.selective > severeEventRates.native,
    snapshotScores: snapshots,
    bootstrap: bootstrapSnapshotClusters(
      snapshots,
      protocolSeed,
      sampleDigest,
      (_records, clusters) => mean(clusters.map((cluster) => pairedSnapshotDelta(cluster))),
    ),
    fragileThresholds: Object.freeze(thresholds),
  });
}
