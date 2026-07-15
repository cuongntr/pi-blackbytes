/** Immutable evaluation snapshots, private gold ledgers, and fixture classifications. */

import { validateSelectedCandidateResult } from "./annotations.js";
import { canonicalDigest, canonicalJson } from "./canonical-json.js";
import type { SafeRun } from "./path-safety.js";
import {
  ensurePrivateDir,
  safeRunPath,
  safeRunPublishExclusiveFile,
  safeRunReadFile,
  safeRunReaddir,
  safeRunWriteFile,
} from "./path-safety.js";
import { validateQualificationRecord } from "./qualification.js";
import { EvidenceStoreError, SCHEMA_VERSION } from "./types.js";
import type { QualificationRecord } from "./types.js";

export const GOLD_FACT_CATEGORIES = [
  "goal",
  "hard-constraint",
  "decision-and-rationale",
  "repository-state",
  "unresolved-work",
  "current-authorization",
  "revoked-authorization",
] as const;
export const FIXTURE_STATUSES = ["exact", "reconstructed", "unavailable"] as const;

export type GoldFactCategory = (typeof GOLD_FACT_CATEGORIES)[number];
export type FixtureStatus = (typeof FIXTURE_STATUSES)[number];

export interface SnapshotCheckpoint {
  readonly checkpointIndex: 1 | 2 | 3 | 4 | 5;
  readonly requestEntryId: string;
  readonly nativeContextDigest: string;
}

export interface GoldFact {
  readonly factId: string;
  readonly category: GoldFactCategory;
  readonly sourceEntryIds: readonly string[];
  readonly statement: string;
  readonly diagnosticAtCheckpoints: readonly [boolean, boolean, boolean, boolean, boolean];
}

export interface GoldLedger {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly facts: readonly GoldFact[];
  readonly ledgerDigest: string;
}

export type RepositoryFixture =
  | {
      readonly status: "exact";
      readonly executionTarget: "disposable-only";
      readonly commitDigest: string;
      readonly archiveDigest: string;
      readonly artifactId: string;
    }
  | {
      readonly status: "reconstructed";
      readonly executionTarget: "disposable-only";
      readonly commitDigest: string;
      readonly patchDigest: string;
      readonly reconstructionLogDigest: string;
      readonly artifactId: string;
    }
  | {
      readonly status: "unavailable";
      readonly executionTarget: "none";
      readonly reasonCode: "fixture-not-captured" | "fixture-integrity-failed";
    };

export interface EvaluationSnapshot {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly corpusId: string;
  readonly selectedRank: number;
  readonly selectionDigest: string;
  readonly qualificationDigest: string;
  readonly candidateDigest: string;
  readonly closureEntryId: string;
  readonly checkpoints: readonly [
    SnapshotCheckpoint,
    SnapshotCheckpoint,
    SnapshotCheckpoint,
    SnapshotCheckpoint,
    SnapshotCheckpoint,
  ];
  readonly targetSelectionDigest: string;
  readonly systemPromptDigest: string;
  readonly toolSchemaDigest: string;
  readonly summaryInstructionDigest: string;
  readonly rubricDigest: string;
  readonly objectiveChecksDigest: string;
  readonly fixture: RepositoryFixture;
  readonly goldLedgerDigest: string;
  readonly snapshotDigest: string;
}

export interface FrozenSnapshotBundle {
  readonly snapshot: EvaluationSnapshot;
  readonly goldLedger: GoldLedger;
}

export interface FreezeSnapshotInput {
  readonly selection: unknown;
  readonly checkpoints: readonly unknown[];
  readonly targetSelectionDigest: string;
  readonly systemPromptDigest: string;
  readonly toolSchemaDigest: string;
  readonly summaryInstructionDigest: string;
  readonly rubricDigest: string;
  readonly objectiveChecksDigest: string;
  readonly fixture: unknown;
  readonly goldFacts: readonly unknown[];
}

