/** Confirmed provider replay and T-009B generated-compaction handoff. */
import { TextDecoder } from "node:util";

import { canonicalDigest, canonicalJson } from "./canonical-json.js";
import { appendEvent } from "./evidence-store.js";
import {
  captureCompactionUsage,
  createCompactionUsageProbeArtifact,
  parseReportedUsage,
  persistCompactionUsageProbe,
  verifyCompactionUsageProbe,
} from "./lifecycle/compaction-usage.js";
import type {
  CompactionUsageProbeArtifact,
  PiLifecycleFact,
} from "./lifecycle/compaction-usage.js";
import {
  ensurePrivateDir,
  safeRunFileExists,
  safeRunPublishExclusiveFile,
  safeRunReadFile,
  safeRunReaddir,
  safeRunStat,
} from "./path-safety.js";
import type { SafeRun } from "./path-safety.js";
import { validateTargetSelectionRecord } from "./protocol.js";
import type { TargetSelectionRecord } from "./protocol.js";
import { REPLAY_CHECKPOINT_COUNT, validateReplayPlan } from "./replay.js";
import type { ReplayArm, ReplayPlan } from "./replay.js";
import type { ReplaySnapshotAccess } from "./snapshots.js";
import { EvidenceStoreError } from "./types.js";
import type { EvalErrorCode, EvidenceEvent } from "./types.js";

export const PROVIDER_REPLAY_LEDGER_PATH = "provider-replay-attempts.jsonl";
export const PROVIDER_REPLAY_OUTPUT_DIRECTORY = "provider-replay-outputs";
export const COMPACTION_ACCOUNTING_RESOLUTION_DIRECTORY = "compaction-accounting-resolutions";
export const COMPACTION_ACCOUNTING_DISPOSITION_DIRECTORY = "compaction-accounting-dispositions";
export const COMPACTION_ACCOUNTING_NOT_APPLICABLE_DIRECTORY =
  "compaction-accounting-not-applicable";
export const GENERATED_COMPACTION_PROOF_LEDGER_PATH = "generated-compaction-proof-attempts.jsonl";
/** Fixed, private T-009B inputs. No command accepts alternate paths. */
export const T009B_PROVIDER_POLICY_PATH =
  "private/t009b-compaction-accounting/provider-policy.json";
export const T009B_PROOF_POLICY_PATH = "private/t009b-compaction-accounting/proof-policy.json";
export const T009B_ENVIRONMENT_PATH = "private/t009b-compaction-accounting/environment.json";
export const MAX_RETRIES_PER_PLANNED_REQUEST = 1;
export const GENERATED_COMPACTION_PROOF_SCHEDULE = Object.freeze([
  "native-compaction",
  "following-main",
] as const);
const DIGEST = /^[a-f0-9]{64}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

type RecordValue = Record<string, unknown>;
export type ProviderRequestKind = "summary" | "checkpoint";
export type ProviderFailureClass =
  | "timeout"
  | "rate-limit"
  | "network"
  | "server"
  | "invalid-request"
  | "auth"
  | "unknown";
export type BillingDisposition = "billed" | "unbilled" | "unknown";
export type CacheIsolationStatus = "isolated" | "not-isolated" | "unknown";
export type CacheStrategy = "per-plan-per-request-v1" | "disabled-v1";
export interface ProviderReplayTarget {
  readonly provider: string;
  readonly model: string;
  readonly api: string;
  readonly reasoning: string;
}
export interface ProviderPolicy {
  readonly maxRetriesPerPlannedRequest: 1;
  readonly retryableErrorClasses: readonly ProviderFailureClass[];
  readonly timeoutMs: { readonly summary: number; readonly checkpoint: number };
  readonly upperCostPerAttempt: { readonly summary: number; readonly checkpoint: number };
  readonly priceCardDigest: string;
  readonly cacheStrategy: CacheStrategy;
  readonly confirmationPolicy: "exact-plan-target-call-count-upper-cost-v2";
}
export interface ProviderReplayConfirmation {
  readonly decision: "confirm";
  readonly confirmationDigest: string;
  readonly planDigest: string;
  readonly targetSelectionDigest: string;
  readonly providerPolicyDigest: string;
  readonly priceCardDigest: string;
  readonly target: ProviderReplayTarget;
  readonly plannedCallCount: number;
  readonly upperCost: number;
}
export interface ProviderCacheCapability {
  readonly configuredStrategy: CacheStrategy;
  readonly observedIsolation: CacheIsolationStatus;
  readonly namespace?: string;
}
export interface ProviderReplayRequest {
  readonly requestId: string;
  readonly kind: ProviderRequestKind;
  readonly arm: ReplayArm;
  readonly replicateIndex: number;
  readonly checkpointIndex?: 1 | 2 | 3 | 4 | 5;
  readonly attempt: 1 | 2;
  readonly retryOf?: string;
  readonly timeoutMs: number;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly input: unknown;
  readonly inputDigest: string;
  readonly confirmedTarget: ProviderReplayTarget;
  readonly cacheKey: string;
}
export type ProviderAdapterResult =
  | {
      readonly ok: true;
      readonly output: string;
      readonly usage?: unknown;
      readonly billed: BillingDisposition;
    }
  | {
      readonly ok: false;
      readonly failureClass: ProviderFailureClass;
      readonly usage?: unknown;
      readonly billed: BillingDisposition;
    };
export interface ProviderReplayAdapter {
  readonly kind: "fake" | "external";
  readonly target: ProviderReplayTarget;
  readonly cacheCapability: ProviderCacheCapability;
  execute(request: ProviderReplayRequest): Promise<ProviderAdapterResult>;
}
export class FakeReplayAdapter implements ProviderReplayAdapter {
  readonly kind = "fake" as const;
  readonly calls: ProviderReplayRequest[] = [];
  readonly target: ProviderReplayTarget;
  readonly cacheCapability: ProviderCacheCapability;
  #results: ProviderAdapterResult[];
  constructor(
    results: readonly ProviderAdapterResult[],
    target: ProviderReplayTarget = {
      provider: "fake-provider",
      model: "fake-model",
      api: "fake-api",
      reasoning: "fake-reasoning",
    },
    cacheCapability: ProviderCacheCapability = {
      configuredStrategy: "per-plan-per-request-v1",
      observedIsolation: "isolated",
      namespace: "fake",
    },
  ) {
    this.#results = [...results];
    this.target = Object.freeze({ ...target });
    this.cacheCapability = Object.freeze({ ...cacheCapability });
  }
  async execute(request: ProviderReplayRequest): Promise<ProviderAdapterResult> {
    this.calls.push(request);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("FakeReplayAdapter has no configured result");
    return result;
  }
}

/** The fixed policy used only by the internally constructed T-009B scenario. */
export interface GeneratedCompactionProofPolicy {
  readonly maxRetriesPerPlannedRequest: 1;
  readonly upperCostPerAttempt: {
    readonly nativeCompaction: number;
    readonly followingMain: number;
  };
  readonly priceCardDigest: string;
  readonly cacheStrategy: CacheStrategy;
  readonly confirmationPolicy: "exact-generated-compaction-proof-v1";
}
export interface T009BEnvironmentDeclaration {
  readonly schemaVersion: 1;
  readonly type: "t009b-generated-compaction-environment-v1";
  readonly runnerVersion: string;
  readonly platform: string;
}

export interface GeneratedCompactionProofConfirmation {
  readonly decision: "confirm";
  readonly confirmationDigest: string;
  readonly targetSelectionDigest: string;
  readonly providerPolicyDigest: string;
  readonly proofPolicyDigest: string;
  readonly priceCardDigest: string;
  readonly target: ProviderReplayTarget;
  readonly generatedInputDigest: string;
  readonly plannedCallCount: number;
  readonly upperCost: number;
}
/**
 * Strict, per-request T-009B adapter. The runner owns ordering, retries,
 * timeout, target and cache keys; adapters may return only content-free Pi
 * hook facts for the request they were issued.
 */
export interface GeneratedCompactionProofRequest {
  readonly requestId: string;
  readonly operation: (typeof GENERATED_COMPACTION_PROOF_SCHEDULE)[number];
  readonly attempt: 1 | 2;
  readonly retryOf?: string;
  readonly timeoutMs: number;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly target: ProviderReplayTarget;
  readonly cacheKey: string;
}
export type GeneratedCompactionProofAdapterResult =
  | {
      readonly ok: true;
      readonly billed: BillingDisposition;
      readonly facts: readonly PiLifecycleFact[];
    }
  | {
      readonly ok: false;
      readonly billed: BillingDisposition;
      readonly failureClass: ProviderFailureClass;
      readonly facts: readonly PiLifecycleFact[];
    };
export interface GeneratedCompactionProofAdapter {
  readonly kind: "fake" | "external";
  readonly target: ProviderReplayTarget;
  readonly cacheCapability: ProviderCacheCapability;
  execute(request: GeneratedCompactionProofRequest): Promise<GeneratedCompactionProofAdapterResult>;
}
export interface CompactionAccountingResolutionArtifact {
  readonly schemaVersion: 1;
  readonly type: "compaction-accounting-resolution-v1";
  readonly resolutionDigest: string;
  readonly targetSelectionDigest: string;
  readonly providerPolicyDigest: string;
  readonly priceCardDigest: string;
  readonly environmentDigest: string;
  readonly generatedInputDigest: string;
  readonly confirmationDigest: string;
  readonly captureDigest: string;
  readonly probeDigest: string;
  readonly target: ProviderReplayTarget;
  readonly cacheCapability: ProviderCacheCapability;
  readonly outcome: "complete" | "blocking-incomplete";
}
export interface GeneratedCompactionProofRunInput {
  readonly safeRun: SafeRun;
  readonly targetSelection: TargetSelectionRecord;
  readonly providerPolicy: ProviderPolicy;
  readonly proofPolicy: GeneratedCompactionProofPolicy;
  readonly environmentDigest: string;
  readonly confirmation?: GeneratedCompactionProofConfirmation | string;
  readonly adapter: GeneratedCompactionProofAdapter;
  readonly now: () => string;
}
export interface GeneratedCompactionProofPlan {
  readonly target: ProviderReplayTarget;
  readonly generatedInputDeclaration: {
    readonly generatedSession: "t009b-generated-native-compaction-session-v1";
    readonly generatedScenario: "native-compaction-then-following-main-v1";
  };
  readonly generatedInputDigest: string;
  readonly plannedCalls: readonly (typeof GENERATED_COMPACTION_PROOF_SCHEDULE)[number][];
  readonly plannedCallCount: number;
  readonly retryMax: 1;
  readonly upperCost: number;
  readonly proofPolicyDigest: string;
  readonly environmentDigest: string;
  readonly providerPolicyDigest: string;
  readonly confirmationDigest: string;
  readonly planDigest: string;
}

export interface GeneratedCompactionProofRunResult {
  readonly status: "completed" | "refused";
  readonly plannedCallCount: number;
  readonly upperCost: number;
  readonly resolution: CompactionAccountingResolutionArtifact;
}

export interface T009BPreparedInputs {
  readonly targetSelection: TargetSelectionRecord;
  readonly providerPolicy: ProviderPolicy;
  readonly proofPolicy: GeneratedCompactionProofPolicy;
  readonly environment: T009BEnvironmentDeclaration;
  readonly environmentDigest: string;
}

export interface ProviderReplayGate {
  readonly frozenPlanDigest: string;
  readonly resolution: CompactionAccountingResolutionArtifact;
}
export interface ProviderReplayPreparationInput {
  readonly safeRun: SafeRun;
  readonly replayAccess: ReplaySnapshotAccess;
  readonly selection: unknown;
  readonly replayInput: unknown;
  readonly plan: unknown;
  readonly targetSelection: TargetSelectionRecord;
  readonly providerPolicy: ProviderPolicy;
  readonly confirmation?: ProviderReplayConfirmation | string;
  readonly gate: ProviderReplayGate;
}
export interface ProviderReplayRunInput extends ProviderReplayPreparationInput {
  readonly adapter: ProviderReplayAdapter;
  readonly now: () => string;
}
export interface ProviderReplayRunResult {
  readonly status: "completed" | "refused" | "failed";
  readonly plannedCallCount: number;
  readonly upperCost: number;
  readonly attemptedCallCount: number;
  readonly completedRequestCount: number;
  readonly cacheIsolation: CacheIsolationStatus;
}

interface ScheduledRequest {
  readonly requestId: string;
  readonly kind: ProviderRequestKind;
  readonly arm: ReplayArm;
  readonly replicateIndex: number;
  readonly checkpointIndex?: 1 | 2 | 3 | 4 | 5;
  readonly input: unknown;
}
type Phase = "start" | "result" | "usage" | "skip";
interface LedgerEvent {
  readonly eventId: string;
  readonly timestamp: string;
  readonly type: string;
  readonly data: RecordValue;
  readonly failed?: true;
  readonly error?: string;
}
interface LedgerState {
  readonly starts: Map<string, RecordValue>;
  readonly results: Map<string, RecordValue>;
  readonly usages: Map<string, RecordValue>;
  readonly skips: Set<string>;
  readonly origins: Map<string, RecordValue>;
}

