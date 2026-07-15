/** Pure, non-overridable partition of locked context-pruning evidence. */

import {
  BREAK_EVEN_BY_5_THRESHOLD,
  REDUCTION5_PASS_THRESHOLD,
  REDUCTION5_REVISE_THRESHOLD,
} from "./cost.js";
import { BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS } from "./lifecycle/benchmark.js";
import { RECALL_DELTA_THRESHOLD } from "./scoring.js";
import type { QualityScoreReport } from "./scoring.js";
import { EvidenceStoreError } from "./types.js";

export const DECISION_P95_REVISE_MAX_MS = 50;
export const REQUIRED_SAMPLED_SESSION_COUNT = 40;
export const MINIMUM_QUALIFYING_SNAPSHOT_COUNT = 10;

export type DecisionOutcome = "GO" | "REVISE" | "NO-GO";

export interface QualityDecisionEvidence
  extends Pick<QualityScoreReport, "recallDelta" | "treatmentOnlySevereEvent"> {
  readonly taskCompletionDelta: number;
}

export type UtilityDecisionEvidence =
  | {
      readonly status: "complete";
      readonly medianReduction5: number;
      readonly breakEvenBy5Rate: number;
    }
  | {
      readonly status: "missing";
      readonly collectionExtension:
        | { readonly status: "permitted"; readonly description: string }
        | { readonly status: "exhausted"; readonly description: string };
    };

export interface ApplicabilityDecisionEvidence {
  readonly sampledSessionCount: number;
  readonly qualifyingSnapshotCount: number;
}

export interface NonInvasiveRemedy {
  readonly kind: "non-invasive";
  readonly description: string;
}

export interface FeasibilityDecisionEvidence {
  readonly provenanceFalsePositiveCount: number;
  readonly lifecycleScenarioMissCount: number;
  readonly lifecycleFix: NonInvasiveRemedy | null;
  readonly p95Ms: number;
  readonly performanceOptimization: NonInvasiveRemedy | null;
}

/** Complete evidence contract. It intentionally has no outcome or override field. */
export interface DecisionInput {
  readonly quality: QualityDecisionEvidence;
  readonly utility: UtilityDecisionEvidence;
  readonly applicability: ApplicabilityDecisionEvidence;
  readonly feasibility: FeasibilityDecisionEvidence;
}

export interface DecisionGate {
  readonly id: "G001" | "G002" | "G003" | "G004";
  readonly pass: boolean;
}

export interface DecisionTraceStep {
  readonly id: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface DecisionResult {
  readonly outcome: DecisionOutcome;
  readonly gates: readonly DecisionGate[];
  readonly trace: readonly DecisionTraceStep[];
}

function schema(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    schema(`Expected exactly fields: ${expected.join(", ")}`);
  }
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) schema(`${field} must be finite`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    schema(`${field} must be a non-negative safe integer`);
  return value as number;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    schema(`${field} must be a non-empty string`);
  return value;
}

function remedy(value: unknown, field: string): NonInvasiveRemedy | null {
  if (value === null) return null;
  if (!isRecord(value)) schema(`${field} must be null or a remedy`);
  exactKeys(value, ["description", "kind"]);
  if (value.kind !== "non-invasive") schema(`${field}.kind must be non-invasive`);
  return Object.freeze({
    kind: "non-invasive",
    description: nonEmptyString(value.description, `${field}.description`),
  });
}

function quality(value: unknown): QualityDecisionEvidence {
  if (!isRecord(value)) schema("quality must be an object");
  exactKeys(value, ["recallDelta", "taskCompletionDelta", "treatmentOnlySevereEvent"]);
  if (typeof value.treatmentOnlySevereEvent !== "boolean")
    schema("quality.treatmentOnlySevereEvent must be boolean");
  return Object.freeze({
    recallDelta: finiteNumber(value.recallDelta, "quality.recallDelta"),
    taskCompletionDelta: finiteNumber(value.taskCompletionDelta, "quality.taskCompletionDelta"),
    treatmentOnlySevereEvent: value.treatmentOnlySevereEvent,
  });
}

function utility(value: unknown): UtilityDecisionEvidence {
  if (!isRecord(value)) schema("utility must be an object");
  if (value.status === "complete") {
    exactKeys(value, ["breakEvenBy5Rate", "medianReduction5", "status"]);
    const breakEvenBy5Rate = finiteNumber(value.breakEvenBy5Rate, "utility.breakEvenBy5Rate");
    if (breakEvenBy5Rate < 0 || breakEvenBy5Rate > 1)
      schema("utility.breakEvenBy5Rate must be in 0..1");
    return Object.freeze({
      status: "complete",
      medianReduction5: finiteNumber(value.medianReduction5, "utility.medianReduction5"),
      breakEvenBy5Rate,
    });
  }
  if (value.status !== "missing") schema("utility.status must be complete or missing");
  exactKeys(value, ["collectionExtension", "status"]);
  if (!isRecord(value.collectionExtension)) schema("utility.collectionExtension must be an object");
  exactKeys(value.collectionExtension, ["description", "status"]);
  if (
    value.collectionExtension.status !== "permitted" &&
    value.collectionExtension.status !== "exhausted"
  ) {
    schema("utility.collectionExtension.status must be permitted or exhausted");
  }
  return Object.freeze({
    status: "missing",
    collectionExtension: Object.freeze({
      status: value.collectionExtension.status,
      description: nonEmptyString(
        value.collectionExtension.description,
        "utility.collectionExtension.description",
      ),
    }),
  });
}