export interface SummaryGenerationAccess {
  readonly snapshotId: string;
  readonly candidateRange: {
    readonly startEntryId: string;
    readonly endEntryId: string;
  };
  readonly summaryInstructionDigest: string;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GOLD_CATEGORY_SET = new Set<string>(GOLD_FACT_CATEGORIES);
const persistenceQueues = new Map<string, Promise<void>>();

function schema(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}

function integrity(message: string): never {
  throw new EvidenceStoreError("E_EVAL_INTEGRITY", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactFields(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    schema(`Expected exactly fields: ${wanted.join(", ")}`);
  }
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    schema(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requirePositiveRank(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    schema("selectedRank must be positive");
  return value as number;
}

function requireSchemaVersion(value: unknown): typeof SCHEMA_VERSION {
  if (value !== SCHEMA_VERSION) schema(`schemaVersion must equal ${SCHEMA_VERSION}`);
  return SCHEMA_VERSION;
}

function digestWithout<T extends Record<string, unknown>>(value: T, field: keyof T): string {
  const copy = { ...value };
  delete copy[field];
  return canonicalDigest(copy);
}

function validateFinalQualification(value: unknown): QualificationRecord {
  const record = validateQualificationRecord(value);
  if (
    !record.qualifies ||
    record.candidate === undefined ||
    Object.values(record.criteria).some((criterion) => !criterion) ||
    record.reasonCodes.length !== 0 ||
    record.candidate.estimatedTokens < 2_048 ||
    record.candidate.closureEvidence.length === 0 ||
    record.candidate.subsequentRequestIds.length !== 5 ||
    new Set(record.candidate.subsequentRequestIds).size !== 5 ||
    record.annotatorIds.length !== 2 ||
    new Set(record.annotatorIds).size !== 2 ||
    record.adjudicationStatus === "unresolved"
  ) {
    schema("snapshot requires one resolved, fully qualifying T-007B record");
  }
  requireDigest(record.corpusId, "qualification.corpusId");
  for (const [field, reference] of [
    ["branchLeafId", record.candidate.branchLeafId],
    ["startEntryId", record.candidate.startEntryId],
    ["endEntryId", record.candidate.endEntryId],
    ["closureEntryId", record.candidate.closureEntryId],
    ...record.candidate.subsequentRequestIds.map(
      (entryId, index) => [`subsequentRequestIds[${index}]`, entryId] as const,
    ),
    ...record.annotatorIds.map(
      (annotatorId, index) => [`annotatorIds[${index}]`, annotatorId] as const,
    ),
  ] as const) {
    requireDigest(reference, `qualification.${field}`);
  }
  return record;
}

export function validateSnapshotCheckpoint(value: unknown): SnapshotCheckpoint {
  if (!isRecord(value)) schema("checkpoint must be an object");
  requireExactFields(value, ["checkpointIndex", "nativeContextDigest", "requestEntryId"]);
  if (
    !Number.isSafeInteger(value.checkpointIndex) ||
    (value.checkpointIndex as number) < 1 ||
    (value.checkpointIndex as number) > 5
  ) {
    schema("checkpointIndex must be 1..5");
  }
  return Object.freeze({
    checkpointIndex: value.checkpointIndex as 1 | 2 | 3 | 4 | 5,
    requestEntryId: requireDigest(value.requestEntryId, "requestEntryId"),
    nativeContextDigest: requireDigest(value.nativeContextDigest, "nativeContextDigest"),
  });
}

export function validateRepositoryFixture(value: unknown): RepositoryFixture {
  if (!isRecord(value)) schema("fixture must be an object");
  if (value.status === "exact") {
    requireExactFields(value, [
      "archiveDigest",
      "artifactId",
      "commitDigest",
      "executionTarget",
      "status",
    ]);
    if (value.executionTarget !== "disposable-only")
      schema("exact fixture must be disposable-only");
    return Object.freeze({
      status: "exact",
      executionTarget: "disposable-only",
      commitDigest: requireDigest(value.commitDigest, "commitDigest"),
      archiveDigest: requireDigest(value.archiveDigest, "archiveDigest"),
      artifactId: requireDigest(value.artifactId, "artifactId"),
    });
  }
  if (value.status === "reconstructed") {
    requireExactFields(value, [
      "artifactId",
      "commitDigest",
      "executionTarget",
      "patchDigest",
      "reconstructionLogDigest",
      "status",
    ]);
    if (value.executionTarget !== "disposable-only") {
      schema("reconstructed fixture must be disposable-only");
    }
    return Object.freeze({
      status: "reconstructed",
      executionTarget: "disposable-only",
      commitDigest: requireDigest(value.commitDigest, "commitDigest"),
      patchDigest: requireDigest(value.patchDigest, "patchDigest"),
      reconstructionLogDigest: requireDigest(
        value.reconstructionLogDigest,
        "reconstructionLogDigest",
      ),
      artifactId: requireDigest(value.artifactId, "artifactId"),
    });
  }
  if (value.status === "unavailable") {
    requireExactFields(value, ["executionTarget", "reasonCode", "status"]);
    if (value.executionTarget !== "none")
      schema("unavailable fixture cannot be an execution target");
    if (
      value.reasonCode !== "fixture-not-captured" &&
      value.reasonCode !== "fixture-integrity-failed"
    ) {
      schema("unsupported unavailable fixture reason");
    }
    return Object.freeze({
      status: "unavailable",
      executionTarget: "none",
      reasonCode: value.reasonCode,
    });
  }
  return schema("fixture status must be exact, reconstructed, or unavailable");
}

export function validateGoldFact(value: unknown): GoldFact {
  if (!isRecord(value)) schema("gold fact must be an object");
  requireExactFields(value, [
    "category",
    "diagnosticAtCheckpoints",
    "factId",
    "sourceEntryIds",
    "statement",
  ]);
  if (typeof value.category !== "string" || !GOLD_CATEGORY_SET.has(value.category)) {
    schema("unsupported gold fact category");
  }
  if (typeof value.statement !== "string" || value.statement.trim().length === 0) {
    schema("gold fact statement must be non-empty");
  }
  if (!Array.isArray(value.sourceEntryIds) || value.sourceEntryIds.length === 0) {
    schema("gold fact requires source references");
  }
  const sourceEntryIds = value.sourceEntryIds.map((entryId) =>
    requireDigest(entryId, "gold.sourceEntryId"),
  );
  if (new Set(sourceEntryIds).size !== sourceEntryIds.length) {
    schema("gold source references must be unique");
  }
  if (
    !Array.isArray(value.diagnosticAtCheckpoints) ||
    value.diagnosticAtCheckpoints.length !== 5 ||
    value.diagnosticAtCheckpoints.some((item) => typeof item !== "boolean")
  ) {
    schema("diagnosticAtCheckpoints must contain exactly five booleans");
  }
  return Object.freeze({
    factId: requireDigest(value.factId, "factId"),
    category: value.category as GoldFactCategory,
    sourceEntryIds: Object.freeze(sourceEntryIds),
    statement: value.statement,
    diagnosticAtCheckpoints: Object.freeze([
      ...value.diagnosticAtCheckpoints,
    ]) as GoldFact["diagnosticAtCheckpoints"],
  });
}

function buildGoldLedger(snapshotId: string, factValues: readonly unknown[]): GoldLedger {
  const facts = factValues
    .map(validateGoldFact)
    .sort((left, right) => left.factId.localeCompare(right.factId));
  if (new Set(facts.map((fact) => fact.factId)).size !== facts.length) {
    schema("gold fact IDs must be unique");
  }
  const base: Omit<GoldLedger, "ledgerDigest"> = {
    schemaVersion: SCHEMA_VERSION,
    snapshotId,
    facts: Object.freeze(facts),
  };
  return Object.freeze({ ...base, ledgerDigest: canonicalDigest(base) });
}

export function validateGoldLedger(value: unknown): GoldLedger {
  if (!isRecord(value)) schema("gold ledger must be an object");
  requireExactFields(value, ["facts", "ledgerDigest", "schemaVersion", "snapshotId"]);
  if (!Array.isArray(value.facts)) schema("gold ledger facts must be an array");
  const suppliedFacts = value.facts.map(validateGoldFact);
  const suppliedIds = suppliedFacts.map((fact) => fact.factId);
  const sortedIds = [...suppliedIds].sort();
  if (canonicalJson(suppliedIds) !== canonicalJson(sortedIds)) {
    integrity("gold ledger facts are not in frozen canonical order");
  }
  const ledger = buildGoldLedger(requireDigest(value.snapshotId, "snapshotId"), suppliedFacts);
  requireSchemaVersion(value.schemaVersion);
  const claimed = requireDigest(value.ledgerDigest, "ledgerDigest");
  if (ledger.ledgerDigest !== claimed) integrity("gold ledger digest mismatch");
  return ledger;
}

function snapshotBase(
  input: FreezeSnapshotInput,
  qualification: QualificationRecord,
  selectionDigest: string,
  fixture: RepositoryFixture,
): Omit<EvaluationSnapshot, "goldLedgerDigest" | "snapshotDigest"> {
  const candidate = qualification.candidate!;
  const checkpoints = input.checkpoints.map(validateSnapshotCheckpoint);
  if (
    checkpoints.length !== 5 ||
    checkpoints.some((checkpoint, index) => checkpoint.checkpointIndex !== index + 1)
  ) {
    schema("snapshot requires checkpoints 1..5 in order");
  }
  if (
    checkpoints.some(
      (checkpoint, index) => checkpoint.requestEntryId !== candidate.subsequentRequestIds[index],
    )
  ) {
    integrity("checkpoint request IDs do not match the qualified five-request horizon");
  }
  const snapshotId = canonicalDigest({
    domain: "context-pruning-primary-snapshot-v1",
    corpusId: qualification.corpusId,
    selectedRank: qualification.selectedRank,
  });
  const qualificationDigest = canonicalDigest(qualification);
  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId,
    corpusId: qualification.corpusId,
    selectedRank: qualification.selectedRank,
    selectionDigest,
    qualificationDigest,
    candidateDigest: canonicalDigest(candidate),
    closureEntryId: candidate.closureEntryId,
    checkpoints: Object.freeze(checkpoints) as EvaluationSnapshot["checkpoints"],
    targetSelectionDigest: requireDigest(input.targetSelectionDigest, "targetSelectionDigest"),
    systemPromptDigest: requireDigest(input.systemPromptDigest, "systemPromptDigest"),
    toolSchemaDigest: requireDigest(input.toolSchemaDigest, "toolSchemaDigest"),
    summaryInstructionDigest: requireDigest(
      input.summaryInstructionDigest,
      "summaryInstructionDigest",
    ),
    rubricDigest: requireDigest(input.rubricDigest, "rubricDigest"),
    objectiveChecksDigest: requireDigest(input.objectiveChecksDigest, "objectiveChecksDigest"),
    fixture,
  };
}

/** Freeze one primary snapshot and its separate private gold ledger. */
export function freezeSnapshot(input: FreezeSnapshotInput): FrozenSnapshotBundle {
  const selection = validateSelectedCandidateResult(input.selection);
  const qualification = validateFinalQualification(selection.qualification);
  const fixture = validateRepositoryFixture(input.fixture);
  const base = snapshotBase(input, qualification, canonicalDigest(selection), fixture);
  const goldLedger = buildGoldLedger(base.snapshotId, input.goldFacts);
  const snapshotWithoutDigest = { ...base, goldLedgerDigest: goldLedger.ledgerDigest };
  const snapshot = Object.freeze({
    ...snapshotWithoutDigest,
    snapshotDigest: canonicalDigest(snapshotWithoutDigest),
  });
  return Object.freeze({ snapshot, goldLedger });
}

export function validateEvaluationSnapshot(value: unknown): EvaluationSnapshot {
  if (!isRecord(value)) schema("snapshot must be an object");
  requireExactFields(value, [
    "candidateDigest",
    "checkpoints",
    "closureEntryId",
    "corpusId",
    "fixture",
    "goldLedgerDigest",
    "objectiveChecksDigest",
    "qualificationDigest",
    "rubricDigest",
    "schemaVersion",
    "selectionDigest",
    "selectedRank",
    "snapshotDigest",
    "snapshotId",
    "summaryInstructionDigest",
    "systemPromptDigest",
    "targetSelectionDigest",
    "toolSchemaDigest",
  ]);
  if (!Array.isArray(value.checkpoints)) schema("snapshot checkpoints must be an array");
  const checkpoints = value.checkpoints.map(validateSnapshotCheckpoint);
  if (
    checkpoints.length !== 5 ||
    checkpoints.some((checkpoint, index) => checkpoint.checkpointIndex !== index + 1)
  ) {
    schema("snapshot requires checkpoints 1..5 in order");
  }
  const snapshot: EvaluationSnapshot = Object.freeze({
    schemaVersion: requireSchemaVersion(value.schemaVersion),
    snapshotId: requireDigest(value.snapshotId, "snapshotId"),
    corpusId: requireDigest(value.corpusId, "corpusId"),
    selectedRank: requirePositiveRank(value.selectedRank),
    selectionDigest: requireDigest(value.selectionDigest, "selectionDigest"),
    qualificationDigest: requireDigest(value.qualificationDigest, "qualificationDigest"),
    candidateDigest: requireDigest(value.candidateDigest, "candidateDigest"),
    closureEntryId: requireDigest(value.closureEntryId, "closureEntryId"),
    checkpoints: Object.freeze(checkpoints) as EvaluationSnapshot["checkpoints"],
    targetSelectionDigest: requireDigest(value.targetSelectionDigest, "targetSelectionDigest"),
    systemPromptDigest: requireDigest(value.systemPromptDigest, "systemPromptDigest"),
    toolSchemaDigest: requireDigest(value.toolSchemaDigest, "toolSchemaDigest"),
    summaryInstructionDigest: requireDigest(
      value.summaryInstructionDigest,
      "summaryInstructionDigest",
    ),
    rubricDigest: requireDigest(value.rubricDigest, "rubricDigest"),
    objectiveChecksDigest: requireDigest(value.objectiveChecksDigest, "objectiveChecksDigest"),
    fixture: validateRepositoryFixture(value.fixture),
    goldLedgerDigest: requireDigest(value.goldLedgerDigest, "goldLedgerDigest"),
    snapshotDigest: requireDigest(value.snapshotDigest, "snapshotDigest"),
  });
  if (
    digestWithout(snapshot as unknown as Record<string, unknown>, "snapshotDigest") !==
    snapshot.snapshotDigest
  ) {
    integrity("snapshot digest mismatch");
  }
  const expectedId = canonicalDigest({
    domain: "context-pruning-primary-snapshot-v1",
    corpusId: snapshot.corpusId,
    selectedRank: snapshot.selectedRank,
  });
  if (snapshot.snapshotId !== expectedId) integrity("snapshot ID mismatch");
  return snapshot;
}

/** Summary generators receive no future checkpoints, gold, probes, or baseline outputs. */
export function buildSummaryGenerationAccess(
  snapshotValue: unknown,
  selectionValue: unknown,
): SummaryGenerationAccess {
  const snapshot = validateEvaluationSnapshot(snapshotValue);
  const selection = validateSelectedCandidateResult(selectionValue);
  const qualification = validateFinalQualification(selection.qualification);
  if (
    canonicalDigest(selection) !== snapshot.selectionDigest ||
    canonicalDigest(qualification) !== snapshot.qualificationDigest
  ) {
    integrity("summary qualification does not match snapshot");
  }
  const candidate = qualification.candidate!;
  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    candidateRange: Object.freeze({
      startEntryId: candidate.startEntryId,
      endEntryId: candidate.endEntryId,
    }),
    summaryInstructionDigest: snapshot.summaryInstructionDigest,
  });
}

export function verifyFrozenBundle(bundle: FrozenSnapshotBundle): void {
  const snapshot = validateEvaluationSnapshot(bundle.snapshot);
  const ledger = validateGoldLedger(bundle.goldLedger);
  if (
    ledger.snapshotId !== snapshot.snapshotId ||
    ledger.ledgerDigest !== snapshot.goldLedgerDigest
  ) {
    integrity("snapshot and gold ledger are not mutually bound");
  }
}

export function assertSnapshotImmutable(persisted: unknown, proposed: unknown): void {
  const left = validateEvaluationSnapshot(persisted);
  const right = validateEvaluationSnapshot(proposed);
  if (left.snapshotId === right.snapshotId && canonicalJson(left) !== canonicalJson(right)) {
    integrity("a primary snapshot cannot change under the same snapshotId");
  }
}

function queuePersistence(key: string, operation: () => Promise<void>): Promise<void> {
  const prior = persistenceQueues.get(key) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  persistenceQueues.set(key, current);
  return current.finally(() => {
    if (persistenceQueues.get(key) === current) persistenceQueues.delete(key);
  });
}

async function readExisting(
  safeRun: SafeRun,
  directory: string,
  fileName: string,
): Promise<unknown> {
  await ensurePrivateDir(safeRun, directory);
  const entries = await safeRunReaddir(safeRun, directory);
  if (!entries.some((entry) => entry.name === fileName && entry.isFile)) return undefined;
  const bytes = await safeRunReadFile(safeRun, `${directory}/${fileName}`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return integrity(`persisted ${directory} artifact is not JSON`);
  }
}

function validatePersistedBundle(value: unknown): FrozenSnapshotBundle {
  if (!isRecord(value)) integrity("persisted frozen bundle must be an object");
  const fields = Object.keys(value).sort();
  if (canonicalJson(fields) !== canonicalJson(["goldLedger", "snapshot"])) {
    integrity("persisted frozen bundle has unexpected fields");
  }
  const bundle = {
    snapshot: validateEvaluationSnapshot(value.snapshot),
    goldLedger: validateGoldLedger(value.goldLedger),
  };
  verifyFrozenBundle(bundle);
  return bundle;
}

/** Cross-process atomic publication; the bundle file is the freeze commit marker. */
async function publishFrozenBundle(
  safeRun: SafeRun,
  fileName: string,
  bundle: FrozenSnapshotBundle,
): Promise<FrozenSnapshotBundle> {
  const relativeFinal = `frozen/${fileName}`;
  const canonical = canonicalJson(bundle);
  await safeRunPublishExclusiveFile(safeRun, relativeFinal, canonical);
  const bytes = await safeRunReadFile(safeRun, relativeFinal);
  const text = bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return integrity("persisted frozen bundle is not JSON");
  }
  if (canonicalJson(parsed) !== text) integrity("persisted frozen bundle is not canonical JSON");
  const persisted = validatePersistedBundle(parsed);
  if (canonicalJson(persisted) !== canonical) {
    integrity("one primary snapshot already exists for this qualifying session");
  }
  return persisted;
}