function fail(code: EvalErrorCode, message: string): never {
  throw new EvidenceStoreError(code, message);
}
function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: RecordValue, keys: readonly string[], message: string): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort()))
    fail("E_EVAL_INTEGRITY", message);
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value)
    fail("E_EVAL_INTEGRITY", "provider replay ledger timestamp is invalid");
  return value;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function isFailureClass(value: unknown): value is ProviderFailureClass {
  return [
    "timeout",
    "rate-limit",
    "network",
    "server",
    "invalid-request",
    "auth",
    "unknown",
  ].includes(value as string);
}
function isBilling(value: unknown): value is BillingDisposition {
  return value === "billed" || value === "unbilled" || value === "unknown";
}
function exactTarget(left: ProviderReplayTarget, right: ProviderReplayTarget): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function frozen<T>(value: T): T {
  return Object.freeze(value) as T;
}

export function validateProviderPolicy(value: ProviderPolicy): ProviderPolicy {
  if (!isRecord(value)) fail("E_EVAL_SCHEMA", "provider policy must be an object");
  if (
    canonicalJson(Object.keys(value).sort()) !==
    canonicalJson([
      "cacheStrategy",
      "confirmationPolicy",
      "maxRetriesPerPlannedRequest",
      "priceCardDigest",
      "retryableErrorClasses",
      "timeoutMs",
      "upperCostPerAttempt",
    ])
  )
    fail("E_EVAL_SCHEMA", "provider policy must use the exact v2 schema");
  if (
    value.maxRetriesPerPlannedRequest !== 1 ||
    !Array.isArray(value.retryableErrorClasses) ||
    value.retryableErrorClasses.length === 0 ||
    new Set(value.retryableErrorClasses).size !== value.retryableErrorClasses.length ||
    value.retryableErrorClasses.some((item) => !isFailureClass(item)) ||
    !isRecord(value.timeoutMs) ||
    !isRecord(value.upperCostPerAttempt) ||
    !positive(value.timeoutMs.summary) ||
    !positive(value.timeoutMs.checkpoint) ||
    !positive(value.upperCostPerAttempt.summary) ||
    !positive(value.upperCostPerAttempt.checkpoint) ||
    !DIGEST.test(value.priceCardDigest as string) ||
    !["per-plan-per-request-v1", "disabled-v1"].includes(value.cacheStrategy as string) ||
    value.confirmationPolicy !== "exact-plan-target-call-count-upper-cost-v2"
  )
    fail("E_EVAL_SCHEMA", "provider policy is invalid");
  return frozen({
    ...value,
    retryableErrorClasses: frozen([...value.retryableErrorClasses]),
    timeoutMs: frozen({ ...value.timeoutMs }),
    upperCostPerAttempt: frozen({ ...value.upperCostPerAttempt }),
  }) as ProviderPolicy;
}
export function providerPolicyDigest(policy: ProviderPolicy): string {
  return canonicalDigest(validateProviderPolicy(policy));
}
export function providerReplayTarget(target: TargetSelectionRecord): ProviderReplayTarget {
  const valid = validateTargetSelectionRecord(target);
  return frozen({
    provider: valid.provider,
    model: valid.model,
    api: valid.api,
    reasoning: valid.reasoning,
  });
}
export function providerReplayUpperBound(
  plan: ReplayPlan,
  policy: ProviderPolicy,
): { readonly plannedCallCount: number; readonly upperCost: number; readonly formula: string } {
  const checked = validateProviderPolicy(policy);
  const checkpoints = plan.replicateCount * 2 * REPLAY_CHECKPOINT_COUNT;
  const summaries = plan.replicateCount;
  return frozen({
    plannedCallCount: (checkpoints + summaries) * 2,
    upperCost:
      checkpoints * 2 * checked.upperCostPerAttempt.checkpoint +
      summaries * 2 * checked.upperCostPerAttempt.summary,
    formula: "replicates * (2 * 5 * 2 * checkpointCost + 1 * 2 * summaryCost)",
  });
}
function replayConfirmationBody(
  plan: ReplayPlan,
  targetSelection: TargetSelectionRecord,
  policy: ProviderPolicy,
): Omit<ProviderReplayConfirmation, "confirmationDigest"> {
  const target = validateTargetSelectionRecord(targetSelection);
  const bound = providerReplayUpperBound(plan, policy);
  return {
    decision: "confirm",
    planDigest: plan.planDigest,
    targetSelectionDigest: canonicalDigest(target),
    providerPolicyDigest: providerPolicyDigest(policy),
    priceCardDigest: policy.priceCardDigest,
    target: providerReplayTarget(target),
    plannedCallCount: bound.plannedCallCount,
    upperCost: bound.upperCost,
  };
}
export function createProviderReplayConfirmation(
  plan: ReplayPlan,
  targetSelection: TargetSelectionRecord,
  policy: ProviderPolicy,
): ProviderReplayConfirmation {
  const body = replayConfirmationBody(plan, targetSelection, policy);
  return frozen({
    ...body,
    confirmationDigest: canonicalDigest({
      domain: "provider-replay-confirmation-v2",
      confirmation: body,
    }),
  });
}

function validateProofPolicy(
  value: GeneratedCompactionProofPolicy,
): GeneratedCompactionProofPolicy {
  if (!isRecord(value)) fail("E_EVAL_SCHEMA", "generated proof policy must be an object");
  if (
    canonicalJson(Object.keys(value).sort()) !==
    canonicalJson([
      "cacheStrategy",
      "confirmationPolicy",
      "maxRetriesPerPlannedRequest",
      "priceCardDigest",
      "upperCostPerAttempt",
    ])
  )
    fail("E_EVAL_SCHEMA", "generated proof policy has invalid schema");
  if (
    value.maxRetriesPerPlannedRequest !== 1 ||
    !isRecord(value.upperCostPerAttempt) ||
    !positive(value.upperCostPerAttempt.nativeCompaction) ||
    !positive(value.upperCostPerAttempt.followingMain) ||
    !DIGEST.test(value.priceCardDigest as string) ||
    !["per-plan-per-request-v1", "disabled-v1"].includes(value.cacheStrategy as string) ||
    value.confirmationPolicy !== "exact-generated-compaction-proof-v1"
  )
    fail("E_EVAL_SCHEMA", "generated proof policy is invalid");
  return frozen({
    ...value,
    upperCostPerAttempt: frozen({ ...value.upperCostPerAttempt }),
  }) as GeneratedCompactionProofPolicy;
}
export function generatedCompactionProofPolicyDigest(
  policy: GeneratedCompactionProofPolicy,
): string {
  return canonicalDigest(validateProofPolicy(policy));
}

export function validateT009BEnvironmentDeclaration(value: unknown): T009BEnvironmentDeclaration {
  if (!isRecord(value)) fail("E_EVAL_SCHEMA", "T-009B environment declaration must be an object");
  exactKeys(
    value,
    ["platform", "runnerVersion", "schemaVersion", "type"],
    "T-009B environment declaration has invalid schema",
  );
  if (
    value.schemaVersion !== 1 ||
    value.type !== "t009b-generated-compaction-environment-v1" ||
    typeof value.runnerVersion !== "string" ||
    value.runnerVersion.length === 0 ||
    typeof value.platform !== "string" ||
    value.platform.length === 0
  )
    fail("E_EVAL_SCHEMA", "T-009B environment declaration is invalid");
  return frozen({
    schemaVersion: 1,
    type: "t009b-generated-compaction-environment-v1",
    runnerVersion: value.runnerVersion,
    platform: value.platform,
  });
}

export function t009bEnvironmentDigest(environment: T009BEnvironmentDeclaration): string {
  return canonicalDigest(validateT009BEnvironmentDeclaration(environment));
}

async function readCanonicalPrivateJson(safeRun: SafeRun, path: string): Promise<unknown> {
  const raw = UTF8.decode(await safeRunReadFile(safeRun, path));
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("E_EVAL_INTEGRITY", "T-009B private input is malformed");
  }
  if (canonicalJson(value) !== raw)
    fail("E_EVAL_INTEGRITY", "T-009B private input is noncanonical");
  return value;
}

async function publishImmutableJson(safeRun: SafeRun, path: string, value: unknown): Promise<void> {
  const content = canonicalJson(value);
  if (await safeRunPublishExclusiveFile(safeRun, path, content)) return;
  if (UTF8.decode(await safeRunReadFile(safeRun, path)) !== content)
    fail("E_EVAL_INTEGRITY", "T-009B private input cannot be changed");
}

/** Publish the only accepted T-009B private inputs at documented fixed paths. */
export async function prepareT009BPrivateInputs(input: {
  readonly safeRun: SafeRun;
  readonly targetSelection: TargetSelectionRecord;
  readonly providerPolicy: ProviderPolicy;
  readonly proofPolicy: GeneratedCompactionProofPolicy;
  readonly environment: T009BEnvironmentDeclaration;
}): Promise<T009BPreparedInputs> {
  const targetSelection = validateTargetSelectionRecord(input.targetSelection);
  const providerPolicy = validateProviderPolicy(input.providerPolicy);
  const proofPolicy = validateProofPolicy(input.proofPolicy);
  const environment = validateT009BEnvironmentDeclaration(input.environment);
  if (targetSelection.providerPolicyDigest !== providerPolicyDigest(providerPolicy))
    fail("E_EVAL_INTEGRITY", "T-009B provider policy does not match the immutable target");
  createGeneratedCompactionProofConfirmation(
    targetSelection,
    providerPolicy,
    proofPolicy,
    t009bEnvironmentDigest(environment),
  );
  await publishImmutableJson(input.safeRun, T009B_PROVIDER_POLICY_PATH, providerPolicy);
  await publishImmutableJson(input.safeRun, T009B_PROOF_POLICY_PATH, proofPolicy);
  await publishImmutableJson(input.safeRun, T009B_ENVIRONMENT_PATH, environment);
  return frozen({
    targetSelection,
    providerPolicy,
    proofPolicy,
    environment,
    environmentDigest: t009bEnvironmentDigest(environment),
  });
}

/** Load and validate all fixed private inputs after a caller has authenticated the target record. */
export async function loadT009BPrivateInputs(
  safeRun: SafeRun,
  targetSelection: TargetSelectionRecord,
): Promise<T009BPreparedInputs> {
  for (const path of [T009B_PROVIDER_POLICY_PATH, T009B_PROOF_POLICY_PATH, T009B_ENVIRONMENT_PATH])
    if (!(await safeRunFileExists(safeRun, path)))
      fail("E_EVAL_INCOMPLETE", "T-009B private inputs have not been prepared");
  const providerPolicy = validateProviderPolicy(
    (await readCanonicalPrivateJson(safeRun, T009B_PROVIDER_POLICY_PATH)) as ProviderPolicy,
  );
  const proofPolicy = validateProofPolicy(
    (await readCanonicalPrivateJson(
      safeRun,
      T009B_PROOF_POLICY_PATH,
    )) as GeneratedCompactionProofPolicy,
  );
  const environment = validateT009BEnvironmentDeclaration(
    await readCanonicalPrivateJson(safeRun, T009B_ENVIRONMENT_PATH),
  );
  const target = validateTargetSelectionRecord(targetSelection);
  if (target.providerPolicyDigest !== providerPolicyDigest(providerPolicy))
    fail("E_EVAL_INTEGRITY", "T-009B persisted policy does not match the immutable target");
  createGeneratedCompactionProofConfirmation(
    target,
    providerPolicy,
    proofPolicy,
    t009bEnvironmentDigest(environment),
  );
  return frozen({
    targetSelection: target,
    providerPolicy,
    proofPolicy,
    environment,
    environmentDigest: t009bEnvironmentDigest(environment),
  });
}

