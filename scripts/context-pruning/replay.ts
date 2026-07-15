/** Authenticated, provider-free paired replay planning and synthetic execution. */

import { canonicalDigest, canonicalJson } from "./canonical-json.js";
import {
  buildSummaryGenerationAccess,
  loadAuthenticatedReplaySource,
  type readReplaySnapshot,
} from "./snapshots.js";
import type { ReplayModelVisibleEntry, ReplaySnapshotAccess } from "./snapshots.js";
import { EvidenceStoreError } from "./types.js";

export const REPLAY_CHECKPOINT_COUNT = 5;
export const MIN_REPLAY_REPLICATES = 3;
/** Conservative hermetic-planning bound; prevents unbounded in-memory schedule expansion. */
export const MAX_REPLAY_REPLICATES = 100;

export type ReplayArm = "native" | "selective";
export type CandidateRangeRepresentation = "native-range" | "selective-summary";

export interface ReplayPlanInput {
  readonly protocolSeed: string;
  readonly replicateCount: number;
  readonly requestBudget: number;
}

/** This is deliberately the entire summary prompt payload. */
export interface SummaryGenerationInput {
  readonly instruction: string;
  readonly candidateMessages: readonly Record<string, unknown>[];
}

export interface ReplaySharedContext {
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly copyReferenceDigest: string;
  readonly catalogDigest: string;
  readonly targetSelectionDigest: string;
  readonly systemPromptDigest: string;
  readonly toolSchemaDigest: string;
  readonly fixture: unknown;
  readonly requestBudget: number;
  readonly sharedDigest: string;
}

export interface ReplayCheckpointContext {
  readonly checkpointIndex: 1 | 2 | 3 | 4 | 5;
  readonly requestEntryId: string;
  readonly shared: ReplaySharedContext;
  readonly beforeCandidate: readonly ReplayModelVisibleEntry[];
  readonly candidateRange: {
    readonly representation: CandidateRangeRepresentation;
    readonly messages: readonly Record<string, unknown>[] | null;
  };
  readonly afterCandidate: readonly ReplayModelVisibleEntry[];
  readonly nativeContextDigest: string;
}

export interface ReplayReplicatePlan {
  readonly replicateIndex: number;
  readonly armOrder: readonly [ReplayArm, ReplayArm];
  readonly summaryGeneration: SummaryGenerationInput;
  readonly nativeContexts: readonly ReplayCheckpointContext[];
  readonly selectiveContexts: readonly ReplayCheckpointContext[];
}

export interface ReplayPlan {
  readonly schemaVersion: 2;
  readonly snapshotId: string;
  readonly protocolSeed: string;
  readonly replicateCount: number;
  readonly requestBudget: number;
  readonly shared: ReplaySharedContext;
  readonly replicates: readonly ReplayReplicatePlan[];
  readonly planDigest: string;
}

export interface ReplayAttempt {
  readonly replicateIndex: number;
  readonly kind: "summary" | "checkpoint";
  readonly arm: ReplayArm;
  readonly checkpointIndex?: 1 | 2 | 3 | 4 | 5;
  readonly inputDigest: string;
  readonly output: string;
}
export interface SyntheticReplayResult {
  readonly attempts: readonly ReplayAttempt[];
}

export interface ReplayModelAdapter {
  generate(input: unknown): string;
}

export class SyntheticModelAdapter implements ReplayModelAdapter {
  readonly calls: Array<{ readonly input: unknown; readonly output: string }> = [];
  generate(input: unknown): string {
    const output = canonicalDigest({
      domain: "pi-blackbytes:context-pruning:synthetic-model:v2",
      input,
    });
    this.calls.push(Object.freeze({ input, output }));
    return output;
  }
}