function applicability(value: unknown): ApplicabilityDecisionEvidence {
  if (!isRecord(value)) schema("applicability must be an object");
  exactKeys(value, ["qualifyingSnapshotCount", "sampledSessionCount"]);
  const sampledSessionCount = nonNegativeInteger(
    value.sampledSessionCount,
    "applicability.sampledSessionCount",
  );
  const qualifyingSnapshotCount = nonNegativeInteger(
    value.qualifyingSnapshotCount,
    "applicability.qualifyingSnapshotCount",
  );
  if (sampledSessionCount > REQUIRED_SAMPLED_SESSION_COUNT)
    schema(`applicability.sampledSessionCount must not exceed ${REQUIRED_SAMPLED_SESSION_COUNT}`);
  if (qualifyingSnapshotCount > sampledSessionCount)
    schema("applicability.qualifyingSnapshotCount must not exceed sampledSessionCount");
  return Object.freeze({ sampledSessionCount, qualifyingSnapshotCount });
}

function feasibility(value: unknown): FeasibilityDecisionEvidence {
  if (!isRecord(value)) schema("feasibility must be an object");
  exactKeys(value, [
    "lifecycleFix",
    "lifecycleScenarioMissCount",
    "p95Ms",
    "performanceOptimization",
    "provenanceFalsePositiveCount",
  ]);
  const p95Ms = finiteNumber(value.p95Ms, "feasibility.p95Ms");
  if (p95Ms < 0) schema("feasibility.p95Ms must be non-negative");
  return Object.freeze({
    provenanceFalsePositiveCount: nonNegativeInteger(
      value.provenanceFalsePositiveCount,
      "feasibility.provenanceFalsePositiveCount",
    ),
    lifecycleScenarioMissCount: nonNegativeInteger(
      value.lifecycleScenarioMissCount,
      "feasibility.lifecycleScenarioMissCount",
    ),
    lifecycleFix: remedy(value.lifecycleFix, "feasibility.lifecycleFix"),
    p95Ms,
    performanceOptimization: remedy(
      value.performanceOptimization,
      "feasibility.performanceOptimization",
    ),
  });
}

/** Validate and copy the complete decision-only evidence schema. */
export function validateDecisionInput(value: unknown): DecisionInput {
  if (!isRecord(value)) schema("decision input must be an object");
  exactKeys(value, ["applicability", "feasibility", "quality", "utility"]);
  return Object.freeze({
    quality: quality(value.quality),
    utility: utility(value.utility),
    applicability: applicability(value.applicability),
    feasibility: feasibility(value.feasibility),
  });
}

function step(id: string, pass: boolean, detail: string): DecisionTraceStep {
  return Object.freeze({ id, pass, detail });
}

