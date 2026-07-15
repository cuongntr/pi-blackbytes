/** Immutable evaluation snapshots, private gold ledgers, and fixture classifications. */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { validateSelectedCandidateResult } from "./annotations.js";
import { canonicalDigest, canonicalJson } from "./canonical-json.js";
import { CORPUS_KEY_FILENAME, corpusKeyBytes, corpusKeyDigest } from "./evidence-store.js";
import type { SafeRun } from "./path-safety.js";
import {
  ensurePrivateDir,
  getSafeRunCorpusKeyDigest,
  safeRunFileExists,
  safeRunPath,
  safeRunPublishExclusiveFile,
  safeRunReadFile,
} from "./path-safety.js";
import { validateQualificationRecord } from "./qualification.js";
import {
  deriveAuthenticatedCheckpointProjection,
  deriveSelectedSessionCatalogFromPersistedCopy,
} from "./session-validation.js";
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
  readonly catalogDigest: string;
  readonly copyReferenceDigest: string;
  readonly snapshotDigest: string;
}

/** Versioned digest binding exact summary instruction bytes. */
export function summaryInstructionDigest(content: string): string {
  return canonicalDigest({
    domain: "pi-blackbytes:context-pruning:summary-instruction:v1",
    content,
  });
}

export interface FrozenSummaryInstruction {
  readonly content: string;
  readonly digest: string;
}

export interface FrozenSnapshotBundle {
  readonly snapshot: EvaluationSnapshot;
  readonly goldLedger: GoldLedger;
  readonly summaryInstruction: FrozenSummaryInstruction;
}

/** A content-free, immutable commit marker; it never contains snapshot or gold content. */
export interface FrozenSnapshotManifest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly corpusId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly goldLedgerDigest: string;
  readonly catalogDigest: string;
  readonly summaryInstructionDigest: string;
  readonly authenticationTag: string;
  readonly manifestDigest: string;
}

/** Catalog bound to the selected session before gold source references are accepted. */
export interface SelectedSessionEntryCatalog {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly corpusId: string;
  readonly selectionDigest: string;
  /** Pseudonymous Pi-selected terminal leaf for this exact catalog branch. */
  readonly selectedLeafId: string;
  readonly entryIds: readonly string[];
  /** Stable digest-bound reference to the verified private selected branch copy. */
  readonly copyReferenceDigest: string;
  readonly catalogDigest: string;
  readonly authenticationTag: string;
}

/** Opaque role capability for a replay/summary consumer; it cannot expose gold. */
export interface ReplaySnapshotAccess {
  readonly __brand: "ReplaySnapshotAccess";
}

/** Opaque role capability required to read private gold. */
export interface PrivateGoldLedgerAccess {
  readonly __brand: "PrivateGoldLedgerAccess";
}

export interface FreezeSnapshotInput {
  readonly selection: unknown;
  readonly checkpoints: readonly unknown[];
  readonly targetSelectionDigest: string;
  readonly systemPromptDigest: string;
  readonly toolSchemaDigest: string;
  readonly summaryInstructionDigest: string;
  readonly summaryInstruction: string;
  readonly rubricDigest: string;
  readonly objectiveChecksDigest: string;
  readonly fixture: unknown;
  readonly goldFacts: readonly unknown[];
}

/** The summary role receives exactly frozen instruction content and candidate context. */
export interface SummaryGenerationAccess {
  readonly instruction: string;
  readonly candidateMessages: readonly Record<string, unknown>[];
}

export interface ReplayModelVisibleEntry {
  readonly entryId: string;
  readonly message: Record<string, unknown>;
}