const DIGEST = /^[0-9a-f]{64}$/;
function schema(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}
function integrity(message: string): never {
  throw new EvidenceStoreError("E_EVAL_INTEGRITY", message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) {
    schema(`Expected exactly fields: ${[...fields].sort().join(", ")}`);
  }
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    schema(`${field} must be a non-empty string`);
  return value;
}
function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    schema(`${field} must be a positive integer`);
  return value as number;
}
function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST.test(value))
    schema(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

/** Strictly config-only; no candidate/history/request content can cross this boundary. */
export function validateReplayPlanInput(value: unknown): ReplayPlanInput {
  if (!isRecord(value)) schema("replay input must be an object");
  exact(value, ["protocolSeed", "replicateCount", "requestBudget"]);
  const replicateCount = positive(value.replicateCount, "replicateCount");
  if (replicateCount < MIN_REPLAY_REPLICATES)
    schema(`replicateCount must be at least ${MIN_REPLAY_REPLICATES}`);
  if (replicateCount > MAX_REPLAY_REPLICATES)
    schema(`replicateCount must be at most ${MAX_REPLAY_REPLICATES}`);
  return Object.freeze({
    protocolSeed: string(value.protocolSeed, "protocolSeed"),
    replicateCount,
    requestBudget: positive(value.requestBudget, "requestBudget"),
  });
}

function expectedArmOrder(
  protocolSeed: string,
  snapshotId: string,
  replicateIndex: number,
): readonly [ReplayArm, ReplayArm] {
  const initial = canonicalDigest({
    domain: "pi-blackbytes:context-pruning:replay-arm-order:v2",
    protocolSeed,
    snapshotId,
  });
  const nativeFirst = Number.parseInt(initial.slice(0, 2), 16) % 2 === 0;
  const first = nativeFirst ? ["native", "selective"] : ["selective", "native"];
  return (replicateIndex % 2 === 1 ? first : [first[1], first[0]]) as unknown as readonly [
    ReplayArm,
    ReplayArm,
  ];
}

function buildShared(
  snapshot: ReturnType<typeof readReplaySnapshot>,
  requestBudget: number,
): ReplaySharedContext {
  const unsigned = {
    snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshot.snapshotDigest,
    copyReferenceDigest: snapshot.copyReferenceDigest,
    catalogDigest: snapshot.catalogDigest,
    targetSelectionDigest: snapshot.targetSelectionDigest,
    systemPromptDigest: snapshot.systemPromptDigest,
    toolSchemaDigest: snapshot.toolSchemaDigest,
    fixture: snapshot.fixture,
    requestBudget,
  };
  return Object.freeze({
    ...unsigned,
    sharedDigest: canonicalDigest({
      domain: "pi-blackbytes:context-pruning:replay-shared:v2",
      ...unsigned,
    }),
  });
}

function deepCloneFreeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(deepCloneFreeze)) as T;
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          deepCloneFreeze(item),
        ]),
      ),
    ) as T;
  }
  return value;
}

/** Pi-compatible user carrier, never a bare string in a message array. */
function summaryCarrier(summary: string): Record<string, unknown> {
  return deepCloneFreeze({
    role: "user",
    content: [{ type: "text", text: `Selective history summary:\n${summary}` }],
  });
}

function contextsForArm(
  arm: ReplayArm,
  source: Awaited<ReturnType<typeof loadAuthenticatedReplaySource>>,
  shared: ReplaySharedContext,
): readonly ReplayCheckpointContext[] {
  return deepCloneFreeze(
    source.checkpoints.map((checkpoint) => ({
      checkpointIndex: checkpoint.checkpointIndex,
      requestEntryId: checkpoint.requestEntryId,
      shared: deepCloneFreeze(shared),
      beforeCandidate: deepCloneFreeze(checkpoint.beforeCandidate),
      candidateRange: {
        representation: arm === "native" ? "native-range" : "selective-summary",
        messages:
          arm === "native"
            ? deepCloneFreeze(source.candidateRange.messages.map((entry) => entry.message))
            : null,
      },
      afterCandidate: deepCloneFreeze(checkpoint.afterCandidate),
      nativeContextDigest: checkpoint.nativeContextDigest,
    })),
  );
}
function unsignedPlan(plan: ReplayPlan): Omit<ReplayPlan, "planDigest"> {
  const { planDigest: _ignored, ...unsigned } = plan;
  return unsigned;
}

/** Build only from a verified selected branch and a config-only caller request. */
export async function buildReplayPlan(
  replayAccess: ReplaySnapshotAccess,
  selection: unknown,
  inputValue: unknown,
): Promise<ReplayPlan> {
  const input = validateReplayPlanInput(inputValue);
  const source = await loadAuthenticatedReplaySource(replayAccess, selection);
  const snapshot = source.snapshot;
  const shared = buildShared(snapshot, input.requestBudget);
  const summaryAccess = await buildSummaryGenerationAccess(replayAccess, selection);
  const replicates = deepCloneFreeze(
    Array.from({ length: input.replicateCount }, (_, index) => ({
      replicateIndex: index + 1,
      armOrder: expectedArmOrder(input.protocolSeed, snapshot.snapshotId, index + 1),
      summaryGeneration: {
        instruction: summaryAccess.instruction,
        candidateMessages: summaryAccess.candidateMessages,
      },
      nativeContexts: contextsForArm("native", source, shared),
      selectiveContexts: contextsForArm("selective", source, shared),
    })),
  );
  const unsigned: Omit<ReplayPlan, "planDigest"> = {
    schemaVersion: 2,
    snapshotId: snapshot.snapshotId,
    protocolSeed: input.protocolSeed,
    replicateCount: input.replicateCount,
    requestBudget: input.requestBudget,
    shared,
    replicates,
  };
  return Object.freeze({
    ...unsigned,
    planDigest: canonicalDigest({
      domain: "pi-blackbytes:context-pruning:replay-plan:v2",
      plan: unsigned,
    }),
  });
}