function generatedInputDigest(target: ProviderReplayTarget, environmentDigest: string): string {
  if (!DIGEST.test(environmentDigest))
    fail("E_EVAL_SCHEMA", "generated proof environment digest is invalid");
  return canonicalDigest({
    domain: "t009b-generated-native-compaction-input-v1",
    generatedSession: "t009b-generated-native-compaction-session-v1",
    generatedScenario: "native-compaction-then-following-main-v1",
    target,
    environmentDigest,
  });
}
export function generatedCompactionProofUpperBound(policy: GeneratedCompactionProofPolicy): {
  readonly plannedCallCount: number;
  readonly upperCost: number;
  readonly formula: string;
} {
  const p = validateProofPolicy(policy);
  return frozen({
    plannedCallCount: GENERATED_COMPACTION_PROOF_SCHEDULE.length * 2,
    upperCost: 2 * (p.upperCostPerAttempt.nativeCompaction + p.upperCostPerAttempt.followingMain),
    formula: "2 * (nativeCompactionCost + followingMainCost)",
  });
}
export function createGeneratedCompactionProofConfirmation(
  targetSelection: TargetSelectionRecord,
  providerPolicy: ProviderPolicy,
  proofPolicy: GeneratedCompactionProofPolicy,
  environmentDigest: string,
): GeneratedCompactionProofConfirmation {
  const target = validateTargetSelectionRecord(targetSelection);
  const replayPolicy = validateProviderPolicy(providerPolicy);
  const proof = validateProofPolicy(proofPolicy);
  if (
    proof.priceCardDigest !== replayPolicy.priceCardDigest ||
    proof.cacheStrategy !== replayPolicy.cacheStrategy
  )
    fail(
      "E_EVAL_INTEGRITY",
      "generated proof policy must share the target replay price card and cache policy",
    );
  const derivedTarget = providerReplayTarget(target);
  const generatedDigest = generatedInputDigest(derivedTarget, environmentDigest);
  const bound = generatedCompactionProofUpperBound(proof);
  const body = {
    decision: "confirm" as const,
    targetSelectionDigest: canonicalDigest(target),
    providerPolicyDigest: providerPolicyDigest(replayPolicy),
    proofPolicyDigest: generatedCompactionProofPolicyDigest(proof),
    priceCardDigest: replayPolicy.priceCardDigest,
    target: derivedTarget,
    generatedInputDigest: generatedDigest,
    plannedCallCount: bound.plannedCallCount,
    upperCost: bound.upperCost,
  };
  return frozen({
    ...body,
    confirmationDigest: canonicalDigest({
      domain: "generated-compaction-proof-confirmation-v1",
      confirmation: body,
    }),
  });
}
export function createGeneratedCompactionProofPlan(
  targetSelection: TargetSelectionRecord,
  providerPolicy: ProviderPolicy,
  proofPolicy: GeneratedCompactionProofPolicy,
  environment: T009BEnvironmentDeclaration,
): GeneratedCompactionProofPlan {
  const confirmation = createGeneratedCompactionProofConfirmation(
    targetSelection,
    providerPolicy,
    proofPolicy,
    t009bEnvironmentDigest(environment),
  );
  return frozen({
    target: confirmation.target,
    generatedInputDeclaration: frozen({
      generatedSession: "t009b-generated-native-compaction-session-v1",
      generatedScenario: "native-compaction-then-following-main-v1",
    }),
    generatedInputDigest: confirmation.generatedInputDigest,
    plannedCalls: GENERATED_COMPACTION_PROOF_SCHEDULE,
    plannedCallCount: confirmation.plannedCallCount,
    retryMax: 1,
    upperCost: confirmation.upperCost,
    proofPolicyDigest: confirmation.proofPolicyDigest,
    environmentDigest: t009bEnvironmentDigest(environment),
    providerPolicyDigest: confirmation.providerPolicyDigest,
    confirmationDigest: confirmation.confirmationDigest,
    planDigest: confirmation.confirmationDigest,
  });
}

function resolutionPath(generatedDigest: string): string {
  if (!DIGEST.test(generatedDigest))
    fail("E_EVAL_INTEGRITY", "invalid generated resolution digest");
  return `${COMPACTION_ACCOUNTING_RESOLUTION_DIRECTORY}/${generatedDigest}.json`;
}
function validateResolution(value: unknown): CompactionAccountingResolutionArtifact {
  if (!isRecord(value)) fail("E_EVAL_INTEGRITY", "compaction resolution is not an object");
  exactKeys(
    value,
    [
      "cacheCapability",
      "captureDigest",
      "confirmationDigest",
      "environmentDigest",
      "generatedInputDigest",
      "outcome",
      "priceCardDigest",
      "probeDigest",
      "providerPolicyDigest",
      "resolutionDigest",
      "schemaVersion",
      "target",
      "targetSelectionDigest",
      "type",
    ],
    "compaction resolution has invalid schema",
  );
  if (
    value.schemaVersion !== 1 ||
    value.type !== "compaction-accounting-resolution-v1" ||
    (value.outcome !== "complete" && value.outcome !== "blocking-incomplete") ||
    !isRecord(value.target) ||
    !isRecord(value.cacheCapability) ||
    canonicalJson(Object.keys(value.target).sort()) !==
      canonicalJson(["api", "model", "provider", "reasoning"]) ||
    Object.values(value.target).some((field) => typeof field !== "string" || field.length === 0) ||
    canonicalJson(Object.keys(value.cacheCapability).sort()) !==
      canonicalJson(
        Object.hasOwn(value.cacheCapability, "namespace")
          ? ["configuredStrategy", "namespace", "observedIsolation"]
          : ["configuredStrategy", "observedIsolation"],
      ) ||
    !["per-plan-per-request-v1", "disabled-v1"].includes(
      value.cacheCapability.configuredStrategy as string,
    ) ||
    !["isolated", "not-isolated", "unknown"].includes(
      value.cacheCapability.observedIsolation as string,
    ) ||
    (Object.hasOwn(value.cacheCapability, "namespace") &&
      typeof value.cacheCapability.namespace !== "string") ||
    ![
      "targetSelectionDigest",
      "providerPolicyDigest",
      "priceCardDigest",
      "environmentDigest",
      "generatedInputDigest",
      "confirmationDigest",
      "captureDigest",
      "probeDigest",
      "resolutionDigest",
    ].every((key) => typeof value[key] === "string" && DIGEST.test(value[key] as string))
  )
    fail("E_EVAL_INTEGRITY", "compaction resolution fields are invalid");
  const unsigned = { ...value };
  delete unsigned.resolutionDigest;
  const expected = canonicalDigest({
    domain: "compaction-accounting-resolution-v1",
    resolution: unsigned,
  });
  if (value.resolutionDigest !== expected)
    fail("E_EVAL_INTEGRITY", "compaction resolution digest is invalid");
  return value as unknown as CompactionAccountingResolutionArtifact;
}
function declineDispositionPath(generatedDigest: string): string {
  if (!DIGEST.test(generatedDigest)) fail("E_EVAL_INTEGRITY", "invalid generated decline digest");
  return `${COMPACTION_ACCOUNTING_DISPOSITION_DIRECTORY}/${generatedDigest}.json`;
}

interface CompactionAccountingDeclineDisposition {
  readonly schemaVersion: 1;
  readonly type: "compaction-accounting-decline-v1";
  readonly generatedInputDigest: string;
  readonly planDigest: string;
  readonly dispositionDigest: string;
}
export interface CompactionAccountingNotApplicableDisposition {
  readonly schemaVersion: 1;
  readonly type: "compaction-accounting-not-applicable-v1";
  readonly upstreamHardStopDigest: string;
  readonly dispositionDigest: string;
}

function makeDeclineDisposition(
  confirmation: GeneratedCompactionProofConfirmation,
): CompactionAccountingDeclineDisposition {
  const unsigned = {
    schemaVersion: 1 as const,
    type: "compaction-accounting-decline-v1" as const,
    generatedInputDigest: confirmation.generatedInputDigest,
    planDigest: confirmation.confirmationDigest,
  };
  return frozen({
    ...unsigned,
    dispositionDigest: canonicalDigest({
      domain: "compaction-accounting-decline-v1",
      disposition: unsigned,
    }),
  });
}

function notApplicableDispositionPath(upstreamHardStopDigest: string): string {
  if (!DIGEST.test(upstreamHardStopDigest))
    fail("E_EVAL_INTEGRITY", "invalid T-017 hard-stop digest");
  return `${COMPACTION_ACCOUNTING_NOT_APPLICABLE_DIRECTORY}/${upstreamHardStopDigest}.json`;
}

function validateNotApplicableDisposition(
  value: unknown,
): CompactionAccountingNotApplicableDisposition {
  if (!isRecord(value))
    fail("E_EVAL_INTEGRITY", "T-009B not-applicable disposition is not an object");
  exactKeys(
    value,
    ["dispositionDigest", "schemaVersion", "type", "upstreamHardStopDigest"],
    "T-009B not-applicable disposition has invalid schema",
  );
  if (
    value.schemaVersion !== 1 ||
    value.type !== "compaction-accounting-not-applicable-v1" ||
    !DIGEST.test(value.upstreamHardStopDigest as string) ||
    !DIGEST.test(value.dispositionDigest as string)
  )
    fail("E_EVAL_INTEGRITY", "T-009B not-applicable disposition fields are invalid");
  const unsigned = {
    schemaVersion: 1 as const,
    type: "compaction-accounting-not-applicable-v1" as const,
    upstreamHardStopDigest: value.upstreamHardStopDigest,
  };
  if (
    value.dispositionDigest !==
    canonicalDigest({ domain: "compaction-accounting-not-applicable-v1", disposition: unsigned })
  )
    fail("E_EVAL_INTEGRITY", "T-009B not-applicable disposition digest is invalid");
  return value as unknown as CompactionAccountingNotApplicableDisposition;
}

/** Persist only an authenticated T-017 hard-stop terminal disposition; makes zero calls. */
export async function recordGeneratedCompactionNotApplicable(input: {
  readonly safeRun: SafeRun;
  readonly upstreamHardStopDigest: string;
}): Promise<CompactionAccountingNotApplicableDisposition> {
  if (!DIGEST.test(input.upstreamHardStopDigest))
    fail("E_EVAL_CONFIG", "T-009B hard-stop digest is invalid");
  const unsigned = {
    schemaVersion: 1 as const,
    type: "compaction-accounting-not-applicable-v1" as const,
    upstreamHardStopDigest: input.upstreamHardStopDigest,
  };
  const disposition = Object.freeze({
    ...unsigned,
    dispositionDigest: canonicalDigest({
      domain: "compaction-accounting-not-applicable-v1",
      disposition: unsigned,
    }),
  });
  await ensurePrivateDir(input.safeRun, COMPACTION_ACCOUNTING_NOT_APPLICABLE_DIRECTORY);
  const path = notApplicableDispositionPath(input.upstreamHardStopDigest);
  const content = canonicalJson(disposition);
  if (
    !(await safeRunPublishExclusiveFile(input.safeRun, path, content)) &&
    UTF8.decode(await safeRunReadFile(input.safeRun, path)) !== content
  )
    fail(
      "E_EVAL_INTEGRITY",
      "T-009B hard-stop cannot reuse a different not-applicable disposition",
    );
  return disposition;
}

function validateDeclineDisposition(value: unknown): CompactionAccountingDeclineDisposition {
  if (!isRecord(value)) fail("E_EVAL_INTEGRITY", "compaction decline disposition is not an object");
  exactKeys(
    value,
    ["dispositionDigest", "generatedInputDigest", "planDigest", "schemaVersion", "type"],
    "compaction decline disposition has invalid schema",
  );
  if (
    value.schemaVersion !== 1 ||
    value.type !== "compaction-accounting-decline-v1" ||
    !DIGEST.test(value.generatedInputDigest as string) ||
    !DIGEST.test(value.planDigest as string) ||
    !DIGEST.test(value.dispositionDigest as string)
  )
    fail("E_EVAL_INTEGRITY", "compaction decline disposition fields are invalid");
  const unsigned = {
    schemaVersion: value.schemaVersion,
    type: value.type,
    generatedInputDigest: value.generatedInputDigest,
    planDigest: value.planDigest,
  };
  if (
    value.dispositionDigest !==
    canonicalDigest({ domain: "compaction-accounting-decline-v1", disposition: unsigned })
  )
    fail("E_EVAL_INTEGRITY", "compaction decline disposition digest is invalid");
  return value as unknown as CompactionAccountingDeclineDisposition;
}

async function persistResolution(
  safeRun: SafeRun,
  value: CompactionAccountingResolutionArtifact,
): Promise<CompactionAccountingResolutionArtifact> {
  const resolution = validateResolution(value);
  await ensurePrivateDir(safeRun, COMPACTION_ACCOUNTING_RESOLUTION_DIRECTORY);
  const path = resolutionPath(resolution.generatedInputDigest);
  const published = await safeRunPublishExclusiveFile(safeRun, path, canonicalJson(resolution));
  if (!published) {
    const text = UTF8.decode(await safeRunReadFile(safeRun, path));
    let existing: unknown;
    try {
      existing = JSON.parse(text);
    } catch {
      fail("E_EVAL_INTEGRITY", "persisted compaction resolution is malformed");
    }
    if (canonicalJson(existing) !== text || canonicalJson(existing) !== canonicalJson(resolution))
      fail("E_EVAL_INTEGRITY", "generated input cannot reuse a different compaction resolution");
  }
  return resolution;
}
async function verifyResolution(
  safeRun: SafeRun,
  value: unknown,
  targetSelection: TargetSelectionRecord,
  policy: ProviderPolicy,
): Promise<CompactionAccountingResolutionArtifact> {
  const resolution = validateResolution(value);
  const path = resolutionPath(resolution.generatedInputDigest);
  if (!(await safeRunFileExists(safeRun, path)))
    fail("E_EVAL_INCOMPLETE", "compaction accounting resolution marker is missing");
  const raw = UTF8.decode(await safeRunReadFile(safeRun, path));
  let persisted: unknown;
  try {
    persisted = JSON.parse(raw);
  } catch {
    fail("E_EVAL_INTEGRITY", "compaction accounting resolution marker is malformed");
  }
  if (canonicalJson(persisted) !== raw || canonicalJson(persisted) !== canonicalJson(resolution))
    fail("E_EVAL_INTEGRITY", "compaction accounting resolution marker changed");
  const target = providerReplayTarget(targetSelection);
  const checked = validateProviderPolicy(policy);
  if (resolution.outcome !== "complete")
    fail("E_EVAL_INCOMPLETE", "compaction accounting resolution is blocking-incomplete");
  if (
    resolution.targetSelectionDigest !==
      canonicalDigest(validateTargetSelectionRecord(targetSelection)) ||
    resolution.providerPolicyDigest !== providerPolicyDigest(checked) ||
    resolution.priceCardDigest !== checked.priceCardDigest ||
    !exactTarget(resolution.target, target) ||
    cacheStatus({ cacheCapability: resolution.cacheCapability }, checked.cacheStrategy) !==
      "isolated"
  )
    fail(
      "E_EVAL_INTEGRITY",
      "compaction accounting resolution does not bind the frozen target, policy, and isolated cache",
    );
  const probePath = `compaction-usage-probes/t009b-${resolution.generatedInputDigest.slice(0, 32)}.json`;
  if (!(await safeRunFileExists(safeRun, probePath)))
    fail("E_EVAL_INCOMPLETE", "compaction accounting probe is missing");
  const probeRaw = UTF8.decode(await safeRunReadFile(safeRun, probePath));
  let probe: unknown;
  try {
    probe = JSON.parse(probeRaw);
  } catch {
    fail("E_EVAL_INTEGRITY", "compaction accounting probe is malformed");
  }
  if (canonicalJson(probe) !== probeRaw)
    fail("E_EVAL_INTEGRITY", "compaction accounting probe is noncanonical");
  await verifyCompactionUsageProbe(safeRun, probe as CompactionUsageProbeArtifact);
  const validatedProbe = probe as CompactionUsageProbeArtifact;
  const capture = captureCompactionUsage({ events: validatedProbe.data.facts });
  if (
    canonicalDigest(capture) !== resolution.captureDigest ||
    validatedProbe.eventId !== resolution.probeDigest ||
    capture.status !== "complete"
  )
    fail(
      "E_EVAL_INTEGRITY",
      "compaction resolution cannot be rederived from its authoritative facts",
    );
  return resolution;
}

