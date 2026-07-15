/** Actual-usage-only checkpoint-five utility and break-even scoring. */

import { EvidenceStoreError } from "./types.js";

export type CostArm = "native" | "selective";
export type BreakEvenCheckpoint = 1 | 2 | 3 | 4 | 5 | ">5";

export interface ActualUsageChannels {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface LockedPriceCard {
  readonly priceCardDigest: string;
  readonly inputPerToken: number;
  readonly outputPerToken: number;
  readonly cacheReadPerToken: number;
  readonly cacheWritePerToken: number;
}

/** One billed provider attempt, including failed/retried attempts, with actual usage only. */
export interface ActualCostAttempt {
  readonly snapshotId: string;
  readonly arm: CostArm;
  readonly replicateIndex: number;
  readonly checkpointIndex: 0 | 1 | 2 | 3 | 4 | 5;
  readonly kind: "summary" | "checkpoint";
  readonly usageCompleteness: "complete" | "missing";
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly cost?: { readonly total?: number };
  };
  readonly priceCardDigest: string;
}

export interface SnapshotCostScore {
  readonly snapshotId: string;
  readonly nativeCost5: number;
  readonly selectiveCost5: number;
  readonly reduction5: number;
  readonly breakEven: BreakEvenCheckpoint;
}

export interface UtilityScoreReport {
  readonly status: "complete" | "incomplete";
  readonly snapshots: readonly SnapshotCostScore[];
  readonly medianReduction5?: number;
  readonly breakEvenBy5Rate?: number;
  readonly fragileThresholds: readonly string[];
  readonly reasons: readonly string[];
}

export const REDUCTION5_PASS_THRESHOLD = 0.1;
export const REDUCTION5_REVISE_THRESHOLD = 0.05;
export const BREAK_EVEN_BY_5_THRESHOLD = 0.5;
export const COST_FRAGILE_THRESHOLD_DISTANCE = 0.02;

function fail(code: "E_EVAL_SCHEMA" | "E_EVAL_INCOMPLETE", message: string): never {
  throw new EvidenceStoreError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail("E_EVAL_SCHEMA", `${field} must be a non-empty string`);
  return value;
}

function finiteNonnegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail("E_EVAL_SCHEMA", `${field} must be a finite non-negative number`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail("E_EVAL_SCHEMA", `${field} must be a positive integer`);
  return value as number;
}

function arm(value: unknown): CostArm {
  if (value !== "native" && value !== "selective")
    fail("E_EVAL_SCHEMA", "arm must be native or selective");
  return value;
}

function checkpoint(value: unknown): 0 | 1 | 2 | 3 | 4 | 5 {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 5)
    fail("E_EVAL_SCHEMA", "checkpointIndex must be in 0..5");
  return value as 0 | 1 | 2 | 3 | 4 | 5;
}

function digest(value: unknown, field: string): string {
  const result = string(value, field);
  if (!/^[a-f0-9]{64}$/.test(result))
    fail("E_EVAL_SCHEMA", `${field} must be a lowercase SHA-256 digest`);
  return result;
}

export function validateLockedPriceCard(value: unknown): LockedPriceCard {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "cacheReadPerToken",
      "cacheWritePerToken",
      "inputPerToken",
      "outputPerToken",
      "priceCardDigest",
    ])
  )
    fail("E_EVAL_SCHEMA", "locked price card has invalid fields");
  return Object.freeze({
    priceCardDigest: digest(value.priceCardDigest, "priceCardDigest"),
    inputPerToken: finiteNonnegative(value.inputPerToken, "inputPerToken"),
    outputPerToken: finiteNonnegative(value.outputPerToken, "outputPerToken"),
    cacheReadPerToken: finiteNonnegative(value.cacheReadPerToken, "cacheReadPerToken"),
    cacheWritePerToken: finiteNonnegative(value.cacheWritePerToken, "cacheWritePerToken"),
  });
}