/** Idempotently persist one immutable snapshot per corpus and its private gold ledger. */
export function persistFrozenSnapshot(
  safeRun: SafeRun,
  bundleValue: FrozenSnapshotBundle,
): Promise<void> {
  const normalized = Object.freeze(validatePersistedBundle(bundleValue));
  const { snapshot, goldLedger } = normalized;
  const fileName = `${snapshot.corpusId}.json`;
  const queueKey = safeRunPath(safeRun, `frozen/${fileName}`);
  return queuePersistence(queueKey, async () => {
    const committed = await publishFrozenBundle(safeRun, fileName, normalized);
    const existingSnapshot = await readExisting(safeRun, "snapshots", fileName);
    const existingGold = await readExisting(safeRun, "gold", fileName);
    if (
      existingSnapshot !== undefined &&
      canonicalJson(validateEvaluationSnapshot(existingSnapshot)) !==
        canonicalJson(committed.snapshot)
    ) {
      integrity("persisted snapshot view differs from the frozen bundle");
    }
    if (
      existingGold !== undefined &&
      canonicalJson(validateGoldLedger(existingGold)) !== canonicalJson(committed.goldLedger)
    ) {
      integrity("persisted gold view differs from the frozen bundle");
    }
    if (existingGold === undefined) {
      await safeRunWriteFile(safeRun, `gold/${fileName}`, canonicalJson(goldLedger));
    }
    if (existingSnapshot === undefined) {
      await safeRunWriteFile(safeRun, `snapshots/${fileName}`, canonicalJson(snapshot));
    }
  });
}