/** Authenticate and rederive the persisted T-009B outcome from its authoritative probe facts. */
export async function verifyPersistedGeneratedCompactionProof(input: {
  readonly safeRun: SafeRun;
  readonly targetSelection: TargetSelectionRecord;
  readonly providerPolicy: ProviderPolicy;
  readonly proofPolicy: GeneratedCompactionProofPolicy;
  readonly environment: T009BEnvironmentDeclaration;
}): Promise<CompactionAccountingResolutionArtifact> {
  const target = validateTargetSelectionRecord(input.targetSelection);
  const policy = validateProviderPolicy(input.providerPolicy);
  const proof = validateProofPolicy(input.proofPolicy);
  const environmentDigest = t009bEnvironmentDigest(input.environment);
  const confirmation = createGeneratedCompactionProofConfirmation(
    target,
    policy,
    proof,
    environmentDigest,
  );
  const path = resolutionPath(confirmation.generatedInputDigest);
  if (!(await safeRunFileExists(input.safeRun, path)))
    fail("E_EVAL_INCOMPLETE", "compaction accounting resolution marker is missing");
  const raw = UTF8.decode(await safeRunReadFile(input.safeRun, path));
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("E_EVAL_INTEGRITY", "compaction accounting resolution marker is malformed");
  }
  if (canonicalJson(value) !== raw)
    fail("E_EVAL_INTEGRITY", "compaction accounting resolution marker is noncanonical");
  const resolution = validateResolution(value);
  if (
    resolution.targetSelectionDigest !== confirmation.targetSelectionDigest ||
    resolution.providerPolicyDigest !== confirmation.providerPolicyDigest ||
    resolution.priceCardDigest !== confirmation.priceCardDigest ||
    resolution.environmentDigest !== environmentDigest ||
    resolution.generatedInputDigest !== confirmation.generatedInputDigest ||
    resolution.confirmationDigest !== confirmation.confirmationDigest ||
    !exactTarget(resolution.target, confirmation.target)
  )
    fail(
      "E_EVAL_INTEGRITY",
      "compaction accounting resolution does not bind the exact T-009B plan",
    );
  const dispositionPath = declineDispositionPath(confirmation.generatedInputDigest);
  if (await safeRunFileExists(input.safeRun, dispositionPath)) {
    const dispositionRaw = UTF8.decode(await safeRunReadFile(input.safeRun, dispositionPath));
    let dispositionValue: unknown;
    try {
      dispositionValue = JSON.parse(dispositionRaw);
    } catch {
      fail("E_EVAL_INTEGRITY", "compaction decline disposition is malformed");
    }
    if (canonicalJson(dispositionValue) !== dispositionRaw)
      fail("E_EVAL_INTEGRITY", "compaction decline disposition is noncanonical");
    const disposition = validateDeclineDisposition(dispositionValue);
    if (
      canonicalJson(disposition) !== canonicalJson(makeDeclineDisposition(confirmation)) ||
      resolution.outcome !== "blocking-incomplete" ||
      resolution.captureDigest !== canonicalDigest(captureCompactionUsage({ events: [] }))
    )
      fail("E_EVAL_INTEGRITY", "declined T-009B disposition does not bind its blocking resolution");
    return resolution;
  }
  if (
    cacheStatus({ cacheCapability: resolution.cacheCapability }, proof.cacheStrategy) !== "isolated"
  )
    fail("E_EVAL_INTEGRITY", "compaction accounting proof cache isolation is not confirmed");
  const probePath = `compaction-usage-probes/t009b-${confirmation.generatedInputDigest.slice(0, 32)}.json`;
  if (!(await safeRunFileExists(input.safeRun, probePath)))
    fail("E_EVAL_INCOMPLETE", "compaction accounting probe is missing");
  const probeRaw = UTF8.decode(await safeRunReadFile(input.safeRun, probePath));
  let probe: unknown;
  try {
    probe = JSON.parse(probeRaw);
  } catch {
    fail("E_EVAL_INTEGRITY", "compaction accounting probe is malformed");
  }
  if (canonicalJson(probe) !== probeRaw)
    fail("E_EVAL_INTEGRITY", "compaction accounting probe is noncanonical");
  await verifyCompactionUsageProbe(input.safeRun, probe as CompactionUsageProbeArtifact);
  const validatedProbe = probe as CompactionUsageProbeArtifact;
  const ledgerFacts = await loadGeneratedLedgerFacts(input.safeRun, confirmation);
  if (canonicalJson(ledgerFacts) !== canonicalJson(validatedProbe.data.facts))
    fail(
      "E_EVAL_INTEGRITY",
      "compaction probe facts do not exactly rederive from the durable attempt ledger",
    );
  const capture = captureCompactionUsage({ events: ledgerFacts });
  if (
    canonicalDigest(capture) !== resolution.captureDigest ||
    validatedProbe.eventId !== resolution.probeDigest ||
    resolution.outcome !== (capture.status === "complete" ? "complete" : "blocking-incomplete")
  )
    fail(
      "E_EVAL_INTEGRITY",
      "compaction resolution cannot be rederived from its authoritative facts",
    );
  return resolution;
}

async function optionalArtifactNames(
  safeRun: SafeRun,
  directory: string,
): Promise<readonly string[]> {
  try {
    const stat = await safeRunStat(safeRun, directory);
    if (stat === undefined) return [];
    if (!stat.isDirectory) fail("E_EVAL_INTEGRITY", "T-009B artifact directory is invalid");
    const entries = await safeRunReaddir(safeRun, directory);
    if (entries.some((entry) => !entry.isFile))
      fail("E_EVAL_INTEGRITY", "T-009B artifact directory is invalid");
    return entries.map((entry) => entry.name).sort();
  } catch (error) {
    if (
      (error as { code?: string }).code === "ENOENT" ||
      (error instanceof EvidenceStoreError && error.message === "Path component is not accessible")
    )
      return [];
    // path-safety intentionally hides filesystem details; only its missing
    // component sentinel is non-evidence. All other failures fail closed.
    if (error instanceof EvidenceStoreError) throw error;
    throw error;
  }
}

/** Return no value before T-009B; reject any terminal/orphan artifact drift. */
export async function verifyT009BIfPresent(
  safeRun: SafeRun,
  targetSelection?: TargetSelectionRecord,
): Promise<
  | { readonly compactionAccounting: "complete" | "blocking-incomplete" | "not-applicable" }
  | undefined
> {
  const [resolutionNames, declineNames, naNames, probeNames, ledgerNames] = await Promise.all([
    optionalArtifactNames(safeRun, COMPACTION_ACCOUNTING_RESOLUTION_DIRECTORY),
    optionalArtifactNames(safeRun, COMPACTION_ACCOUNTING_DISPOSITION_DIRECTORY),
    optionalArtifactNames(safeRun, COMPACTION_ACCOUNTING_NOT_APPLICABLE_DIRECTORY),
    optionalArtifactNames(safeRun, "compaction-usage-probes"),
    (await safeRunFileExists(safeRun, GENERATED_COMPACTION_PROOF_LEDGER_PATH))
      ? [GENERATED_COMPACTION_PROOF_LEDGER_PATH]
      : [],
  ]);
  const inputPaths = [T009B_PROVIDER_POLICY_PATH, T009B_PROOF_POLICY_PATH, T009B_ENVIRONMENT_PATH];
  const present = await Promise.all(inputPaths.map((path) => safeRunFileExists(safeRun, path)));
  if (present.some(Boolean) && !present.every(Boolean))
    fail("E_EVAL_INTEGRITY", "T-009B private inputs are incomplete");
  if (naNames.length > 0) {
    if (
      naNames.length !== 1 ||
      present.some(Boolean) ||
      resolutionNames.length ||
      declineNames.length ||
      probeNames.some((name) => name.startsWith("t009b-")) ||
      ledgerNames.length
    )
      fail("E_EVAL_INTEGRITY", "T-009B not-applicable path conflicts with execution evidence");
    const raw = UTF8.decode(
      await safeRunReadFile(
        safeRun,
        `${COMPACTION_ACCOUNTING_NOT_APPLICABLE_DIRECTORY}/${naNames[0]}`,
      ),
    );
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      fail("E_EVAL_INTEGRITY", "T-009B not-applicable disposition is malformed");
    }
    if (canonicalJson(value) !== raw)
      fail("E_EVAL_INTEGRITY", "T-009B not-applicable disposition is noncanonical");
    const disposition = validateNotApplicableDisposition(value);
    if (naNames[0] !== `${disposition.upstreamHardStopDigest}.json`)
      fail("E_EVAL_INTEGRITY", "T-009B not-applicable filename is invalid");
    return Object.freeze({ compactionAccounting: "not-applicable" });
  }
  if (targetSelection === undefined) {
    if (
      present.some(Boolean) ||
      resolutionNames.length ||
      declineNames.length ||
      probeNames.some((name) => name.startsWith("t009b-")) ||
      ledgerNames.length
    )
      fail(
        "E_EVAL_INTEGRITY",
        "T-009B execution evidence is orphaned from a viable T-017 terminal state",
      );
    return undefined;
  }
  if (!present.some(Boolean)) {
    if (
      resolutionNames.length ||
      declineNames.length ||
      probeNames.some((name) => name.startsWith("t009b-")) ||
      ledgerNames.length
    )
      fail("E_EVAL_INTEGRITY", "T-009B terminal evidence exists without prepared private inputs");
    return undefined;
  }
  const prepared = await loadT009BPrivateInputs(safeRun, targetSelection);
  const confirmation = createGeneratedCompactionProofConfirmation(
    prepared.targetSelection,
    prepared.providerPolicy,
    prepared.proofPolicy,
    prepared.environmentDigest,
  );
  const expectedResolution = `${confirmation.generatedInputDigest}.json`;
  const expectedDecline = `${confirmation.generatedInputDigest}.json`;
  const hasResolution = resolutionNames.includes(expectedResolution);
  if (
    resolutionNames.some((name) => name !== expectedResolution) ||
    declineNames.some((name) => name !== expectedDecline) ||
    probeNames.some(
      (name) =>
        name.startsWith("t009b-") &&
        name !== `t009b-${confirmation.generatedInputDigest.slice(0, 32)}.json`,
    )
  )
    fail("E_EVAL_INTEGRITY", "T-009B artifacts do not bind the authenticated generated input");
  if (!hasResolution) {
    if (
      declineNames.length ||
      probeNames.some((name) => name.startsWith("t009b-")) ||
      ledgerNames.length
    )
      fail("E_EVAL_INTEGRITY", "T-009B has orphan terminal evidence without its resolution");
    return undefined; // Prepared private inputs are permitted before the run.
  }
  const hasDecline = declineNames.length === 1;
  const hasLedger = ledgerNames.length === 1;
  const hasProbe = probeNames.includes(
    `t009b-${confirmation.generatedInputDigest.slice(0, 32)}.json`,
  );
  if (hasDecline && (hasLedger || hasProbe))
    fail("E_EVAL_INTEGRITY", "T-009B decline and executed paths are mutually exclusive");
  if (!hasDecline && (!hasLedger || !hasProbe))
    fail("E_EVAL_INTEGRITY", "T-009B executed path lacks its durable ledger or probe");
  const resolution = await verifyPersistedGeneratedCompactionProof({ ...prepared, safeRun });
  return Object.freeze({ compactionAccounting: resolution.outcome });
}

function generatedAttemptEventId(
  generatedInputDigest: string,
  requestId: string,
  attempt: 1 | 2,
  phase: "start" | "result" | "usage" | "facts",
): string {
  return canonicalDigest({
    domain: "t009b-generated-compaction-attempt-v1",
    generatedInputDigest,
    requestId,
    attempt,
    phase,
  });
}