/** Strict schema: estimated, qualified, and token-estimate fields cannot enter cost accounting. */
export function validateActualCostAttempt(value: unknown): ActualCostAttempt {
  if (!isRecord(value)) fail("E_EVAL_SCHEMA", "cost attempt must be an object");
  const hasUsage = Object.hasOwn(value, "usage");
  if (
    !exactKeys(value, [
      "arm",
      "checkpointIndex",
      "kind",
      "priceCardDigest",
      "replicateIndex",
      "snapshotId",
      "usageCompleteness",
      ...(hasUsage ? ["usage"] : []),
    ])
  )
    fail("E_EVAL_SCHEMA", "cost attempt contains non-actual usage metadata");
  if (value.kind !== "summary" && value.kind !== "checkpoint")
    fail("E_EVAL_SCHEMA", "cost attempt kind is invalid");
  if (value.usageCompleteness !== "complete" && value.usageCompleteness !== "missing")
    fail("E_EVAL_SCHEMA", "usageCompleteness is invalid");
  if (value.kind === "summary" && (value.arm !== "selective" || value.checkpointIndex !== 0))
    fail("E_EVAL_SCHEMA", "summary cost belongs only to selective checkpoint zero");
  if (value.kind === "checkpoint" && value.checkpointIndex === 0)
    fail("E_EVAL_SCHEMA", "checkpoint cost must be in 1..5");
  let usage: ActualCostAttempt["usage"];
  if (hasUsage) {
    if (!isRecord(value.usage)) fail("E_EVAL_SCHEMA", "usage must be an object");
    const keys = Object.keys(value.usage);
    if (keys.some((key) => !["cacheRead", "cacheWrite", "cost", "input", "output"].includes(key)))
      fail("E_EVAL_SCHEMA", "usage contains non-actual channels");
    const hasCost = Object.hasOwn(value.usage, "cost");
    const hasAllChannels = ["input", "output", "cacheRead", "cacheWrite"].every((key) =>
      Object.hasOwn(value.usage!, key),
    );
    if (!hasCost && !hasAllChannels)
      fail("E_EVAL_SCHEMA", "usage requires cost.total or all actual channels");
    if (hasCost) {
      if (!isRecord(value.usage.cost) || !exactKeys(value.usage.cost, ["total"]))
        fail("E_EVAL_SCHEMA", "usage.cost must contain only total");
      finiteNonnegative((value.usage.cost as Record<string, unknown>).total, "usage.cost.total");
    }
    usage = Object.freeze({
      input:
        value.usage.input === undefined
          ? undefined
          : finiteNonnegative(value.usage.input, "usage.input"),
      output:
        value.usage.output === undefined
          ? undefined
          : finiteNonnegative(value.usage.output, "usage.output"),
      cacheRead:
        value.usage.cacheRead === undefined
          ? undefined
          : finiteNonnegative(value.usage.cacheRead, "usage.cacheRead"),
      cacheWrite:
        value.usage.cacheWrite === undefined
          ? undefined
          : finiteNonnegative(value.usage.cacheWrite, "usage.cacheWrite"),
      ...(hasCost
        ? {
            cost: Object.freeze({
              total: (value.usage.cost as Record<string, unknown>).total as number,
            }),
          }
        : {}),
    });
  }
  if (value.usageCompleteness === "complete" && usage === undefined)
    fail("E_EVAL_SCHEMA", "complete actual usage requires usage");
  return Object.freeze({
    snapshotId: string(value.snapshotId, "snapshotId"),
    arm: arm(value.arm),
    replicateIndex: positiveInteger(value.replicateIndex, "replicateIndex"),
    checkpointIndex: checkpoint(value.checkpointIndex),
    kind: value.kind,
    usageCompleteness: value.usageCompleteness,
    ...(usage === undefined ? {} : { usage }),
    priceCardDigest: digest(value.priceCardDigest, "priceCardDigest"),
  });
}