/** Evaluate all gates and permitted near-misses without accepting an operator-selected outcome. */
export function decide(value: unknown): DecisionResult {
  const input = validateDecisionInput(value);
  const trace: DecisionTraceStep[] = [];
  const qualityPass =
    input.quality.recallDelta >= RECALL_DELTA_THRESHOLD &&
    input.quality.taskCompletionDelta >= 0 &&
    !input.quality.treatmentOnlySevereEvent;
  trace.push(
    step(
      "G001.recall",
      input.quality.recallDelta >= RECALL_DELTA_THRESHOLD,
      `${input.quality.recallDelta} >= ${RECALL_DELTA_THRESHOLD}`,
    ),
    step(
      "G001.completion",
      input.quality.taskCompletionDelta >= 0,
      `${input.quality.taskCompletionDelta} >= 0`,
    ),
    step(
      "G001.severe-event",
      !input.quality.treatmentOnlySevereEvent,
      `${input.quality.treatmentOnlySevereEvent} must be false`,
    ),
  );

  const utilityComplete = input.utility.status === "complete";
  const utilityPass =
    utilityComplete &&
    input.utility.medianReduction5 >= REDUCTION5_PASS_THRESHOLD &&
    input.utility.breakEvenBy5Rate >= BREAK_EVEN_BY_5_THRESHOLD;
  trace.push(
    step("G002.actual-usage", utilityComplete, `${input.utility.status} must be complete`),
    step(
      "G002.median-reduction",
      utilityComplete && input.utility.medianReduction5 >= REDUCTION5_PASS_THRESHOLD,
      `${utilityComplete ? input.utility.medianReduction5 : "missing"} >= ${REDUCTION5_PASS_THRESHOLD}`,
    ),
    step(
      "G002.break-even-by-5",
      utilityComplete && input.utility.breakEvenBy5Rate >= BREAK_EVEN_BY_5_THRESHOLD,
      `${utilityComplete ? input.utility.breakEvenBy5Rate : "missing"} >= ${BREAK_EVEN_BY_5_THRESHOLD}`,
    ),
  );

  const applicabilityPass =
    input.applicability.sampledSessionCount === REQUIRED_SAMPLED_SESSION_COUNT &&
    input.applicability.qualifyingSnapshotCount >= MINIMUM_QUALIFYING_SNAPSHOT_COUNT;
  trace.push(
    step(
      "G003.sample-count",
      input.applicability.sampledSessionCount === REQUIRED_SAMPLED_SESSION_COUNT,
      `${input.applicability.sampledSessionCount} = ${REQUIRED_SAMPLED_SESSION_COUNT}`,
    ),
    step(
      "G003.qualifying-snapshots",
      input.applicability.qualifyingSnapshotCount >= MINIMUM_QUALIFYING_SNAPSHOT_COUNT,
      `${input.applicability.qualifyingSnapshotCount} >= ${MINIMUM_QUALIFYING_SNAPSHOT_COUNT}`,
    ),
  );

  const provenancePass = input.feasibility.provenanceFalsePositiveCount === 0;
  const lifecyclePass = input.feasibility.lifecycleScenarioMissCount === 0;
  const performancePass = input.feasibility.p95Ms < BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS;
  const feasibilityPass = provenancePass && lifecyclePass && performancePass;
  trace.push(
    step(
      "G004.provenance",
      provenancePass,
      `${input.feasibility.provenanceFalsePositiveCount} = 0 false positives`,
    ),
    step(
      "G004.lifecycle-scenarios",
      lifecyclePass,
      `${input.feasibility.lifecycleScenarioMissCount} = 0 misses`,
    ),
    step(
      "G004.p95",
      performancePass,
      `${input.feasibility.p95Ms}ms < ${BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS}ms`,
    ),
  );

  const utilityDeviation =
    feasibilityPass &&
    utilityComplete &&
    input.utility.medianReduction5 >= REDUCTION5_REVISE_THRESHOLD &&
    input.utility.medianReduction5 < REDUCTION5_PASS_THRESHOLD &&
    input.utility.breakEvenBy5Rate >= BREAK_EVEN_BY_5_THRESHOLD;
  const performanceDeviation =
    utilityPass &&
    provenancePass &&
    lifecyclePass &&
    input.feasibility.p95Ms >= BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS &&
    input.feasibility.p95Ms <= DECISION_P95_REVISE_MAX_MS &&
    input.feasibility.performanceOptimization !== null;
  const lifecycleDeviation =
    utilityPass &&
    provenancePass &&
    performancePass &&
    input.feasibility.lifecycleScenarioMissCount === 1 &&
    input.feasibility.lifecycleFix !== null;
  const missingProviderDataDeviation =
    feasibilityPass &&
    input.utility.status === "missing" &&
    input.utility.collectionExtension.status === "permitted";
  const deviations = [
    utilityDeviation,
    performanceDeviation,
    lifecycleDeviation,
    missingProviderDataDeviation,
  ];
  const deviationCount = deviations.filter(Boolean).length;
  trace.push(
    step(
      "REVISE.utility",
      utilityDeviation,
      `[${REDUCTION5_REVISE_THRESHOLD}, ${REDUCTION5_PASS_THRESHOLD}) and break-even >= ${BREAK_EVEN_BY_5_THRESHOLD}`,
    ),
    step(
      "REVISE.performance",
      performanceDeviation,
      `[${BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS}ms, ${DECISION_P95_REVISE_MAX_MS}ms] with non-invasive optimization`,
    ),
    step("REVISE.lifecycle", lifecycleDeviation, "one non-provenance miss with non-invasive fix"),
    step(
      "REVISE.provider-data",
      missingProviderDataDeviation,
      "one permitted collection extension",
    ),
    step("REVISE.exactly-one-deviation", deviationCount === 1, `count = ${deviationCount}`),
  );

  const gates = Object.freeze([
    Object.freeze({ id: "G001" as const, pass: qualityPass }),
    Object.freeze({ id: "G002" as const, pass: utilityPass }),
    Object.freeze({ id: "G003" as const, pass: applicabilityPass }),
    Object.freeze({ id: "G004" as const, pass: feasibilityPass }),
  ]);
  const outcome: DecisionOutcome =
    qualityPass && utilityPass && applicabilityPass && feasibilityPass
      ? "GO"
      : qualityPass && applicabilityPass && deviationCount === 1
        ? "REVISE"
        : "NO-GO";
  trace.push(step("OUTCOME", true, outcome));
  return Object.freeze({ outcome, gates, trace: Object.freeze(trace) });
}