function generatedRequestId(
  confirmation: GeneratedCompactionProofConfirmation,
  operation: string,
): string {
  return canonicalDigest({
    domain: "t009b-generated-compaction-request-v1",
    generatedInputDigest: confirmation.generatedInputDigest,
    operation,
  });
}

function generatedTimeout(
  policy: ProviderPolicy,
  operation: (typeof GENERATED_COMPACTION_PROOF_SCHEDULE)[number],
): number {
  return operation === "native-compaction" ? policy.timeoutMs.summary : policy.timeoutMs.checkpoint;
}

function generatedCacheKey(
  confirmation: GeneratedCompactionProofConfirmation,
  requestId: string,
  attempt: 1 | 2,
  adapter: GeneratedCompactionProofAdapter,
): string {
  return canonicalDigest({
    domain: "t009b-generated-compaction-cache-v2",
    generatedInputDigest: confirmation.generatedInputDigest,
    requestId,
    attempt,
    namespace: adapter.cacheCapability.namespace ?? null,
  });
}

function generatedBase(
  confirmation: GeneratedCompactionProofConfirmation,
  operation: (typeof GENERATED_COMPACTION_PROOF_SCHEDULE)[number],
  requestId: string,
  attempt: 1 | 2,
  adapter: GeneratedCompactionProofAdapter,
  policy: ProviderPolicy,
): RecordValue {
  return {
    generatedInputDigest: confirmation.generatedInputDigest,
    requestId,
    operation,
    attempt,
    ...(attempt === 2
      ? {
          retryOf: generatedAttemptEventId(
            confirmation.generatedInputDigest,
            requestId,
            1,
            "start",
          ),
        }
      : {}),
    target: confirmation.target,
    cacheKey: generatedCacheKey(confirmation, requestId, attempt, adapter),
    timeoutMs: generatedTimeout(policy, operation),
  };
}

function validateGeneratedFacts(
  facts: readonly PiLifecycleFact[],
  requestId: string,
): readonly PiLifecycleFact[] {
  // The reducer is also the closed-schema lifecycle validator (including
  // exact PiUsage).  It intentionally receives each attempt before disk IO.
  captureCompactionUsage({ events: facts });
  for (const fact of facts) {
    if (
      (fact.type === "before_provider_request" ||
        fact.type === "usage_observation" ||
        fact.type === "message_end") &&
      fact.requestId !== requestId
    )
      fail("E_EVAL_INTEGRITY", "T-009B lifecycle facts do not bind the runner-issued request");
  }
  return Object.freeze([...facts]);
}

async function appendGeneratedAttempt(
  safeRun: SafeRun,
  confirmation: GeneratedCompactionProofConfirmation,
  phase: "start" | "result" | "usage" | "facts",
  base: RecordValue,
  now: () => string,
  extra: RecordValue,
  failureClass?: ProviderFailureClass,
): Promise<void> {
  const id = generatedAttemptEventId(
    confirmation.generatedInputDigest,
    base.requestId as string,
    base.attempt as 1 | 2,
    phase,
  );
  await appendEvent(safeRun, GENERATED_COMPACTION_PROOF_LEDGER_PATH, {
    eventId: id,
    timestamp: now(),
    type: `t009b-generated-compaction-${phase}-v1`,
    data: { ...base, ...extra },
    ...(failureClass === undefined ? {} : { failed: true, error: failureClass }),
  });
}

async function loadGeneratedLedgerFacts(
  safeRun: SafeRun,
  confirmation: GeneratedCompactionProofConfirmation,
): Promise<readonly PiLifecycleFact[]> {
  if (!(await safeRunFileExists(safeRun, GENERATED_COMPACTION_PROOF_LEDGER_PATH)))
    fail("E_EVAL_INCOMPLETE", "T-009B attempt ledger is missing");
  const raw = UTF8.decode(await safeRunReadFile(safeRun, GENERATED_COMPACTION_PROOF_LEDGER_PATH));
  if (raw.length === 0 || !raw.endsWith("\n"))
    fail("E_EVAL_INTEGRITY", "T-009B attempt ledger is not canonical JSONL");
  const expected = new Map(
    GENERATED_COMPACTION_PROOF_SCHEDULE.map((operation) => [
      generatedRequestId(confirmation, operation),
      operation,
    ]),
  );
  const phases = new Map<string, Set<string>>();
  const failureStates = new Map<string, ProviderFailureClass | null>();
  const facts: PiLifecycleFact[] = [];
  for (const line of raw.slice(0, -1).split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      fail("E_EVAL_INTEGRITY", "T-009B attempt ledger is malformed");
    }
    if (!isRecord(event) || canonicalJson(event) !== line || !isRecord(event.data))
      fail("E_EVAL_INTEGRITY", "T-009B attempt ledger is noncanonical");
    const phase = /^t009b-generated-compaction-(start|result|usage|facts)-v1$/.exec(
      event.type as string,
    )?.[1] as "start" | "result" | "usage" | "facts" | undefined;
    const data = event.data;
    if (
      phase === undefined ||
      typeof event.eventId !== "string" ||
      typeof data.requestId !== "string" ||
      (data.attempt !== 1 && data.attempt !== 2) ||
      data.generatedInputDigest !== confirmation.generatedInputDigest ||
      expected.get(data.requestId) !== data.operation
    )
      fail("E_EVAL_INTEGRITY", "T-009B attempt ledger does not bind the fixed schedule");
    const baseKeys = [
      "attempt",
      "cacheKey",
      "generatedInputDigest",
      "operation",
      "requestId",
      "target",
      "timeoutMs",
      ...(data.attempt === 2 ? ["retryOf"] : []),
    ];
    const extraKeys =
      phase === "start"
        ? ["phase"]
        : phase === "result"
          ? data.outcome === "success"
            ? ["outcome", "phase"]
            : ["failureClass", "outcome", "phase"]
          : phase === "usage"
            ? ["billedDisposition", "phase", "usageCompleteness"]
            : ["facts", "phase"];
    exactKeys(data, [...baseKeys, ...extraKeys], "T-009B attempt ledger has invalid closed schema");
    if (
      !isRecord(data.target) ||
      !exactTarget(data.target as unknown as ProviderReplayTarget, confirmation.target) ||
      typeof data.cacheKey !== "string" ||
      !DIGEST.test(data.cacheKey) ||
      !positive(data.timeoutMs) ||
      (data.attempt === 2 &&
        data.retryOf !==
          generatedAttemptEventId(confirmation.generatedInputDigest, data.requestId, 1, "start")) ||
      (phase === "start" && data.phase !== "started") ||
      (phase === "result" &&
        ((data.outcome !== "success" && data.outcome !== "failure") ||
          (data.outcome === "failure" && !isFailureClass(data.failureClass)))) ||
      (phase === "usage" &&
        (!isBilling(data.billedDisposition) || data.usageCompleteness !== "facts-only")) ||
      (phase === "facts" && data.phase !== "facts")
    )
      fail("E_EVAL_INTEGRITY", "T-009B attempt ledger fields are invalid");
    const key = `${data.requestId}:${data.attempt}`;
    let failureClass: ProviderFailureClass | null;
    if (phase === "result") {
      failureClass =
        data.outcome === "failure" ? (data.failureClass as ProviderFailureClass) : null;
      failureStates.set(key, failureClass);
    } else if (phase === "usage" || phase === "facts") {
      if (!failureStates.has(key))
        fail("E_EVAL_INTEGRITY", "T-009B attempt ledger phases are out of order");
      failureClass = failureStates.get(key)!;
    } else failureClass = null;
    exactKeys(
      event,
      [
        "data",
        "eventId",
        "timestamp",
        "type",
        ...(failureClass === null ? [] : ["error", "failed"]),
      ],
      "T-009B attempt event has invalid closed schema",
    );
    if (
      typeof event.timestamp !== "string" ||
      Number.isNaN(Date.parse(event.timestamp)) ||
      new Date(event.timestamp).toISOString() !== event.timestamp ||
      (failureClass === null
        ? event.failed !== undefined || event.error !== undefined
        : event.failed !== true || event.error !== failureClass)
    )
      fail("E_EVAL_INTEGRITY", "T-009B attempt failure envelope is invalid");
    const seen = phases.get(key) ?? new Set<string>();
    if (
      seen.has(phase) ||
      event.eventId !==
        generatedAttemptEventId(
          confirmation.generatedInputDigest,
          data.requestId,
          data.attempt,
          phase,
        )
    )
      fail("E_EVAL_INTEGRITY", "T-009B attempt ledger identity is invalid");
    seen.add(phase);
    phases.set(key, seen);
    if (phase === "facts") {
      if (!Array.isArray(data.facts)) fail("E_EVAL_INTEGRITY", "T-009B facts ledger is invalid");
      facts.push(...validateGeneratedFacts(data.facts as PiLifecycleFact[], data.requestId));
    }
  }
  for (const [key, seen] of phases) {
    if (!["start", "result", "usage", "facts"].every((phase) => seen.has(phase)))
      fail("E_EVAL_INTEGRITY", `T-009B attempt ${key} lacks a durable phase`);
  }
  return Object.freeze(facts);
}