export function validateFreezeSnapshotInput(value: unknown): FreezeSnapshotInput {
  if (!isRecord(value)) schema("freeze input must be an object");
  requireExactFields(value, [
    "checkpoints",
    "fixture",
    "goldFacts",
    "objectiveChecksDigest",
    "rubricDigest",
    "selection",
    "summaryInstructionDigest",
    "systemPromptDigest",
    "targetSelectionDigest",
    "toolSchemaDigest",
  ]);
  if (!Array.isArray(value.checkpoints) || !Array.isArray(value.goldFacts)) {
    schema("checkpoints and goldFacts must be arrays");
  }
  return {
    selection: value.selection,
    checkpoints: value.checkpoints,
    targetSelectionDigest: requireDigest(value.targetSelectionDigest, "targetSelectionDigest"),
    systemPromptDigest: requireDigest(value.systemPromptDigest, "systemPromptDigest"),
    toolSchemaDigest: requireDigest(value.toolSchemaDigest, "toolSchemaDigest"),
    summaryInstructionDigest: requireDigest(
      value.summaryInstructionDigest,
      "summaryInstructionDigest",
    ),
    rubricDigest: requireDigest(value.rubricDigest, "rubricDigest"),
    objectiveChecksDigest: requireDigest(value.objectiveChecksDigest, "objectiveChecksDigest"),
    fixture: value.fixture,
    goldFacts: value.goldFacts,
  };
}