function pairedContext(
  context: ReplayCheckpointContext,
): Omit<ReplayCheckpointContext, "candidateRange"> {
  const { candidateRange: _candidate, ...shared } = context;
  return shared;
}
export function assertPairedTeacherForcing(plan: ReplayPlan): void {
  for (const replicate of plan.replicates) {
    for (let index = 0; index < REPLAY_CHECKPOINT_COUNT; index += 1) {
      const native = replicate.nativeContexts[index];
      const selective = replicate.selectiveContexts[index];
      if (
        native === undefined ||
        selective === undefined ||
        canonicalJson(pairedContext(native)) !== canonicalJson(pairedContext(selective))
      )
        integrity("teacher-forced arm contexts differ outside the candidate representation");
      if (
        native.candidateRange.representation !== "native-range" ||
        selective.candidateRange.representation !== "selective-summary" ||
        native.candidateRange.messages === null ||
        selective.candidateRange.messages !== null
      )
        integrity("teacher-forced candidate representation is invalid");
    }
  }
}

/**
 * A digest is not authority: rederive the complete expected plan using authenticated
 * access and compare every field, which rejects even a correctly re-digested forgery.
 */
export async function validateReplayPlan(
  replayAccess: ReplaySnapshotAccess,
  selection: unknown,
  inputValue: unknown,
  value: unknown,
): Promise<ReplayPlan> {
  const input = validateReplayPlanInput(inputValue);
  if (!isRecord(value)) schema("replay plan must be an object");
  exact(value, [
    "planDigest",
    "protocolSeed",
    "replicateCount",
    "replicates",
    "requestBudget",
    "schemaVersion",
    "shared",
    "snapshotId",
  ]);
  if (value.schemaVersion !== 2) schema("replay plan schemaVersion must equal 2");
  digest(value.planDigest, "planDigest");
  string(value.protocolSeed, "protocolSeed");
  const replicateCount = positive(value.replicateCount, "replicateCount");
  if (replicateCount < MIN_REPLAY_REPLICATES || replicateCount > MAX_REPLAY_REPLICATES) {
    schema(`replicateCount must be ${MIN_REPLAY_REPLICATES}..${MAX_REPLAY_REPLICATES}`);
  }
  positive(value.requestBudget, "requestBudget");
  digest(value.snapshotId, "snapshotId");
  if (!isRecord(value.shared)) schema("replay shared context must be an object");
  const sharedDigest = value.shared.sharedDigest;
  digest(sharedDigest, "sharedDigest");
  const expected = await buildReplayPlan(replayAccess, selection, input);
  if (canonicalJson(value) !== canonicalJson(expected))
    integrity("replay plan does not equal its authenticated derivation");
  const claimed = value.planDigest;
  if (
    claimed !==
    canonicalDigest({
      domain: "pi-blackbytes:context-pruning:replay-plan:v2",
      plan: unsignedPlan(expected),
    })
  )
    integrity("replay plan digest mismatch");
  assertPairedTeacherForcing(expected);
  return expected;
}

/** Synthetic execution is deliberately gated by the same authenticated rederivation. */
export async function executeSyntheticReplay(
  replayAccess: ReplaySnapshotAccess,
  selection: unknown,
  inputValue: unknown,
  planValue: unknown,
  adapter: ReplayModelAdapter = new SyntheticModelAdapter(),
): Promise<SyntheticReplayResult> {
  const plan = await validateReplayPlan(replayAccess, selection, inputValue, planValue);
  const attempts: ReplayAttempt[] = [];
  for (const replicate of plan.replicates) {
    let summary: string | undefined;
    for (const arm of replicate.armOrder) {
      if (arm === "selective") {
        summary = adapter.generate(deepCloneFreeze(replicate.summaryGeneration));
        attempts.push(
          Object.freeze({
            replicateIndex: replicate.replicateIndex,
            kind: "summary",
            arm,
            inputDigest: canonicalDigest(replicate.summaryGeneration),
            output: summary,
          }),
        );
      }
      for (const template of arm === "native"
        ? replicate.nativeContexts
        : replicate.selectiveContexts) {
        const input =
          arm === "native"
            ? template
            : deepCloneFreeze({
                ...template,
                candidateRange: {
                  ...template.candidateRange,
                  messages: [summaryCarrier(summary!)],
                },
              });
        const output = adapter.generate(deepCloneFreeze(input));
        attempts.push(
          Object.freeze({
            replicateIndex: replicate.replicateIndex,
            kind: "checkpoint",
            arm,
            checkpointIndex: template.checkpointIndex,
            inputDigest: canonicalDigest(input),
            output,
          }),
        );
      }
    }
  }
  return Object.freeze({ attempts: Object.freeze(attempts) });
}

/** Content-free output suitable for the strict CLI dry-run. */
export function replayPlanSummary(plan: ReplayPlan): {
  readonly planDigest: string;
  readonly snapshotId: string;
  readonly replicateCount: number;
  readonly checkpointAttemptCount: number;
  readonly summaryGenerationCount: number;
} {
  return Object.freeze({
    planDigest: plan.planDigest,
    snapshotId: plan.snapshotId,
    replicateCount: plan.replicateCount,
    checkpointAttemptCount: plan.replicateCount * 2 * REPLAY_CHECKPOINT_COUNT,
    summaryGenerationCount: plan.replicateCount,
  });
}