/** Prefer provider-reported total; price-card recomputation requires every actual usage channel. */
export function actualAttemptCost(attemptValue: unknown, cardValue: unknown): number | undefined {
  const attempt = validateActualCostAttempt(attemptValue);
  const card = validateLockedPriceCard(cardValue);
  if (attempt.priceCardDigest !== card.priceCardDigest)
    fail("E_EVAL_SCHEMA", "attempt price card does not match locked card");
  if (attempt.usageCompleteness !== "complete" || attempt.usage === undefined) return undefined;
  if (attempt.usage.cost?.total !== undefined) return attempt.usage.cost.total;
  const { input, output, cacheRead, cacheWrite } = attempt.usage;
  if ([input, output, cacheRead, cacheWrite].some((channel) => channel === undefined))
    return undefined;
  return (
    input! * card.inputPerToken +
    output! * card.outputPerToken +
    cacheRead! * card.cacheReadPerToken +
    cacheWrite! * card.cacheWritePerToken
  );
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function incomplete(reason: string): UtilityScoreReport {
  return Object.freeze({
    status: "incomplete",
    snapshots: Object.freeze([]),
    fragileThresholds: Object.freeze([]),
    reasons: Object.freeze([reason]),
  });
}

/**
 * Score only complete actual provider accounting. Each arm/replicate must have actual cost at all five
 * checkpoints; selective additionally carries summary-generation cost at checkpoint zero.
 */
export function scoreUtility(
  attemptValues: readonly unknown[],
  cardValue: unknown,
): UtilityScoreReport {
  const card = validateLockedPriceCard(cardValue);
  if (attemptValues.length === 0) return incomplete("no-actual-usage");
  const attempts = attemptValues.map(validateActualCostAttempt);
  const costs = attempts.map((attempt) => actualAttemptCost(attempt, card));
  if (costs.some((cost) => cost === undefined)) return incomplete("mandatory-actual-usage-missing");
  const groups = new Map<string, Array<{ attempt: ActualCostAttempt; cost: number }>>();
  for (const [index, attempt] of attempts.entries()) {
    const key = `${attempt.snapshotId}\u0000${attempt.arm}\u0000${attempt.replicateIndex}`;
    const group = groups.get(key) ?? [];
    group.push({ attempt, cost: costs[index]! });
    groups.set(key, group);
  }
  const perSnapshot = new Map<string, Partial<Record<CostArm, number[]>>>();
  for (const group of groups.values()) {
    const first = group[0]!.attempt;
    const checkpoints = new Set<number>(
      group
        .filter((item) => item.attempt.kind === "checkpoint")
        .map((item) => item.attempt.checkpointIndex),
    );
    if ([1, 2, 3, 4, 5].some((index) => !checkpoints.has(index)))
      return incomplete("mandatory-checkpoint-usage-missing");
    if (first.arm === "selective" && !group.some((item) => item.attempt.kind === "summary"))
      return incomplete("mandatory-summary-usage-missing");
    const snapshot = perSnapshot.get(first.snapshotId) ?? {};
    const costsForArm = snapshot[first.arm] ?? [];
    costsForArm.push(
      ...[1, 2, 3, 4, 5].map((checkpointIndex) =>
        group
          .filter((item) => item.attempt.checkpointIndex <= checkpointIndex)
          .reduce((sum, item) => sum + item.cost, 0),
      ),
    );
    snapshot[first.arm] = costsForArm;
    perSnapshot.set(first.snapshotId, snapshot);
  }
  const snapshots: SnapshotCostScore[] = [];
  for (const [snapshotId, arms] of perSnapshot) {
    if (arms.native === undefined || arms.selective === undefined)
      return incomplete("paired-arm-usage-missing");
    if (
      arms.native.length % 5 !== 0 ||
      arms.selective.length % 5 !== 0 ||
      arms.native.length !== arms.selective.length
    )
      return incomplete("unpaired-replicate-usage");
    const replicateCount = arms.native.length / 5;
    const nativeCumulative = Array.from({ length: 5 }, (_, index) =>
      mean(
        Array.from(
          { length: replicateCount },
          (_, replicate) => arms.native![replicate * 5 + index]!,
        ),
      ),
    );
    const selectiveCumulative = Array.from({ length: 5 }, (_, index) =>
      mean(
        Array.from(
          { length: replicateCount },
          (_, replicate) => arms.selective![replicate * 5 + index]!,
        ),
      ),
    );
    const nativeCost5 = nativeCumulative[4]!;
    const selectiveCost5 = selectiveCumulative[4]!;
    if (nativeCost5 === 0) return incomplete("native-cost-five-is-zero");
    const breakEvenIndex = selectiveCumulative.findIndex(
      (cost, index) => cost <= nativeCumulative[index]!,
    );
    snapshots.push(
      Object.freeze({
        snapshotId,
        nativeCost5,
        selectiveCost5,
        reduction5: (nativeCost5 - selectiveCost5) / nativeCost5,
        breakEven: breakEvenIndex < 0 ? ">5" : ((breakEvenIndex + 1) as 1 | 2 | 3 | 4 | 5),
      }),
    );
  }
  const reductions = snapshots.map((snapshot) => snapshot.reduction5);
  const breakEvenBy5Rate = mean(snapshots.map((snapshot) => (snapshot.breakEven === ">5" ? 0 : 1)));
  const medianReduction5 = median(reductions);
  return Object.freeze({
    status: "complete",
    snapshots: Object.freeze(snapshots),
    medianReduction5,
    breakEvenBy5Rate,
    fragileThresholds: Object.freeze([
      ...(Math.abs(medianReduction5 - REDUCTION5_PASS_THRESHOLD) <= COST_FRAGILE_THRESHOLD_DISTANCE
        ? ["reduction5-pass"]
        : []),
      ...(Math.abs(medianReduction5 - REDUCTION5_REVISE_THRESHOLD) <=
      COST_FRAGILE_THRESHOLD_DISTANCE
        ? ["reduction5-revise"]
        : []),
      ...(Math.abs(breakEvenBy5Rate - BREAK_EVEN_BY_5_THRESHOLD) <= COST_FRAGILE_THRESHOLD_DISTANCE
        ? ["break-even-by-five"]
        : []),
    ]),
    reasons: Object.freeze([]),
  });
}