export interface AuthenticatedReplaySource {
  readonly snapshot: EvaluationSnapshot;
  readonly selectedLeafId: string;
  readonly copyReferenceDigest: string;
  readonly entryIds: readonly string[];
  readonly candidateRange: {
    readonly startEntryId: string;
    readonly endEntryId: string;
    readonly messages: readonly ReplayModelVisibleEntry[];
  };
  readonly checkpoints: readonly {
    readonly checkpointIndex: 1 | 2 | 3 | 4 | 5;
    readonly requestEntryId: string;
    readonly beforeCandidate: readonly ReplayModelVisibleEntry[];
    readonly afterCandidate: readonly ReplayModelVisibleEntry[];
    readonly nativeContextDigest: string;
  }[];
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GOLD_CATEGORY_SET = new Set<string>(GOLD_FACT_CATEGORIES);
const persistenceQueues = new Map<string, Promise<void>>();
const CATALOG_AUTH_DOMAIN = "pi-blackbytes:context-pruning:selected-session-catalog:v1";
const MANIFEST_AUTH_DOMAIN = "pi-blackbytes:context-pruning:frozen-snapshot-manifest:v1";

/** Run-key HMAC is deliberately private to frozen/catalog persistence. */
async function authenticatePersistedArtifact(
  safeRun: SafeRun,
  domain: string,
  content: Uint8Array,
): Promise<string> {
  const key = (await safeRunReadFile(safeRun, CORPUS_KEY_FILENAME)).toString("utf8");
  const keyDigest = corpusKeyDigest(key);
  const expectedDigest = getSafeRunCorpusKeyDigest(safeRun);
  if (!timingSafeEqual(Buffer.from(keyDigest, "hex"), Buffer.from(expectedDigest, "hex"))) {
    integrity("run corpus key no longer matches its manifest");
  }
  return createHmac("sha256", corpusKeyBytes(key, "E_EVAL_INTEGRITY"))
    .update(Buffer.from(`${domain}\0`, "utf8"))
    .update(content)
    .digest("hex");
}

async function verifyPersistedArtifact(
  safeRun: SafeRun,
  domain: string,
  content: Uint8Array,
  expectedTag: string,
): Promise<void> {
  if (!DIGEST_PATTERN.test(expectedTag))
    integrity("persisted artifact authentication tag is invalid");
  const actualTag = await authenticatePersistedArtifact(safeRun, domain, content);
  if (!timingSafeEqual(Buffer.from(actualTag, "hex"), Buffer.from(expectedTag, "hex"))) {
    integrity("persisted artifact authentication tag mismatch");
  }
}
const replayAccessRegistry = new WeakMap<
  object,
  { readonly snapshot: EvaluationSnapshot; readonly safeRun: SafeRun; readonly corpusId: string }
>();
const privateGoldAccessRegistry = new WeakMap<
  object,
  { readonly safeRun: SafeRun; readonly corpusId: string }
>();

function schema(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}

function integrity(message: string): never {
  throw new EvidenceStoreError("E_EVAL_INTEGRITY", message);
}

function validatePersistedArtifact<T>(value: unknown, validate: (value: unknown) => T): T {
  try {
    return validate(value);
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) integrity("persisted artifact failed validation");
    throw error;
  }
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

function requireSummaryInstruction(
  value: unknown,
  expectedDigest: string,
): FrozenSummaryInstruction {
  if (typeof value !== "string" || value.trim().length === 0) {
    schema("summaryInstruction must be a non-empty string");
  }
  const digest = summaryInstructionDigest(value);
  if (digest !== expectedDigest)
    integrity("summary instruction content does not match its frozen digest");
  return Object.freeze({ content: value, digest });
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

function validateSelectedSessionEntryCatalog(value: unknown): SelectedSessionEntryCatalog {
  if (!isRecord(value)) integrity("selected-session entry catalog must be an object");
  requireExactFields(value, [
    "authenticationTag",
    "catalogDigest",
    "corpusId",
    "copyReferenceDigest",
    "entryIds",
    "schemaVersion",
    "selectedLeafId",
    "selectionDigest",
  ]);
  if (!Array.isArray(value.entryIds) || value.entryIds.length === 0) {
    schema("selected-session entry catalog requires entry IDs");
  }
  const catalog = {
    schemaVersion: requireSchemaVersion(value.schemaVersion),
    corpusId: requireDigest(value.corpusId, "catalog.corpusId"),
    selectionDigest: requireDigest(value.selectionDigest, "catalog.selectionDigest"),
    selectedLeafId: requireDigest(value.selectedLeafId, "catalog.selectedLeafId"),
    entryIds: Object.freeze(
      value.entryIds.map((entryId) => requireDigest(entryId, "catalog.entryId")),
    ),
    copyReferenceDigest: requireDigest(value.copyReferenceDigest, "catalog.copyReferenceDigest"),
  };
  if (
    new Set(catalog.entryIds).size !== catalog.entryIds.length ||
    !catalog.entryIds.includes(catalog.selectedLeafId)
  ) {
    schema("catalog entry IDs must be unique and include the selected leaf");
  }
  const catalogDigest = canonicalDigest(catalog);
  if (requireDigest(value.catalogDigest, "catalogDigest") !== catalogDigest) {
    integrity("selected-session entry catalog digest mismatch");
  }
  return Object.freeze({
    ...catalog,
    catalogDigest,
    authenticationTag: requireDigest(value.authenticationTag, "catalog.authenticationTag"),
  });
}

function assertCatalogBindsSelection(
  catalog: SelectedSessionEntryCatalog,
  selection: unknown,
  corpusId: string,
): void {
  if (catalog.corpusId !== corpusId || catalog.selectionDigest !== canonicalDigest(selection)) {
    integrity("selected-session entry catalog is not bound to the selected session");
  }
}

/** Bind every qualification reference to Pi's authenticated selected branch and order. */
function assertQualificationBindsCatalog(
  qualification: QualificationRecord,
  catalog: SelectedSessionEntryCatalog,
): void {
  const candidate = qualification.candidate!;
  if (candidate.branchLeafId !== catalog.selectedLeafId) {
    integrity("qualification candidate leaf is not the authenticated selected leaf");
  }
  const branchOrder = new Map(catalog.entryIds.map((entryId, index) => [entryId, index]));
  const start = branchOrder.get(candidate.startEntryId);
  const end = branchOrder.get(candidate.endEntryId);
  const closure = branchOrder.get(candidate.closureEntryId);
  const checkpoints = candidate.subsequentRequestIds.map((entryId) => branchOrder.get(entryId));
  if (
    start === undefined ||
    end === undefined ||
    closure === undefined ||
    checkpoints.some((index) => index === undefined) ||
    start !== candidate.startOrder ||
    end !== candidate.endOrder ||
    closure !== candidate.closureOrder ||
    start > end ||
    end >= closure ||
    checkpoints.some(
      (index, position) => index! <= (position === 0 ? closure : checkpoints[position - 1]!),
    )
  ) {
    integrity("qualification candidate does not preserve authenticated selected-branch order");
  }
}

async function loadAuthenticatedCatalog(
  safeRun: SafeRun,
  selection: unknown | undefined,
  corpusId: string,
): Promise<SelectedSessionEntryCatalog> {
  const catalog = validateSelectedSessionEntryCatalog(
    await readRequired(safeRun, "catalogs", `${corpusId}.json`),
  );
  const authenticated = canonicalJson({
    schemaVersion: catalog.schemaVersion,
    corpusId: catalog.corpusId,
    selectionDigest: catalog.selectionDigest,
    selectedLeafId: catalog.selectedLeafId,
    entryIds: catalog.entryIds,
    copyReferenceDigest: catalog.copyReferenceDigest,
    catalogDigest: catalog.catalogDigest,
  });
  await verifyPersistedArtifact(
    safeRun,
    CATALOG_AUTH_DOMAIN,
    Buffer.from(authenticated, "utf8"),
    catalog.authenticationTag,
  );
  if (selection === undefined) {
    if (catalog.corpusId !== corpusId)
      integrity("selected-session catalog belongs to another corpus");
  } else {
    assertCatalogBindsSelection(catalog, selection, corpusId);
  }
  return catalog;
}

/** Derive an authenticated selected-session catalog in memory from the guarded copy. */
async function deriveSelectedSessionEntryCatalog(
  safeRun: SafeRun,
  selection: ReturnType<typeof validateSelectedCandidateResult>,
): Promise<SelectedSessionEntryCatalog> {
  const qualification = validateFinalQualification(selection.qualification);
  const source = await deriveSelectedSessionCatalogFromPersistedCopy(
    safeRun,
    qualification.corpusId,
  );
  const base = {
    schemaVersion: SCHEMA_VERSION as typeof SCHEMA_VERSION,
    corpusId: qualification.corpusId,
    selectionDigest: canonicalDigest(selection),
    selectedLeafId: source.selectedLeafId,
    entryIds: Object.freeze([...source.entryIds]),
    copyReferenceDigest: source.copyReferenceDigest,
  };
  const catalogDigest = canonicalDigest(base);
  const unsigned = { ...base, catalogDigest };
  return Object.freeze({
    ...unsigned,
    authenticationTag: await authenticatePersistedArtifact(
      safeRun,
      CATALOG_AUTH_DOMAIN,
      Buffer.from(canonicalJson(unsigned), "utf8"),
    ),
  });
}

/** Publish only a catalog whose qualification and gold references were already validated. */
async function publishSelectedSessionEntryCatalog(
  safeRun: SafeRun,
  selection: ReturnType<typeof validateSelectedCandidateResult>,
  catalog: SelectedSessionEntryCatalog,
): Promise<SelectedSessionEntryCatalog> {
  const fileName = `${catalog.corpusId}.json`;
  const existing = await readExisting(safeRun, "catalogs", fileName);
  if (existing !== undefined) {
    const persisted = await loadAuthenticatedCatalog(safeRun, selection, catalog.corpusId);
    if (canonicalJson(persisted) !== canonicalJson(catalog)) {
      integrity("selected-session catalog cannot change under the same corpus");
    }
    return persisted;
  }
  await safeRunPublishExclusiveFile(safeRun, `catalogs/${fileName}`, canonicalJson(catalog));
  const persisted = await loadAuthenticatedCatalog(safeRun, selection, catalog.corpusId);
  if (canonicalJson(persisted) !== canonicalJson(catalog)) {
    integrity("selected-session catalog publication raced with a different catalog");
  }
  return persisted;
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

function buildGoldLedger(
  snapshotId: string,
  factValues: readonly unknown[],
  selectedSessionEntryIds?: ReadonlySet<string>,
): GoldLedger {
  const facts = factValues
    .map(validateGoldFact)
    .sort((left, right) => left.factId.localeCompare(right.factId));
  if (
    selectedSessionEntryIds !== undefined &&
    facts.some((fact) =>
      fact.sourceEntryIds.some((entryId) => !selectedSessionEntryIds.has(entryId)),
    )
  ) {
    integrity("gold source reference is not in the verified selected-session entry catalog");
  }
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

export function nativeContextDigest(value: {
  readonly checkpointIndex: number;
  readonly requestEntryId: string;
  readonly beforeCandidate: readonly ReplayModelVisibleEntry[];
  readonly candidateRange: readonly ReplayModelVisibleEntry[];
  readonly afterCandidate: readonly ReplayModelVisibleEntry[];
}): string {
  // Entry IDs are provenance metadata, not model-visible context.  Digest precisely
  // the canonical Pi-visible messages plus the frozen historical response identity.
  return canonicalDigest({
    domain: "pi-blackbytes:context-pruning:native-context:v3",
    checkpointIndex: value.checkpointIndex,
    requestEntryId: value.requestEntryId,
    beforeCandidate: value.beforeCandidate.map((entry) => entry.message),
    candidateRange: value.candidateRange.map((entry) => entry.message),
    afterCandidate: value.afterCandidate.map((entry) => entry.message),
  });
}

function contextEntry(message: Record<string, unknown>, position: number): ReplayModelVisibleEntry {
  return Object.freeze({
    entryId: canonicalDigest({
      domain: "pi-blackbytes:context-pruning:canonical-context-entry:v1",
      position,
      message,
    }),
    message,
  });
}

function sourceFromProjection(
  snapshot: EvaluationSnapshot,
  projection: import("./inventory.js").AuthenticatedCheckpointProjection,
  selectionValue: unknown,
): AuthenticatedReplaySource {
  const selection = validateSelectedCandidateResult(selectionValue);
  const qualification = validateFinalQualification(selection.qualification);
  const candidate = qualification.candidate!;
  if (
    canonicalDigest(selection) !== snapshot.selectionDigest ||
    canonicalDigest(qualification) !== snapshot.qualificationDigest ||
    candidate.branchLeafId !== projection.selectedLeafId ||
    projection.copyReferenceDigest !== snapshot.copyReferenceDigest
  ) {
    integrity("replay selection is not bound to the authenticated frozen snapshot");
  }
  const order = new Map(projection.entryIds.map((id, index) => [id, index]));
  const start = order.get(candidate.startEntryId);
  const end = order.get(candidate.endEntryId);
  const closure = order.get(candidate.closureEntryId);
  const requestOrders = candidate.subsequentRequestIds.map((id) => order.get(id));
  if (
    start === undefined ||
    end === undefined ||
    closure === undefined ||
    start !== candidate.startOrder ||
    end !== candidate.endOrder ||
    closure !== candidate.closureOrder ||
    start > end ||
    end >= closure ||
    requestOrders.some(
      (value, index) =>
        value === undefined || value <= (index === 0 ? closure : requestOrders[index - 1]!),
    )
  )
    integrity("authenticated selected branch does not preserve the qualified replay range");
  const candidateMessages = projection.candidateMessages;
  const candidateCanonical = candidateMessages.map((entry) => canonicalJson(entry.message));
  const checkpoints = candidate.subsequentRequestIds.map((requestEntryId, index) => {
    const checkpoint = projection.checkpoints[index];
    if (checkpoint === undefined || checkpoint.requestEntryId !== requestEntryId) {
      integrity("authenticated checkpoint identity does not match the frozen horizon");
    }
    const canonical = checkpoint.messages.map(canonicalJson);
    const starts = canonical.flatMap((_, startIndex) =>
      candidateCanonical.every((message, offset) => canonical[startIndex + offset] === message)
        ? [startIndex]
        : [],
    );
    // A compaction/summary or duplicate history without a single contiguous owner is unsafe.
    if (starts.length !== 1) {
      integrity("Pi checkpoint context cannot unambiguously map the candidate range");
    }
    const candidateStart = starts[0]!;
    const all = checkpoint.messages.map(contextEntry);
    const beforeCandidate = Object.freeze(all.slice(0, candidateStart));
    const canonicalCandidate = Object.freeze(
      all
        .slice(candidateStart, candidateStart + candidateMessages.length)
        .map((entry, offset) =>
          Object.freeze({ ...entry, entryId: candidateMessages[offset]!.entryId }),
        ),
    );
    const afterCandidate = Object.freeze(all.slice(candidateStart + candidateMessages.length));
    return Object.freeze({
      checkpointIndex: (index + 1) as 1 | 2 | 3 | 4 | 5,
      requestEntryId,
      beforeCandidate,
      afterCandidate,
      nativeContextDigest: nativeContextDigest({
        checkpointIndex: index + 1,
        requestEntryId,
        beforeCandidate,
        candidateRange: canonicalCandidate,
        afterCandidate,
      }),
    });
  });
  return Object.freeze({
    snapshot,
    selectedLeafId: projection.selectedLeafId,
    copyReferenceDigest: projection.copyReferenceDigest,
    entryIds: projection.entryIds,
    candidateRange: Object.freeze({
      startEntryId: candidate.startEntryId,
      endEntryId: candidate.endEntryId,
      messages: Object.freeze(candidateMessages),
    }),
    checkpoints: Object.freeze(checkpoints),
  });
}

/** Derive replay content exclusively from authenticated persisted branch material. */
export async function loadAuthenticatedReplaySource(
  replayAccess: ReplaySnapshotAccess,
  selection: unknown,
): Promise<AuthenticatedReplaySource> {
  const data = replayAccessRegistry.get(replayAccess);
  if (data === undefined) integrity("invalid replay snapshot capability");
  const bundle = await loadCommittedFrozenBundle(data.safeRun, data.corpusId);
  if (canonicalJson(bundle.snapshot) !== canonicalJson(data.snapshot))
    integrity("replay snapshot changed after access was issued");
  const catalog = await loadAuthenticatedCatalog(data.safeRun, selection, data.corpusId);
  const qualification = validateFinalQualification(
    validateSelectedCandidateResult(selection).qualification,
  );
  const projection = await deriveAuthenticatedCheckpointProjection(data.safeRun, data.corpusId, {
    startEntryId: qualification.candidate!.startEntryId,
    endEntryId: qualification.candidate!.endEntryId,
    checkpointEntryIds: qualification.candidate!.subsequentRequestIds,
  });
  if (
    catalog.selectedLeafId !== projection.selectedLeafId ||
    catalog.copyReferenceDigest !== projection.copyReferenceDigest ||
    canonicalJson(catalog.entryIds) !== canonicalJson(projection.entryIds)
  )
    integrity("authenticated replay projection does not match the selected catalog");
  const source = sourceFromProjection(bundle.snapshot, projection, selection);
  if (
    source.checkpoints.some(
      (checkpoint, index) =>
        checkpoint.requestEntryId !== bundle.snapshot.checkpoints[index]?.requestEntryId ||
        checkpoint.nativeContextDigest !== bundle.snapshot.checkpoints[index]?.nativeContextDigest,
    )
  ) {
    integrity("rederived checkpoint tuple does not equal the frozen snapshot");
  }
  return source;
}

function snapshotBase(
  input: FreezeSnapshotInput,
  qualification: QualificationRecord,
  selectionDigest: string,
  fixture: RepositoryFixture,
  catalogDigest: string,
  copyReferenceDigest: string,
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
    catalogDigest: requireDigest(catalogDigest, "catalogDigest"),
    copyReferenceDigest: requireDigest(copyReferenceDigest, "copyReferenceDigest"),
  };
}

/**
 * Freeze one primary snapshot and its separate private gold ledger.
 * The selected-session catalog is loaded only from the authenticated, guarded-copy
 * handoff artifact; caller input never supplies a catalog or its digest.
 */
export async function freezeSnapshot(
  safeRun: SafeRun,
  input: FreezeSnapshotInput,
): Promise<FrozenSnapshotBundle> {
  const selection = validateSelectedCandidateResult(input.selection);
  const qualification = validateFinalQualification(selection.qualification);
  const fixture = validateRepositoryFixture(input.fixture);
  const instruction = requireSummaryInstruction(
    input.summaryInstruction,
    requireDigest(input.summaryInstructionDigest, "summaryInstructionDigest"),
  );
  const catalog = await deriveSelectedSessionEntryCatalog(safeRun, selection);
  assertQualificationBindsCatalog(qualification, catalog);
  const base = snapshotBase(
    input,
    qualification,
    canonicalDigest(selection),
    fixture,
    catalog.catalogDigest,
    catalog.copyReferenceDigest,
  );
  // Freeze the native contexts from exactly the same Pi projection replay will use.
  // Caller-supplied checkpoint digests are assertions, never an authority.
  const projection = await deriveAuthenticatedCheckpointProjection(
    safeRun,
    qualification.corpusId,
    {
      startEntryId: qualification.candidate!.startEntryId,
      endEntryId: qualification.candidate!.endEntryId,
      checkpointEntryIds: qualification.candidate!.subsequentRequestIds,
    },
  );
  const derived = sourceFromProjection(base as EvaluationSnapshot, projection, selection);
  if (
    derived.checkpoints.some(
      (checkpoint, index) =>
        input.checkpoints[index] === undefined ||
        validateSnapshotCheckpoint(input.checkpoints[index]).nativeContextDigest !==
          checkpoint.nativeContextDigest,
    )
  ) {
    integrity("frozen native context digest does not match the authenticated selected branch");
  }
  const goldLedger = buildGoldLedger(base.snapshotId, input.goldFacts, new Set(catalog.entryIds));
  await publishSelectedSessionEntryCatalog(safeRun, selection, catalog);
  const snapshotWithoutDigest = { ...base, goldLedgerDigest: goldLedger.ledgerDigest };
  const snapshot = Object.freeze({
    ...snapshotWithoutDigest,
    snapshotDigest: canonicalDigest(snapshotWithoutDigest),
  });
  return Object.freeze({ snapshot, goldLedger, summaryInstruction: instruction });
}

export function validateEvaluationSnapshot(value: unknown): EvaluationSnapshot {
  if (!isRecord(value)) schema("snapshot must be an object");
  requireExactFields(value, [
    "candidateDigest",
    "catalogDigest",
    "copyReferenceDigest",
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
    catalogDigest: requireDigest(value.catalogDigest, "catalogDigest"),
    copyReferenceDigest: requireDigest(value.copyReferenceDigest, "copyReferenceDigest"),
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

/** Summary generators receive only frozen instruction and canonical candidate messages. */
export async function buildSummaryGenerationAccess(
  replayAccess: ReplaySnapshotAccess,
  selectionValue: unknown,
): Promise<SummaryGenerationAccess> {
  const source = await loadAuthenticatedReplaySource(replayAccess, selectionValue);
  const data = replayAccessRegistry.get(replayAccess);
  if (data === undefined) integrity("invalid replay snapshot capability");
  const bundle = await loadCommittedFrozenBundle(data.safeRun, data.corpusId);
  return Object.freeze({
    instruction: bundle.summaryInstruction.content,
    candidateMessages: Object.freeze(source.candidateRange.messages.map((entry) => entry.message)),
  });
}

export function verifyFrozenBundle(bundle: FrozenSnapshotBundle): void {
  const snapshot = validateEvaluationSnapshot(bundle.snapshot);
  const ledger = validateGoldLedger(bundle.goldLedger);
  const instruction = requireSummaryInstruction(
    bundle.summaryInstruction?.content,
    snapshot.summaryInstructionDigest,
  );
  if (
    instruction.digest !== bundle.summaryInstruction?.digest ||
    ledger.snapshotId !== snapshot.snapshotId ||
    ledger.ledgerDigest !== snapshot.goldLedgerDigest
  ) {
    integrity("snapshot, summary instruction, and gold ledger are not mutually bound");
  }
}

function frozenManifestBase(bundle: FrozenSnapshotBundle) {
  return {
    schemaVersion: SCHEMA_VERSION as typeof SCHEMA_VERSION,
    corpusId: bundle.snapshot.corpusId,
    snapshotId: bundle.snapshot.snapshotId,
    snapshotDigest: bundle.snapshot.snapshotDigest,
    goldLedgerDigest: bundle.goldLedger.ledgerDigest,
    catalogDigest: bundle.snapshot.catalogDigest,
    summaryInstructionDigest: bundle.summaryInstruction.digest,
  };
}

export function validateFrozenSnapshotManifest(value: unknown): FrozenSnapshotManifest {
  if (!isRecord(value)) integrity("frozen snapshot manifest must be an object");
  requireExactFields(value, [
    "authenticationTag",
    "catalogDigest",
    "corpusId",
    "goldLedgerDigest",
    "manifestDigest",
    "schemaVersion",
    "snapshotDigest",
    "snapshotId",
    "summaryInstructionDigest",
  ]);
  const base = {
    schemaVersion: requireSchemaVersion(value.schemaVersion),
    corpusId: requireDigest(value.corpusId, "manifest.corpusId"),
    snapshotId: requireDigest(value.snapshotId, "manifest.snapshotId"),
    snapshotDigest: requireDigest(value.snapshotDigest, "manifest.snapshotDigest"),
    goldLedgerDigest: requireDigest(value.goldLedgerDigest, "manifest.goldLedgerDigest"),
    catalogDigest: requireDigest(value.catalogDigest, "manifest.catalogDigest"),
    summaryInstructionDigest: requireDigest(
      value.summaryInstructionDigest,
      "manifest.summaryInstructionDigest",
    ),
  };
  if (requireDigest(value.manifestDigest, "manifestDigest") !== canonicalDigest(base)) {
    integrity("frozen snapshot manifest digest mismatch");
  }
  return Object.freeze({
    ...base,
    authenticationTag: requireDigest(value.authenticationTag, "manifest.authenticationTag"),
    manifestDigest: canonicalDigest(base),
  });
}

function assertManifestBindsBundle(
  manifest: FrozenSnapshotManifest,
  bundle: FrozenSnapshotBundle,
): void {
  const expected = frozenManifestBase(bundle);
  if (
    manifest.schemaVersion !== expected.schemaVersion ||
    manifest.corpusId !== expected.corpusId ||
    manifest.snapshotId !== expected.snapshotId ||
    manifest.snapshotDigest !== expected.snapshotDigest ||
    manifest.goldLedgerDigest !== expected.goldLedgerDigest ||
    manifest.catalogDigest !== expected.catalogDigest ||
    manifest.summaryInstructionDigest !== expected.summaryInstructionDigest
  ) {
    integrity("immutable frozen manifest does not bind the snapshot, catalog, and gold artifacts");
  }
}

/** Load an externally committed snapshot only after authenticating the complete bundle. */
export async function openReplaySnapshotAccess(
  safeRun: SafeRun,
  corpusId: string,
): Promise<ReplaySnapshotAccess> {
  const bundle = await loadCommittedFrozenBundle(safeRun, corpusId);
  const access = Object.freeze({ __brand: "ReplaySnapshotAccess" as const });
  replayAccessRegistry.set(access, Object.freeze({ snapshot: bundle.snapshot, safeRun, corpusId }));
  return access;
}

/** Return the only material a replay/summary role can obtain from its capability. */
export function readReplaySnapshot(access: ReplaySnapshotAccess): EvaluationSnapshot {
  const data = replayAccessRegistry.get(access);
  if (data === undefined) integrity("invalid replay snapshot capability");
  return data.snapshot;
}

/** Issue a private evaluator capability; forged/replay capabilities are denied by the loader. */
export function createPrivateGoldLedgerAccess(
  safeRun: SafeRun,
  corpusId: string,
): PrivateGoldLedgerAccess {
  requireDigest(corpusId, "corpusId");
  const access = Object.freeze({ __brand: "PrivateGoldLedgerAccess" as const });
  privateGoldAccessRegistry.set(access, { safeRun, corpusId });
  return access;
}

/** Load private gold only for the explicit evaluator capability and a complete committed bundle. */
export async function loadPrivateGoldLedger(access: PrivateGoldLedgerAccess): Promise<GoldLedger> {
  const data = privateGoldAccessRegistry.get(access);
  if (data === undefined) integrity("private gold access denied");
  return (await loadCommittedFrozenBundle(data.safeRun, data.corpusId)).goldLedger;
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
): Promise<unknown | undefined> {
  const relativePath = `${directory}/${fileName}`;
  if (!(await safeRunFileExists(safeRun, relativePath))) return undefined;
  const bytes = await safeRunReadFile(safeRun, relativePath);
  const text = bytes.toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (canonicalJson(parsed) !== text)
      integrity(`persisted ${directory} artifact is not canonical JSON`);
    return parsed;
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) throw error;
    return integrity(`persisted ${directory} artifact is not JSON`);
  }
}

async function readRequired(
  safeRun: SafeRun,
  directory: string,
  fileName: string,
): Promise<unknown> {
  const artifact = await readExisting(safeRun, directory, fileName);
  if (artifact === undefined) integrity(`committed ${directory} artifact is missing`);
  return artifact;
}

function validatePersistedBundle(value: unknown): FrozenSnapshotBundle {
  if (!isRecord(value)) integrity("persisted frozen bundle must be an object");
  const fields = Object.keys(value).sort();
  if (canonicalJson(fields) !== canonicalJson(["goldLedger", "snapshot", "summaryInstruction"])) {
    integrity("persisted frozen bundle has unexpected fields");
  }
  const snapshot = validateEvaluationSnapshot(value.snapshot);
  const bundle = {
    snapshot,
    goldLedger: validateGoldLedger(value.goldLedger),
    summaryInstruction: requireSummaryInstruction(
      isRecord(value.summaryInstruction) ? value.summaryInstruction.content : undefined,
      snapshot.summaryInstructionDigest,
    ),
  };
  if (
    !isRecord(value.summaryInstruction) ||
    value.summaryInstruction.digest !== bundle.summaryInstruction.digest
  ) {
    integrity("persisted summary instruction digest mismatch");
  }
  verifyFrozenBundle(bundle);
  return Object.freeze(bundle);
}

function fixtureArtifactPaths(fixture: RepositoryFixture): readonly string[] {
  if (fixture.status === "exact") return [`fixtures/${fixture.artifactId}/archive`];
  if (fixture.status === "reconstructed") {
    return [
      `fixtures/${fixture.artifactId}/patch`,
      `fixtures/${fixture.artifactId}/reconstruction-log`,
    ];
  }
  return [];
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Verify that executable fixture material is private, rooted, and digest-bound before commitment. */
export type VerifiedRepositoryFixtureMaterial =
  | {
      readonly fixture: Extract<RepositoryFixture, { readonly status: "exact" }>;
      readonly archive: Buffer;
    }
  | {
      readonly fixture: Extract<RepositoryFixture, { readonly status: "reconstructed" }>;
      readonly patch: Buffer;
      readonly reconstructionLog: Buffer;
    }
  | { readonly fixture: Extract<RepositoryFixture, { readonly status: "unavailable" }> };

/**
 * Read fixture bytes only after their frozen T-008 digests have been reverified.
 * Consumers must materialize these bytes into a private disposable tree; this API
 * intentionally exposes neither an original repository path nor a live worktree.
 */
export async function loadVerifiedRepositoryFixtureMaterial(
  safeRun: SafeRun,
  fixtureValue: unknown,
): Promise<VerifiedRepositoryFixtureMaterial> {
  const fixture = validateRepositoryFixture(fixtureValue);
  if (fixture.status === "unavailable") return Object.freeze({ fixture });
  const paths = fixtureArtifactPaths(fixture);
  const expected =
    fixture.status === "exact"
      ? [fixture.archiveDigest]
      : [fixture.patchDigest, fixture.reconstructionLogDigest];
  const bytes = await Promise.all(paths.map((path) => safeRunReadFile(safeRun, path)));
  if (bytes.some((item, index) => sha256Bytes(item) !== expected[index])) {
    integrity("private fixture artifact content digest mismatch");
  }
  return fixture.status === "exact"
    ? Object.freeze({ fixture, archive: bytes[0]! })
    : Object.freeze({ fixture, patch: bytes[0]!, reconstructionLog: bytes[1]! });
}

async function verifyFixtureArtifacts(safeRun: SafeRun, fixture: RepositoryFixture): Promise<void> {
  await loadVerifiedRepositoryFixtureMaterial(safeRun, fixture);
}

async function publishCanonicalArtifact(
  safeRun: SafeRun,
  directory: "snapshots" | "gold" | "summaries",
  fileName: string,
  value: unknown,
  validate: (value: unknown) => unknown,
): Promise<void> {
  const relativePath = `${directory}/${fileName}`;
  const canonical = canonicalJson(value);
  await safeRunPublishExclusiveFile(safeRun, relativePath, canonical);
  const bytes = await safeRunReadFile(safeRun, relativePath);
  const text = bytes.toString("utf8");
  let persisted: unknown;
  try {
    persisted = JSON.parse(text);
  } catch {
    integrity(`persisted ${directory} artifact is not JSON`);
  }
  if (canonicalJson(persisted) !== text || canonicalJson(validate(persisted)) !== canonical) {
    integrity(`persisted ${directory} artifact differs from the immutable bundle`);
  }
}

/** Cross-process atomic publication of the content-free immutable external commit marker. */
async function publishFrozenManifest(
  safeRun: SafeRun,
  fileName: string,
  bundle: FrozenSnapshotBundle,
): Promise<FrozenSnapshotManifest> {
  const base = frozenManifestBase(bundle);
  const unsigned = { ...base, manifestDigest: canonicalDigest(base) };
  const manifest = {
    ...unsigned,
    authenticationTag: await authenticatePersistedArtifact(
      safeRun,
      MANIFEST_AUTH_DOMAIN,
      Buffer.from(canonicalJson(unsigned), "utf8"),
    ),
  };
  await safeRunPublishExclusiveFile(safeRun, `frozen/${fileName}`, canonicalJson(manifest));
  const persisted = validateFrozenSnapshotManifest(await readRequired(safeRun, "frozen", fileName));
  await verifyPersistedArtifact(
    safeRun,
    MANIFEST_AUTH_DOMAIN,
    Buffer.from(canonicalJson(unsigned), "utf8"),
    persisted.authenticationTag,
  );
  assertManifestBindsBundle(persisted, bundle);
  return persisted;
}

function assertGoldReferencesCatalog(
  ledger: GoldLedger,
  catalog: SelectedSessionEntryCatalog,
): void {
  const entries = new Set(catalog.entryIds);
  if (ledger.facts.some((fact) => fact.sourceEntryIds.some((entryId) => !entries.has(entryId)))) {
    integrity("gold source reference is not in the authenticated selected-session catalog");
  }
}

/** Authenticate and validate every committed artifact before either role receives a projection. */
async function loadCommittedFrozenBundle(
  safeRun: SafeRun,
  corpusId: string,
): Promise<FrozenSnapshotBundle> {
  requireDigest(corpusId, "corpusId");
  const fileName = `${corpusId}.json`;
  const manifest = validatePersistedArtifact(
    await readRequired(safeRun, "frozen", fileName),
    validateFrozenSnapshotManifest,
  );
  const manifestUnsigned = {
    schemaVersion: manifest.schemaVersion,
    corpusId: manifest.corpusId,
    snapshotId: manifest.snapshotId,
    snapshotDigest: manifest.snapshotDigest,
    goldLedgerDigest: manifest.goldLedgerDigest,
    catalogDigest: manifest.catalogDigest,
    summaryInstructionDigest: manifest.summaryInstructionDigest,
    manifestDigest: manifest.manifestDigest,
  };
  await verifyPersistedArtifact(
    safeRun,
    MANIFEST_AUTH_DOMAIN,
    Buffer.from(canonicalJson(manifestUnsigned), "utf8"),
    manifest.authenticationTag,
  );
  const snapshot = validatePersistedArtifact(
    await readRequired(safeRun, "snapshots", fileName),
    validateEvaluationSnapshot,
  );
  const ledger = validatePersistedArtifact(
    await readRequired(safeRun, "gold", fileName),
    validateGoldLedger,
  );
  const summaryInstruction = validatePersistedArtifact(
    await readRequired(safeRun, "summaries", fileName),
    (value) => {
      if (!isRecord(value)) schema("persisted summary instruction must be an object");
      requireExactFields(value, ["content", "digest"]);
      const instruction = requireSummaryInstruction(
        value.content,
        snapshot.summaryInstructionDigest,
      );
      if (value.digest !== instruction.digest)
        integrity("persisted summary instruction digest mismatch");
      return instruction;
    },
  );
  const catalog = validatePersistedArtifact(
    await readRequired(safeRun, "catalogs", fileName),
    validateSelectedSessionEntryCatalog,
  );
  const catalogUnsigned = {
    schemaVersion: catalog.schemaVersion,
    corpusId: catalog.corpusId,
    selectionDigest: catalog.selectionDigest,
    selectedLeafId: catalog.selectedLeafId,
    entryIds: catalog.entryIds,
    copyReferenceDigest: catalog.copyReferenceDigest,
    catalogDigest: catalog.catalogDigest,
  };
  await verifyPersistedArtifact(
    safeRun,
    CATALOG_AUTH_DOMAIN,
    Buffer.from(canonicalJson(catalogUnsigned), "utf8"),
    catalog.authenticationTag,
  );
  const guardedCopy = await deriveSelectedSessionCatalogFromPersistedCopy(safeRun, corpusId);
  if (
    guardedCopy.copyReferenceDigest !== catalog.copyReferenceDigest ||
    guardedCopy.selectedLeafId !== catalog.selectedLeafId ||
    canonicalJson(guardedCopy.entryIds) !== canonicalJson(catalog.entryIds)
  ) {
    integrity("authenticated catalog no longer matches its guarded private copy");
  }
  if (
    manifest.corpusId !== corpusId ||
    snapshot.corpusId !== corpusId ||
    catalog.corpusId !== corpusId ||
    manifest.snapshotId !== snapshot.snapshotId ||
    manifest.snapshotDigest !== snapshot.snapshotDigest ||
    manifest.goldLedgerDigest !== ledger.ledgerDigest ||
    manifest.catalogDigest !== catalog.catalogDigest ||
    manifest.summaryInstructionDigest !== summaryInstruction.digest ||
    snapshot.summaryInstructionDigest !== summaryInstruction.digest ||
    snapshot.catalogDigest !== catalog.catalogDigest ||
    snapshot.copyReferenceDigest !== catalog.copyReferenceDigest ||
    snapshot.selectionDigest !== catalog.selectionDigest
  ) {
    integrity("committed frozen bundle artifacts are not mutually bound");
  }
  const bundle = { snapshot, goldLedger: ledger, summaryInstruction };
  verifyFrozenBundle(bundle);
  assertGoldReferencesCatalog(ledger, catalog);
  await verifyFixtureArtifacts(safeRun, snapshot.fixture);
  return Object.freeze(bundle);
}

/** Idempotently persist one immutable snapshot per corpus and its private gold ledger. */
export function persistFrozenSnapshot(
  safeRun: SafeRun,
  bundleValue: FrozenSnapshotBundle,
): Promise<void> {
  const normalized = Object.freeze(validatePersistedBundle(bundleValue));
  const { snapshot, goldLedger, summaryInstruction } = normalized;
  const fileName = `${snapshot.corpusId}.json`;
  const queueKey = safeRunPath(safeRun, `frozen/${fileName}`);
  return queuePersistence(queueKey, async () => {
    // Preflight is intentionally write-free: an extant marker must name a complete,
    // authenticated, fixture-valid bundle that exactly equals this proposal.
    const marker = await readExisting(safeRun, "frozen", fileName);
    if (marker !== undefined) {
      const committed = await loadCommittedFrozenBundle(safeRun, snapshot.corpusId);
      if (canonicalJson(committed) !== canonicalJson(normalized)) {
        integrity("existing frozen bundle does not match the proposed bundle");
      }
      return;
    }
    const [partialSnapshot, partialGold, partialSummary] = await Promise.all([
      readExisting(safeRun, "snapshots", fileName),
      readExisting(safeRun, "gold", fileName),
      readExisting(safeRun, "summaries", fileName),
    ]);
    if (
      (partialSnapshot !== undefined &&
        canonicalJson(validatePersistedArtifact(partialSnapshot, validateEvaluationSnapshot)) !==
          canonicalJson(snapshot)) ||
      (partialGold !== undefined &&
        canonicalJson(validatePersistedArtifact(partialGold, validateGoldLedger)) !==
          canonicalJson(goldLedger)) ||
      (partialSummary !== undefined &&
        canonicalJson(partialSummary) !== canonicalJson(summaryInstruction))
    ) {
      integrity("uncommitted partial artifact does not match the proposed bundle");
    }
    // The catalog must already be an authenticated upstream handoff, and fixture
    // bytes must be valid before any snapshot/gold write can occur.
    const catalog = await loadAuthenticatedCatalog(safeRun, undefined, snapshot.corpusId).catch(
      () => undefined,
    );
    if (catalog === undefined || catalog.catalogDigest !== snapshot.catalogDigest) {
      integrity("proposed snapshot has no matching authenticated selected-session catalog");
    }
    assertGoldReferencesCatalog(goldLedger, catalog);
    await verifyFixtureArtifacts(safeRun, snapshot.fixture);
    await publishCanonicalArtifact(
      safeRun,
      "snapshots",
      fileName,
      snapshot,
      validateEvaluationSnapshot,
    );
    await publishCanonicalArtifact(safeRun, "gold", fileName, goldLedger, validateGoldLedger);
    await publishCanonicalArtifact(safeRun, "summaries", fileName, summaryInstruction, (value) => {
      if (!isRecord(value)) schema("persisted summary instruction must be an object");
      requireExactFields(value, ["content", "digest"]);
      const instruction = requireSummaryInstruction(
        value.content,
        snapshot.summaryInstructionDigest,
      );
      if (value.digest !== instruction.digest)
        integrity("persisted summary instruction digest mismatch");
      return instruction;
    });
    await publishFrozenManifest(safeRun, fileName, normalized);
    const committed = await loadCommittedFrozenBundle(safeRun, snapshot.corpusId);
    if (canonicalJson(committed) !== canonicalJson(normalized)) {
      integrity("published frozen bundle differs from the proposal");
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
    "summaryInstruction",
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
    summaryInstruction: (() => {
      if (
        typeof value.summaryInstruction !== "string" ||
        value.summaryInstruction.trim().length === 0
      ) {
        schema("summaryInstruction must be a non-empty string");
      }
      return value.summaryInstruction;
    })(),
    rubricDigest: requireDigest(value.rubricDigest, "rubricDigest"),
    objectiveChecksDigest: requireDigest(value.objectiveChecksDigest, "objectiveChecksDigest"),
    fixture: value.fixture,
    goldFacts: value.goldFacts,
  };
}