async function invokeGenerated(
  adapter: GeneratedCompactionProofAdapter,
  request: GeneratedCompactionProofRequest,
): Promise<GeneratedCompactionProofAdapterResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    return await Promise.race([
      adapter.execute(
        Object.freeze({
          ...request,
          signal: controller.signal,
          deadlineMs: Date.now() + request.timeoutMs,
        }),
      ),
      new Promise<GeneratedCompactionProofAdapterResult>((resolve) =>
        setTimeout(
          () => resolve({ ok: false, failureClass: "timeout", billed: "unknown", facts: [] }),
          request.timeoutMs,
        ),
      ),
    ]);
  } catch {
    return { ok: false, failureClass: "unknown", billed: "unknown", facts: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Executes the runner-owned fixed T-009B request schedule and durable ledger. */
export async function runGeneratedCompactionProof(
  input: GeneratedCompactionProofRunInput,
): Promise<GeneratedCompactionProofRunResult> {
  const expected = createGeneratedCompactionProofConfirmation(
    input.targetSelection,
    input.providerPolicy,
    input.proofPolicy,
    input.environmentDigest,
  );
  const received =
    input.confirmation === undefined
      ? undefined
      : typeof input.confirmation === "string"
        ? input.confirmation
        : input.confirmation.confirmationDigest;
  if (received !== undefined && received !== expected.confirmationDigest)
    fail(
      "E_EVAL_INTEGRITY",
      "generated proof confirmation does not exactly match its fixed schedule",
    );
  if (
    typeof input.confirmation === "object" &&
    canonicalJson(input.confirmation) !== canonicalJson(expected)
  )
    fail("E_EVAL_INTEGRITY", "generated proof confirmation body does not match its digest");
  if (received === undefined)
    return Object.freeze({
      status: "refused",
      plannedCallCount: expected.plannedCallCount,
      upperCost: expected.upperCost,
      resolution: await blockingResolution(input, expected, undefined),
    });
  if (
    !exactTarget(input.adapter.target, expected.target) ||
    cacheStatus(input.adapter, input.proofPolicy.cacheStrategy) !== "isolated"
  )
    fail(
      "E_EVAL_INTEGRITY",
      "generated proof adapter target or cache does not match the confirmed scenario",
    );
  const policy = validateProviderPolicy(input.providerPolicy);
  let terminalFailure = false;
  for (const operation of GENERATED_COMPACTION_PROOF_SCHEDULE) {
    const requestId = generatedRequestId(expected, operation);
    for (const attempt of [1, 2] as const) {
      if (attempt === 2 && terminalFailure) break;
      if (attempt === 2) {
        // Retry only the immediately preceding retryable failure.
        // The ledger has already made that decision durable.
      }
      const base = generatedBase(expected, operation, requestId, attempt, input.adapter, policy);
      await appendGeneratedAttempt(input.safeRun, expected, "start", base, input.now, {
        phase: "started",
      });
      const result = await invokeGenerated(
        input.adapter,
        Object.freeze({
          requestId,
          operation,
          attempt,
          ...(attempt === 2
            ? {
                retryOf: generatedAttemptEventId(
                  expected.generatedInputDigest,
                  requestId,
                  1,
                  "start",
                ),
              }
            : {}),
          timeoutMs: base.timeoutMs as number,
          deadlineMs: 0,
          signal: new AbortController().signal,
          target: expected.target,
          cacheKey: base.cacheKey as string,
        }),
      );
      if (!isRecord(result))
        fail("E_EVAL_INTEGRITY", "T-009B adapter result has invalid closed schema");
      exactKeys(
        result,
        result.ok === true ? ["billed", "facts", "ok"] : ["billed", "facts", "failureClass", "ok"],
        "T-009B adapter result has invalid closed schema",
      );
      if (
        (result.ok !== true && result.ok !== false) ||
        !isBilling(result.billed) ||
        !Array.isArray(result.facts) ||
        (result.ok === false && !isFailureClass(result.failureClass))
      )
        fail("E_EVAL_INTEGRITY", "T-009B adapter result has invalid closed schema");
      const facts = validateGeneratedFacts(result.facts, requestId);
      await appendGeneratedAttempt(
        input.safeRun,
        expected,
        "result",
        base,
        input.now,
        result.ok
          ? { phase: "result", outcome: "success" }
          : { phase: "result", outcome: "failure", failureClass: result.failureClass },
        result.ok ? undefined : result.failureClass,
      );
      await appendGeneratedAttempt(
        input.safeRun,
        expected,
        "usage",
        base,
        input.now,
        { phase: "usage", billedDisposition: result.billed, usageCompleteness: "facts-only" },
        result.ok ? undefined : result.failureClass,
      );
      await appendGeneratedAttempt(
        input.safeRun,
        expected,
        "facts",
        base,
        input.now,
        { phase: "facts", facts },
        result.ok ? undefined : result.failureClass,
      );
      if (result.ok) break;
      if (attempt === 1 && policy.retryableErrorClasses.includes(result.failureClass)) continue;
      terminalFailure = true;
      break;
    }
    if (terminalFailure) break;
  }
  const facts = await loadGeneratedLedgerFacts(input.safeRun, expected);
  const probe = await persistCompactionUsageProbe(
    input.safeRun,
    createCompactionUsageProbeArtifact(
      `t009b-${expected.generatedInputDigest.slice(0, 32)}`,
      input.now(),
      facts,
    ),
  );
  const capture = captureCompactionUsage({ events: facts });
  const resolution = await persistResolution(
    input.safeRun,
    makeResolution(input, expected, probe, capture),
  );
  return Object.freeze({
    status: "completed",
    plannedCallCount: expected.plannedCallCount,
    upperCost: expected.upperCost,
    resolution,
  });
}

async function blockingResolution(
  input: GeneratedCompactionProofRunInput,
  confirmation: GeneratedCompactionProofConfirmation,
  probe: CompactionUsageProbeArtifact | undefined,
): Promise<CompactionAccountingResolutionArtifact> {
  return persistResolution(
    input.safeRun,
    makeResolution(
      input,
      confirmation,
      probe,
      probe === undefined
        ? captureCompactionUsage({ events: [] })
        : captureCompactionUsage({ events: probe.data.facts }),
    ),
  );
}

function makeResolution(
  input: GeneratedCompactionProofRunInput,
  confirmation: GeneratedCompactionProofConfirmation,
  probe: CompactionUsageProbeArtifact | undefined,
  capture: ReturnType<typeof captureCompactionUsage>,
): CompactionAccountingResolutionArtifact {
  const unsigned = {
    schemaVersion: 1 as const,
    type: "compaction-accounting-resolution-v1" as const,
    targetSelectionDigest: confirmation.targetSelectionDigest,
    providerPolicyDigest: confirmation.providerPolicyDigest,
    priceCardDigest: confirmation.priceCardDigest,
    environmentDigest: input.environmentDigest,
    generatedInputDigest: confirmation.generatedInputDigest,
    confirmationDigest: confirmation.confirmationDigest,
    captureDigest: canonicalDigest(capture),
    probeDigest:
      probe?.eventId ??
      canonicalDigest({
        domain: "t009b-no-probe-v1",
        generatedInputDigest: confirmation.generatedInputDigest,
      }),
    target: confirmation.target,
    cacheCapability: input.adapter.cacheCapability,
    outcome: (capture.status === "complete" ? "complete" : "blocking-incomplete") as
      | "complete"
      | "blocking-incomplete",
  };
  return Object.freeze({
    ...unsigned,
    resolutionDigest: canonicalDigest({
      domain: "compaction-accounting-resolution-v1",
      resolution: unsigned,
    }),
  });
}

/** Records owner refusal without importing an adapter or producing a probe. */
export async function declineGeneratedCompactionProof(input: {
  readonly safeRun: SafeRun;
  readonly targetSelection: TargetSelectionRecord;
  readonly providerPolicy: ProviderPolicy;
  readonly proofPolicy: GeneratedCompactionProofPolicy;
  readonly environment: T009BEnvironmentDeclaration;
  readonly planDigest: string;
}): Promise<CompactionAccountingResolutionArtifact> {
  const environmentDigest = t009bEnvironmentDigest(input.environment);
  const confirmation = createGeneratedCompactionProofConfirmation(
    input.targetSelection,
    input.providerPolicy,
    input.proofPolicy,
    environmentDigest,
  );
  if (input.planDigest !== confirmation.confirmationDigest)
    fail("E_EVAL_INTEGRITY", "T-009B decline does not match the exact generated proof plan");
  const capture = captureCompactionUsage({ events: [] });
  const unsigned = {
    schemaVersion: 1 as const,
    type: "compaction-accounting-resolution-v1" as const,
    targetSelectionDigest: confirmation.targetSelectionDigest,
    providerPolicyDigest: confirmation.providerPolicyDigest,
    priceCardDigest: confirmation.priceCardDigest,
    environmentDigest,
    generatedInputDigest: confirmation.generatedInputDigest,
    confirmationDigest: confirmation.confirmationDigest,
    captureDigest: canonicalDigest(capture),
    probeDigest: canonicalDigest({
      domain: "t009b-no-probe-v1",
      generatedInputDigest: confirmation.generatedInputDigest,
    }),
    target: confirmation.target,
    cacheCapability: {
      configuredStrategy: input.proofPolicy.cacheStrategy,
      observedIsolation: "unknown" as const,
    },
    outcome: "blocking-incomplete" as const,
  };
  const resolution = await persistResolution(
    input.safeRun,
    frozen({
      ...unsigned,
      resolutionDigest: canonicalDigest({
        domain: "compaction-accounting-resolution-v1",
        resolution: unsigned,
      }),
    }),
  );
  const disposition = makeDeclineDisposition(confirmation);
  await ensurePrivateDir(input.safeRun, COMPACTION_ACCOUNTING_DISPOSITION_DIRECTORY);
  const dispositionPath = declineDispositionPath(confirmation.generatedInputDigest);
  const content = canonicalJson(disposition);
  if (!(await safeRunPublishExclusiveFile(input.safeRun, dispositionPath, content))) {
    if (UTF8.decode(await safeRunReadFile(input.safeRun, dispositionPath)) !== content)
      fail("E_EVAL_INTEGRITY", "T-009B plan cannot reuse a different decline disposition");
  }
  return resolution;
}

function schedule(plan: ReplayPlan): readonly ScheduledRequest[] {
  const requests: ScheduledRequest[] = [];
  for (const replicate of plan.replicates) {
    for (const arm of replicate.armOrder) {
      if (arm === "selective") {
        requests.push(
          frozen({
            requestId: canonicalDigest({
              planDigest: plan.planDigest,
              replicate: replicate.replicateIndex,
              kind: "summary",
              arm,
            }),
            kind: "summary",
            arm,
            replicateIndex: replicate.replicateIndex,
            input: replicate.summaryGeneration,
          }),
        );
      }
      for (const template of arm === "native"
        ? replicate.nativeContexts
        : replicate.selectiveContexts) {
        const input =
          arm === "native"
            ? template
            : {
                ...template,
                candidateRange: {
                  ...template.candidateRange,
                  messages: [
                    {
                      role: "user",
                      content: [
                        {
                          type: "text",
                          text: `Selective history summary reference: ${canonicalDigest({ planDigest: plan.planDigest, replicate: replicate.replicateIndex, kind: "summary", arm })}`,
                        },
                      ],
                    },
                  ],
                },
              };
        requests.push(
          frozen({
            requestId: canonicalDigest({
              planDigest: plan.planDigest,
              replicate: replicate.replicateIndex,
              kind: "checkpoint",
              arm,
              checkpoint: template.checkpointIndex,
            }),
            kind: "checkpoint",
            arm,
            replicateIndex: replicate.replicateIndex,
            checkpointIndex: template.checkpointIndex,
            input,
          }),
        );
      }
    }
  }
  return frozen(requests);
}
function eventId(planDigest: string, requestId: string, attempt: number, phase: Phase): string {
  return canonicalDigest({
    domain: "provider-replay-ledger-v2",
    planDigest,
    requestId,
    attempt,
    phase,
  });
}
function outputPath(resultEventId: string): string {
  return `${PROVIDER_REPLAY_OUTPUT_DIRECTORY}/${resultEventId}.txt`;
}
function cacheStatus(
  adapter: { readonly cacheCapability: ProviderCacheCapability },
  strategy: CacheStrategy,
): CacheIsolationStatus {
  const c = adapter.cacheCapability;
  return c.configuredStrategy === strategy &&
    c.observedIsolation === "isolated" &&
    typeof c.namespace === "string" &&
    c.namespace.length > 0
    ? "isolated"
    : c.observedIsolation === "not-isolated"
      ? "not-isolated"
      : "unknown";
}
function cacheKey(
  plan: ReplayPlan,
  requestId: string,
  attempt: number,
  adapter: ProviderReplayAdapter,
): string {
  return canonicalDigest({
    domain: "provider-replay-cache-v1",
    planDigest: plan.planDigest,
    requestId,
    attempt,
    namespace: adapter.cacheCapability.namespace ?? null,
  });
}
function replaceSummaryReference(value: unknown, summaries: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    const prefix = "Selective history summary reference: ";
    return value.startsWith(prefix)
      ? `${prefix}${summaries.get(value.slice(prefix.length)) ?? ""}`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => replaceSummaryReference(item, summaries));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceSummaryReference(item, summaries)]),
    );
  return value;
}
async function append(
  safeRun: SafeRun,
  type: string,
  id: string,
  time: string,
  data: RecordValue,
  failed = false,
): Promise<void> {
  timestamp(time);
  await appendEvent(safeRun, PROVIDER_REPLAY_LEDGER_PATH, {
    eventId: id,
    timestamp: time,
    type,
    data,
    ...(failed
      ? {
          failed: true,
          error: typeof data.failureClass === "string" ? data.failureClass : "dependency",
        }
      : {}),
  });
}

function validateLooseLedgerData(phase: Phase, data: RecordValue): void {
  if (phase === "skip") {
    exactKeys(
      data,
      ["attempt", "dependency", "disposition", "planDigest", "requestId"],
      "provider replay skip has invalid fields",
    );
    if (data.dependency !== "selective-summary" || data.disposition !== "skipped")
      fail("E_EVAL_INTEGRITY", "provider replay skip is invalid");
    return;
  }
  const staticKeys = [
    "planDigest",
    "snapshotDigest",
    "requestOrigin",
    "requestId",
    "kind",
    "arm",
    "replicateIndex",
    ...(data.kind === "checkpoint" ? ["checkpointIndex"] : []),
    "attempt",
    ...(data.attempt === 2 ? ["retryOf"] : []),
    "target",
    "providerPolicyDigest",
    "inputDigest",
    "timeoutMs",
    "cacheKey",
    "cacheIsolation",
    "startEventId",
  ];
  const extras =
    phase === "start"
      ? ["phase"]
      : phase === "result"
        ? data.outcome === "success"
          ? ["phase", "outcome", "outputRef", "outputDigest"]
          : ["phase", "outcome", "failureClass"]
        : [
            "phase",
            "resultEventId",
            "billedDisposition",
            "usageCompleteness",
            ...(data.usageCompleteness === "complete" ? ["usage"] : []),
          ];
  exactKeys(
    data,
    [...staticKeys, ...extras],
    "provider replay ledger event has invalid type-specific fields",
  );
  if (
    data.requestOrigin !== "replay" ||
    (data.kind !== "summary" && data.kind !== "checkpoint") ||
    (data.arm !== "native" && data.arm !== "selective") ||
    !Number.isSafeInteger(data.replicateIndex) ||
    (data.kind === "checkpoint" && ![1, 2, 3, 4, 5].includes(data.checkpointIndex as number)) ||
    !["isolated", "not-isolated", "unknown"].includes(data.cacheIsolation as string) ||
    ![
      "planDigest",
      "snapshotDigest",
      "providerPolicyDigest",
      "inputDigest",
      "cacheKey",
      "startEventId",
    ].every((key) => typeof data[key] === "string" && DIGEST.test(data[key] as string)) ||
    !isRecord(data.target) ||
    canonicalJson(Object.keys(data.target).sort()) !==
      canonicalJson(["api", "model", "provider", "reasoning"]) ||
    Object.values(data.target).some((item) => typeof item !== "string" || item.length === 0) ||
    !positive(data.timeoutMs)
  )
    fail("E_EVAL_INTEGRITY", "provider replay ledger static fields are invalid");
  if (
    data.startEventId !==
      eventId(
        data.planDigest as string,
        data.requestId as string,
        data.attempt as number,
        "start",
      ) ||
    (data.attempt === 2 &&
      data.retryOf !== eventId(data.planDigest as string, data.requestId as string, 1, "start"))
  )
    fail("E_EVAL_INTEGRITY", "provider replay ledger retry/start linkage is invalid");
  if (phase === "start" && data.phase !== "started")
    fail("E_EVAL_INTEGRITY", "provider replay start phase is invalid");
  if (
    phase === "result" &&
    ((data.outcome === "success" &&
      (typeof data.outputRef !== "string" ||
        typeof data.outputDigest !== "string" ||
        !DIGEST.test(data.outputDigest))) ||
      (data.outcome === "failure" && !isFailureClass(data.failureClass)) ||
      (data.outcome !== "success" && data.outcome !== "failure"))
  )
    fail("E_EVAL_INTEGRITY", "provider replay result is invalid");
  if (
    phase === "usage" &&
    (data.resultEventId !==
      eventId(
        data.planDigest as string,
        data.requestId as string,
        data.attempt as number,
        "result",
      ) ||
      !isBilling(data.billedDisposition) ||
      (data.usageCompleteness !== "complete" && data.usageCompleteness !== "missing") ||
      (data.usageCompleteness === "complete" && parseReportedUsage(data.usage) === undefined))
  )
    fail("E_EVAL_INTEGRITY", "provider replay usage is invalid");
}
function ledgerPhase(type: string): Phase | undefined {
  return type === "provider-replay-start-v2"
    ? "start"
    : type === "provider-replay-result-v2"
      ? "result"
      : type === "provider-replay-usage-v2"
        ? "usage"
        : type === "provider-replay-skip-v2"
          ? "skip"
          : undefined;
}
async function loadLedger(safeRun: SafeRun, plan: ReplayPlan): Promise<LedgerState> {
  const state: LedgerState = {
    starts: new Map(),
    results: new Map(),
    usages: new Map(),
    skips: new Set(),
    origins: new Map(),
  };
  if (!(await safeRunFileExists(safeRun, PROVIDER_REPLAY_LEDGER_PATH))) return state;
  let text: string;
  try {
    text = UTF8.decode(await safeRunReadFile(safeRun, PROVIDER_REPLAY_LEDGER_PATH));
  } catch {
    fail("E_EVAL_INTEGRITY", "provider replay ledger is not UTF-8");
  }
  if (text.length === 0 || !text.endsWith("\n"))
    fail("E_EVAL_INTEGRITY", "provider replay ledger must be canonical JSONL");
  const ids = new Set<string>();
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    if (line.length === 0) fail("E_EVAL_INTEGRITY", "provider replay ledger has a blank line");
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      fail("E_EVAL_INTEGRITY", `malformed provider replay ledger event ${index + 1}`);
    }
    if (!isRecord(raw) || canonicalJson(raw) !== line)
      fail("E_EVAL_INTEGRITY", "provider replay ledger is noncanonical");
    const fields =
      raw.failed === true
        ? ["data", "error", "eventId", "failed", "timestamp", "type"]
        : ["data", "eventId", "timestamp", "type"];
    exactKeys(raw, fields, "provider replay ledger event has invalid top-level fields");
    if (
      typeof raw.eventId !== "string" ||
      !DIGEST.test(raw.eventId) ||
      typeof raw.type !== "string" ||
      !isRecord(raw.data)
    )
      fail("E_EVAL_INTEGRITY", "provider replay ledger event fields are invalid");
    timestamp(raw.timestamp);
    const data = raw.data;
    if (raw.type === "provider-replay-compaction-origin-v2") {
      const originKeys = [
        "attemptId",
        "billingDisposition",
        "captureDigest",
        "operation",
        "operationId",
        "probeDigest",
        "resolutionDigest",
        "usageCompleteness",
      ];
      if (data.usageCompleteness === "complete") originKeys.push("usage");
      exactKeys(data, originKeys, "compaction-origin usage record has invalid fields");
      if (
        typeof data.attemptId !== "string" ||
        typeof data.operationId !== "string" ||
        (data.operation !== "native-compaction" && data.operation !== "following-main") ||
        !isBilling(data.billingDisposition) ||
        (data.usageCompleteness !== "complete" && data.usageCompleteness !== "missing") ||
        (data.usageCompleteness === "complete" && parseReportedUsage(data.usage) === undefined) ||
        !["resolutionDigest", "probeDigest", "captureDigest"].every(
          (key) => typeof data[key] === "string" && DIGEST.test(data[key] as string),
        ) ||
        raw.eventId !==
          canonicalDigest({
            domain: "provider-replay-compaction-origin-v2",
            resolutionDigest: data.resolutionDigest,
            attemptId: data.attemptId,
          }) ||
        ids.has(raw.eventId)
      )
        fail("E_EVAL_INTEGRITY", "compaction-origin usage record is invalid");
      ids.add(raw.eventId);
      if (state.origins.has(data.attemptId))
        fail("E_EVAL_INTEGRITY", "duplicate compaction-origin usage record");
      state.origins.set(data.attemptId, data);
      continue;
    }
    const phase = ledgerPhase(raw.type);
    if (phase === undefined)
      fail("E_EVAL_INTEGRITY", "provider replay ledger contains an unsupported event type");
    if (
      typeof data.requestId !== "string" ||
      (data.attempt !== 1 && data.attempt !== 2) ||
      data.planDigest !== plan.planDigest
    )
      fail("E_EVAL_INTEGRITY", "provider replay ledger does not bind the frozen plan");
    validateLooseLedgerData(phase, data);
    if (
      raw.failed === true &&
      raw.error !== (typeof data.failureClass === "string" ? data.failureClass : "dependency")
    )
      fail("E_EVAL_INTEGRITY", "provider replay ledger failure marker disagrees with its data");
    if (
      raw.eventId !== eventId(plan.planDigest, data.requestId, data.attempt, phase) ||
      ids.has(raw.eventId)
    )
      fail("E_EVAL_INTEGRITY", "provider replay ledger event ID is invalid or duplicated");
    ids.add(raw.eventId);
    const key = `${data.requestId}:${data.attempt}`;
    if (phase === "skip") {
      if (state.skips.has(key)) fail("E_EVAL_INTEGRITY", "duplicate provider replay ledger phase");
      state.skips.add(key);
    } else {
      const map =
        phase === "start" ? state.starts : phase === "result" ? state.results : state.usages;
      if (map.has(key)) fail("E_EVAL_INTEGRITY", "duplicate provider replay ledger phase");
      map.set(key, data);
    }
  }
  return state;
}
async function appendCompactionOriginUsage(
  safeRun: SafeRun,
  resolution: CompactionAccountingResolutionArtifact,
  ledger: LedgerState,
  now: () => string,
): Promise<void> {
  const probePath = `compaction-usage-probes/t009b-${resolution.generatedInputDigest.slice(0, 32)}.json`;
  let probe: CompactionUsageProbeArtifact;
  try {
    probe = JSON.parse(
      UTF8.decode(await safeRunReadFile(safeRun, probePath)),
    ) as CompactionUsageProbeArtifact;
  } catch {
    fail("E_EVAL_INTEGRITY", "cannot load authoritative compaction-origin probe");
  }
  const capture = captureCompactionUsage({ events: probe.data.facts });
  for (const attempt of [...capture.compactionAttempts, ...capture.followingMainAttempts]) {
    const data = {
      resolutionDigest: resolution.resolutionDigest,
      probeDigest: probe.eventId,
      captureDigest: canonicalDigest(capture),
      attemptId: attempt.attemptId,
      operationId: attempt.operationId,
      operation: attempt.operation,
      billingDisposition: attempt.billing,
      usageCompleteness: attempt.usage === undefined ? "missing" : "complete",
      ...(attempt.usage === undefined ? {} : { usage: attempt.usage }),
    };
    const id = canonicalDigest({
      domain: "provider-replay-compaction-origin-v2",
      resolutionDigest: resolution.resolutionDigest,
      attemptId: attempt.attemptId,
    });
    const prior = ledger.origins.get(attempt.attemptId);
    if (prior !== undefined) {
      if (canonicalJson(prior) !== canonicalJson(data))
        fail("E_EVAL_INTEGRITY", "compaction-origin ledger record does not match its resolution");
      continue;
    }
    await append(safeRun, "provider-replay-compaction-origin-v2", id, now(), data);
    ledger.origins.set(attempt.attemptId, data);
  }
}
function base(
  plan: ReplayPlan,
  item: ScheduledRequest,
  attempt: 1 | 2,
  target: ProviderReplayTarget,
  policy: ProviderPolicy,
  inputDigest: string,
  cache: CacheIsolationStatus,
  key: string,
): RecordValue {
  return {
    planDigest: plan.planDigest,
    snapshotDigest: plan.shared.snapshotDigest,
    requestOrigin: "replay",
    requestId: item.requestId,
    kind: item.kind,
    arm: item.arm,
    replicateIndex: item.replicateIndex,
    ...(item.checkpointIndex === undefined ? {} : { checkpointIndex: item.checkpointIndex }),
    attempt,
    ...(attempt === 2 ? { retryOf: eventId(plan.planDigest, item.requestId, 1, "start") } : {}),
    target,
    providerPolicyDigest: providerPolicyDigest(policy),
    inputDigest,
    timeoutMs: policy.timeoutMs[item.kind],
    cacheKey: key,
    cacheIsolation: cache,
    startEventId: eventId(plan.planDigest, item.requestId, attempt, "start"),
  };
}
function assertStatic(data: RecordValue, expected: RecordValue): void {
  for (const [key, value] of Object.entries(expected))
    if (canonicalJson(data[key]) !== canonicalJson(value))
      fail("E_EVAL_INTEGRITY", `provider replay ledger ${key} does not match its frozen schedule`);
}
function validateLedgerData(
  phase: Phase,
  data: RecordValue,
  expected: RecordValue,
  plan: ReplayPlan,
): void {
  assertStatic(data, expected);
  const baseKeys = Object.keys(expected);
  if (phase === "start")
    exactKeys(data, [...baseKeys, "phase"], "provider replay start has invalid fields");
  else if (phase === "result") {
    if (data.outcome === "success") {
      exactKeys(
        data,
        [...baseKeys, "outputDigest", "outputRef", "outcome", "phase"],
        "provider replay successful result has invalid fields",
      );
      if (
        typeof data.outputRef !== "string" ||
        typeof data.outputDigest !== "string" ||
        !DIGEST.test(data.outputDigest)
      )
        fail("E_EVAL_INTEGRITY", "provider output result is invalid");
    } else {
      exactKeys(
        data,
        [...baseKeys, "failureClass", "outcome", "phase"],
        "provider replay failed result has invalid fields",
      );
      if (data.outcome !== "failure" || !isFailureClass(data.failureClass))
        fail("E_EVAL_INTEGRITY", "provider replay failure result is invalid");
    }
  } else if (phase === "usage") {
    const keys = [...baseKeys, "billedDisposition", "phase", "resultEventId", "usageCompleteness"];
    if (data.usageCompleteness === "complete") keys.push("usage");
    exactKeys(data, keys, "provider replay usage has invalid fields");
    if (
      !isBilling(data.billedDisposition) ||
      (data.usageCompleteness !== "complete" && data.usageCompleteness !== "missing") ||
      (data.usageCompleteness === "complete" && parseReportedUsage(data.usage) === undefined) ||
      data.resultEventId !==
        eventId(plan.planDigest, expected.requestId as string, expected.attempt as number, "result")
    )
      fail("E_EVAL_INTEGRITY", "provider replay usage linkage is invalid");
  } else {
    exactKeys(
      data,
      ["attempt", "dependency", "disposition", "planDigest", "requestId"],
      "provider replay skip has invalid fields",
    );
    if (data.dependency !== "selective-summary" || data.disposition !== "skipped")
      fail("E_EVAL_INTEGRITY", "provider replay skip is invalid");
  }
  if (data.phase !== (phase === "start" ? "started" : phase))
    fail("E_EVAL_INTEGRITY", "provider replay phase marker is invalid");
}
async function readVerifiedOutput(
  safeRun: SafeRun,
  result: RecordValue,
  expectedRef: string,
): Promise<string> {
  if (
    result.outputRef !== expectedRef ||
    typeof result.outputDigest !== "string" ||
    !DIGEST.test(result.outputDigest) ||
    !(await safeRunFileExists(safeRun, expectedRef))
  )
    fail("E_EVAL_INTEGRITY", "provider output reference is missing or unexpected");
  let output: string;
  try {
    output = UTF8.decode(await safeRunReadFile(safeRun, expectedRef));
  } catch {
    fail("E_EVAL_INTEGRITY", "provider output is not UTF-8");
  }
  if (canonicalDigest(output) !== result.outputDigest)
    fail("E_EVAL_INTEGRITY", "provider output digest does not match published output");
  return output;
}
function confirmed(
  received: ProviderReplayConfirmation | string | undefined,
  expected: ProviderReplayConfirmation,
): boolean {
  if (received === undefined) return false;
  const digest = typeof received === "string" ? received : received.confirmationDigest;
  if (digest !== expected.confirmationDigest)
    fail(
      "E_EVAL_INTEGRITY",
      "provider confirmation digest/token does not match frozen plan, target, policy, calls, and cost",
    );
  if (typeof received !== "string" && canonicalJson(received) !== canonicalJson(expected))
    fail("E_EVAL_INTEGRITY", "provider confirmation body does not match its digest");
  return true;
}
export interface PreparedProviderReplayExecution {
  readonly plan: ReplayPlan;
  readonly targetSelection: TargetSelectionRecord;
  readonly target: ProviderReplayTarget;
  readonly policy: ProviderPolicy;
  readonly bound: ReturnType<typeof providerReplayUpperBound>;
  readonly resolution: CompactionAccountingResolutionArtifact;
}
/** Adapter-free preflight. This must run before any dynamic adapter import. */
export async function prepareProviderReplayExecution(
  input: ProviderReplayPreparationInput,
): Promise<PreparedProviderReplayExecution | undefined> {
  const plan = await validateReplayPlan(
    input.replayAccess,
    input.selection,
    input.replayInput,
    input.plan,
  );
  const targetSelection = validateTargetSelectionRecord(input.targetSelection);
  const policy = validateProviderPolicy(input.providerPolicy);
  const target = providerReplayTarget(targetSelection);
  if (
    plan.shared.targetSelectionDigest !== canonicalDigest(targetSelection) ||
    targetSelection.providerPolicyDigest !== providerPolicyDigest(policy)
  )
    fail("E_EVAL_INTEGRITY", "replay plan target or target policy binding changed");
  const bound = providerReplayUpperBound(plan, policy);
  if (
    !confirmed(input.confirmation, createProviderReplayConfirmation(plan, targetSelection, policy))
  )
    return undefined;
  if (input.gate.frozenPlanDigest !== plan.planDigest)
    fail("E_EVAL_INTEGRITY", "frozen replay plan hash does not match authenticated plan");
  const resolution = await verifyResolution(
    input.safeRun,
    input.gate.resolution,
    targetSelection,
    policy,
  );
  return frozen({ plan, targetSelection, target, policy, bound, resolution });
}
async function invoke(
  adapter: ProviderReplayAdapter,
  request: ProviderReplayRequest,
): Promise<ProviderAdapterResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    return await Promise.race([
      adapter.execute(
        frozen({
          ...request,
          signal: controller.signal,
          deadlineMs: Date.now() + request.timeoutMs,
        }),
      ),
      new Promise<ProviderAdapterResult>((resolve) =>
        setTimeout(
          () => resolve({ ok: false, failureClass: "timeout", billed: "unknown" }),
          request.timeoutMs,
        ),
      ),
    ]);
  } catch {
    return { ok: false, failureClass: "unknown", billed: "unknown" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Ordinary replay; only a persisted, complete, exact T-009B resolution enables calls. */
export async function runProviderReplay(
  input: ProviderReplayRunInput,
): Promise<ProviderReplayRunResult> {
  const prepared = await prepareProviderReplayExecution(input);
  if (prepared === undefined)
    return frozen({
      status: "refused",
      plannedCallCount: providerReplayUpperBound(
        await validateReplayPlan(
          input.replayAccess,
          input.selection,
          input.replayInput,
          input.plan,
        ),
        input.providerPolicy,
      ).plannedCallCount,
      upperCost: providerReplayUpperBound(
        await validateReplayPlan(
          input.replayAccess,
          input.selection,
          input.replayInput,
          input.plan,
        ),
        input.providerPolicy,
      ).upperCost,
      attemptedCallCount: 0,
      completedRequestCount: 0,
      cacheIsolation: "unknown",
    });
  if (!exactTarget(input.adapter.target, prepared.target))
    fail("E_EVAL_INTEGRITY", "adapter immutable target differs from confirmed target");
  const cache = cacheStatus(input.adapter, prepared.policy.cacheStrategy);
  if (cache !== "isolated") fail("E_EVAL_INTEGRITY", "adapter cache isolation is not confirmed");
  await ensurePrivateDir(input.safeRun, PROVIDER_REPLAY_OUTPUT_DIRECTORY);
  const ledger = await loadLedger(input.safeRun, prepared.plan);
  const scheduled = schedule(prepared.plan);
  const known = new Set(
    scheduled.flatMap((item) => [`${item.requestId}:1`, `${item.requestId}:2`]),
  );
  for (const key of [
    ...ledger.starts.keys(),
    ...ledger.results.keys(),
    ...ledger.usages.keys(),
    ...ledger.skips,
  ])
    if (!known.has(key))
      fail(
        "E_EVAL_INTEGRITY",
        "provider replay ledger references a request outside the frozen schedule",
      );
  for (const key of ledger.starts.keys())
    if (!ledger.results.has(key) || !ledger.usages.has(key))
      return frozen({
        status: "failed",
        ...prepared.bound,
        attemptedCallCount: 0,
        completedRequestCount: 0,
        cacheIsolation: cache,
      });
  for (const key of ledger.results.keys())
    if (!ledger.starts.has(key) || !ledger.usages.has(key))
      fail("E_EVAL_INTEGRITY", "provider replay result lacks a complete durable start/usage chain");
  for (const key of ledger.usages.keys())
    if (!ledger.starts.has(key) || !ledger.results.has(key))
      fail("E_EVAL_INTEGRITY", "provider replay usage lacks a durable result marker");
  for (const item of scheduled) {
    const first = ledger.results.get(`${item.requestId}:1`);
    const hasSecond =
      ledger.starts.has(`${item.requestId}:2`) ||
      ledger.results.has(`${item.requestId}:2`) ||
      ledger.usages.has(`${item.requestId}:2`);
    if (
      hasSecond &&
      (first === undefined ||
        first.outcome !== "failure" ||
        !prepared.policy.retryableErrorClasses.includes(first.failureClass as ProviderFailureClass))
    )
      fail(
        "E_EVAL_INTEGRITY",
        "provider replay retry does not follow exactly one retryable failure",
      );
  }
  for (const result of ledger.results.values())
    if (result.outcome === "success")
      await readVerifiedOutput(
        input.safeRun,
        result,
        outputPath(
          eventId(
            prepared.plan.planDigest,
            result.requestId as string,
            result.attempt as number,
            "result",
          ),
        ),
      );
  await appendCompactionOriginUsage(input.safeRun, prepared.resolution, ledger, input.now);
  let attempted = 0;
  let completed = 0;
  let failed = false;
  const summaries = new Map<string, string>();
  for (const item of scheduled) {
    if (failed) {
      if (item.arm === "selective" && item.kind === "checkpoint") {
        for (const attempt of [1, 2] as const) {
          const key = `${item.requestId}:${attempt}`;
          if (ledger.skips.has(key)) continue;
          if (ledger.starts.has(key) || ledger.results.has(key) || ledger.usages.has(key))
            fail("E_EVAL_INTEGRITY", "terminal failure conflicts with a selective dependency skip");
          const data = {
            planDigest: prepared.plan.planDigest,
            requestId: item.requestId,
            attempt,
            dependency: "selective-summary",
            disposition: "skipped",
          };
          await append(
            input.safeRun,
            "provider-replay-skip-v2",
            eventId(prepared.plan.planDigest, item.requestId, attempt, "skip"),
            input.now(),
            data,
            true,
          );
          ledger.skips.add(key);
        }
      }
      continue;
    }
    for (const attempt of [1, 2] as const) {
      const key = `${item.requestId}:${attempt}`;
      const priorStart = ledger.starts.get(key);
      const priorResult = ledger.results.get(key);
      const priorUsage = ledger.usages.get(key);
      if (ledger.skips.has(key)) {
        if (
          item.arm !== "selective" ||
          item.kind !== "checkpoint" ||
          priorStart !== undefined ||
          priorResult !== undefined ||
          priorUsage !== undefined
        )
          fail("E_EVAL_INTEGRITY", "invalid provider replay dependency skip");
        failed = true;
        break;
      }
      const requestInput = replaceSummaryReference(item.input, summaries);
      const expected = base(
        prepared.plan,
        item,
        attempt,
        prepared.target,
        prepared.policy,
        canonicalDigest(requestInput),
        cache,
        cacheKey(prepared.plan, item.requestId, attempt, input.adapter),
      );
      if (priorStart !== undefined)
        validateLedgerData("start", priorStart, expected, prepared.plan);
      if (priorResult !== undefined)
        validateLedgerData("result", priorResult, expected, prepared.plan);
      if (priorUsage !== undefined)
        validateLedgerData("usage", priorUsage, expected, prepared.plan);
      if (priorStart !== undefined && (priorResult === undefined || priorUsage === undefined))
        return frozen({
          status: "failed",
          ...prepared.bound,
          attemptedCallCount: attempted,
          completedRequestCount: completed,
          cacheIsolation: cache,
        });
      if (priorResult !== undefined) {
        if (priorResult.outcome === "success") {
          if (attempt === 2) {
            const first = ledger.results.get(`${item.requestId}:1`);
            if (
              first === undefined ||
              first.outcome !== "failure" ||
              !prepared.policy.retryableErrorClasses.includes(
                first.failureClass as ProviderFailureClass,
              )
            )
              fail("E_EVAL_INTEGRITY", "successful retry lacks its retryable first failure");
          }
          await readVerifiedOutput(
            input.safeRun,
            priorResult,
            outputPath(eventId(prepared.plan.planDigest, item.requestId, attempt, "result")),
          );
          completed += 1;
          if (item.kind === "summary")
            summaries.set(
              item.requestId,
              await readVerifiedOutput(
                input.safeRun,
                priorResult,
                outputPath(eventId(prepared.plan.planDigest, item.requestId, attempt, "result")),
              ),
            );
          break;
        }
        if (
          attempt === 1 &&
          prepared.policy.retryableErrorClasses.includes(
            priorResult.failureClass as ProviderFailureClass,
          )
        )
          continue;
        failed = true;
        break;
      }
      if (attempt === 2) {
        const first = ledger.results.get(`${item.requestId}:1`);
        if (
          first === undefined ||
          first.outcome !== "failure" ||
          !prepared.policy.retryableErrorClasses.includes(
            first.failureClass as ProviderFailureClass,
          )
        ) {
          failed = true;
          break;
        }
      }
      if (item.arm === "selective" && item.kind === "checkpoint") {
        const summaryId = canonicalDigest({
          planDigest: prepared.plan.planDigest,
          replicate: item.replicateIndex,
          kind: "summary",
          arm: "selective",
        });
        if (!summaries.has(summaryId)) {
          const data = {
            planDigest: prepared.plan.planDigest,
            requestId: item.requestId,
            attempt,
            dependency: "selective-summary",
            disposition: "skipped",
          };
          await append(
            input.safeRun,
            "provider-replay-skip-v2",
            eventId(prepared.plan.planDigest, item.requestId, attempt, "skip"),
            input.now(),
            data,
            true,
          );
          ledger.skips.add(key);
          failed = true;
          break;
        }
      }
      await append(
        input.safeRun,
        "provider-replay-start-v2",
        eventId(prepared.plan.planDigest, item.requestId, attempt, "start"),
        input.now(),
        { ...expected, phase: "started" },
      );
      ledger.starts.set(key, { ...expected, phase: "started" });
      if (
        !exactTarget(input.adapter.target, prepared.target) ||
        cacheStatus(input.adapter, prepared.policy.cacheStrategy) !== "isolated"
      )
        fail("E_EVAL_INTEGRITY", "adapter target or cache changed after confirmation");
      const request = frozen({
        requestId: item.requestId,
        kind: item.kind,
        arm: item.arm,
        replicateIndex: item.replicateIndex,
        ...(item.checkpointIndex === undefined ? {} : { checkpointIndex: item.checkpointIndex }),
        attempt,
        ...(attempt === 2
          ? { retryOf: eventId(prepared.plan.planDigest, item.requestId, 1, "start") }
          : {}),
        timeoutMs: prepared.policy.timeoutMs[item.kind],
        deadlineMs: Date.now() + prepared.policy.timeoutMs[item.kind],
        signal: new AbortController().signal,
        input: requestInput,
        inputDigest: canonicalDigest(requestInput),
        confirmedTarget: prepared.target,
        cacheKey: expected.cacheKey as string,
      });
      const result = await invoke(input.adapter, request);
      attempted += 1;
      const usage = parseReportedUsage(result.usage);
      let resultData: RecordValue;
      if (result.ok) {
        const resultId = eventId(prepared.plan.planDigest, item.requestId, attempt, "result");
        const ref = outputPath(resultId);
        if (!(await safeRunPublishExclusiveFile(input.safeRun, ref, result.output)))
          fail(
            "E_EVAL_INTEGRITY",
            "provider output path was already published without its durable result",
          );
        resultData = {
          ...expected,
          phase: "result",
          outcome: "success",
          outputRef: ref,
          outputDigest: canonicalDigest(result.output),
        };
        await append(input.safeRun, "provider-replay-result-v2", resultId, input.now(), resultData);
        completed += 1;
        if (item.kind === "summary") summaries.set(item.requestId, result.output);
      } else {
        resultData = {
          ...expected,
          phase: "result",
          outcome: "failure",
          failureClass: result.failureClass,
        };
        await append(
          input.safeRun,
          "provider-replay-result-v2",
          eventId(prepared.plan.planDigest, item.requestId, attempt, "result"),
          input.now(),
          resultData,
          true,
        );
      }
      const usageData = {
        ...expected,
        phase: "usage",
        resultEventId: eventId(prepared.plan.planDigest, item.requestId, attempt, "result"),
        billedDisposition: result.billed,
        usageCompleteness: usage === undefined ? "missing" : "complete",
        ...(usage === undefined ? {} : { usage }),
      };
      await append(
        input.safeRun,
        "provider-replay-usage-v2",
        eventId(prepared.plan.planDigest, item.requestId, attempt, "usage"),
        input.now(),
        usageData,
      );
      ledger.results.set(key, resultData);
      ledger.usages.set(key, usageData);
      if (result.ok) break;
      if (!prepared.policy.retryableErrorClasses.includes(result.failureClass) || attempt === 2) {
        failed = true;
        break;
      }
    }
  }
  return frozen({
    status: failed ? "failed" : "completed",
    ...prepared.bound,
    attemptedCallCount: attempted,
    completedRequestCount: completed,
    cacheIsolation: cache,
  });
}
