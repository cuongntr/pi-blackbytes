/** Blinded, content-free annotation ingestion, adjudication, and candidate selection. */

import { canonicalDigest, canonicalJson } from "./canonical-json.js";
import { validateQualificationRecord } from "./qualification.js";
import { EvidenceStoreError, SCHEMA_VERSION } from "./types.js";
import type { QualificationRecord } from "./types.js";

export const ANNOTATION_CLOSURE_CODES = [
  "user-accepted",
  "goal-transition",
  "verification-passed",
] as const;
export const NO_CANDIDATE_REASON_CODES = [
  "ambiguous-closure",
  "assistant-only-closure",
  "no-completed-range",
] as const;

export type AnnotationClosureCode = (typeof ANNOTATION_CLOSURE_CODES)[number];
export type NoCandidateReasonCode = (typeof NO_CANDIDATE_REASON_CODES)[number];

export interface QualificationEnvelope {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly qualificationDigest: string;
  readonly qualification: QualificationRecord;
}

export interface AnnotationClaim {
  readonly candidateId: string;
  readonly closureEvidence: readonly AnnotationClosureCode[];
}

export interface BlindedAnnotationRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly annotationId: string;
  readonly catalogDigest: string;
  readonly corpusId: string;
  readonly selectedRank: number;
  readonly annotatorId: string;
  readonly annotatorKind: "owner" | "independent-human" | "consented-model";
  readonly decision: "candidates-identified" | "no-qualifying-candidate";
  readonly claims: readonly AnnotationClaim[];
  readonly reasonCodes: readonly NoCandidateReasonCode[];
}

export interface AdjudicationRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly adjudicationId: string;
  readonly corpusId: string;
  readonly selectedRank: number;
  readonly adjudicatorId: string;
  readonly annotationDigests: readonly [string, string];
  readonly status: "resolved" | "unresolved";
  readonly resolvedClaims: readonly AnnotationClaim[];
  readonly reasonCodes: readonly NoCandidateReasonCode[];
}

export interface CandidateSelectionResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly corpusId: string;
  readonly selectedRank: number;
  readonly status: "selected" | "blocked" | "none";
  readonly reasonCode:
    | "candidate-selected"
    | "annotation-disagreement-unresolved"
    | "no-agreed-eligible-candidate";
  readonly annotationDigests: readonly [string, string];
  readonly adjudicationDigest?: string;
  /** Final T-007A record, with annotation status/evidence merged for T-008. */
  readonly qualification?: QualificationRecord;
}

interface BoundCandidate {
  readonly candidateId: string;
  readonly envelope: QualificationEnvelope;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CLOSURE_SET = new Set<string>(ANNOTATION_CLOSURE_CODES);
const NO_CANDIDATE_REASON_SET = new Set<string>(NO_CANDIDATE_REASON_CODES);

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
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((field, index) => field !== sortedExpected[index])
  ) {
    schema(`Expected exactly fields: ${sortedExpected.join(", ")}`);
  }
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    schema(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireRank(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    schema("selectedRank must be positive");
  return value as number;
}

function requireSchemaVersion(value: unknown): typeof SCHEMA_VERSION {
  if (value !== SCHEMA_VERSION) schema(`schemaVersion must equal ${SCHEMA_VERSION}`);
  return SCHEMA_VERSION;
}

function validateClosureEvidence(value: unknown): readonly AnnotationClosureCode[] {
  if (!Array.isArray(value) || value.length === 0) schema("closureEvidence must be non-empty");
  const codes = value.map((code) => {
    if (typeof code !== "string" || !CLOSURE_SET.has(code)) schema("Unsupported closure evidence");
    return code as AnnotationClosureCode;
  });
  if (new Set(codes).size !== codes.length) schema("closureEvidence must not contain duplicates");
  return Object.freeze([...codes].sort());
}

function validateReasons(value: unknown): readonly NoCandidateReasonCode[] {
  if (!Array.isArray(value)) schema("reasonCodes must be an array");
  const reasons = value.map((reason) => {
    if (typeof reason !== "string" || !NO_CANDIDATE_REASON_SET.has(reason)) {
      schema("Unsupported no-candidate reason");
    }
    return reason as NoCandidateReasonCode;
  });
  if (new Set(reasons).size !== reasons.length) schema("reasonCodes must not contain duplicates");
  return Object.freeze([...reasons].sort());
}

function validateClaims(value: unknown): readonly AnnotationClaim[] {
  if (!Array.isArray(value)) schema("claims must be an array");
  const claims = value.map((claim) => {
    if (!isRecord(claim)) schema("claim must be an object");
    requireExactFields(claim, ["candidateId", "closureEvidence"]);
    return Object.freeze({
      candidateId: requireDigest(claim.candidateId, "candidateId"),
      closureEvidence: validateClosureEvidence(claim.closureEvidence),
    });
  });
  if (new Set(claims.map((claim) => claim.candidateId)).size !== claims.length) {
    schema("claims must reference unique candidates");
  }
  return Object.freeze(
    [...claims].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  );
}

function assertOpaqueQualificationReferences(record: QualificationRecord): void {
  requireDigest(record.corpusId, "qualification.corpusId");
  if (record.candidate === undefined) schema("qualifying record must contain a candidate");
  for (const [field, reference] of [
    ["branchLeafId", record.candidate.branchLeafId],
    ["startEntryId", record.candidate.startEntryId],
    ["endEntryId", record.candidate.endEntryId],
    ["closureEntryId", record.candidate.closureEntryId],
    ...record.candidate.subsequentRequestIds.map(
      (reference, index) => [`subsequentRequestIds[${index}]`, reference] as const,
    ),
  ] as const) {
    requireDigest(reference, `qualification.${field}`);
  }
}

export function candidateIdForQualification(recordValue: unknown): string {
  const record = validateQualificationRecord(recordValue);
  if (record.candidate === undefined) schema("qualification candidate is required");
  return canonicalDigest({
    qualificationDigest: canonicalDigest(record),
    corpusId: record.corpusId,
    selectedRank: record.selectedRank,
    branchLeafId: record.candidate.branchLeafId,
    startEntryId: record.candidate.startEntryId,
    endEntryId: record.candidate.endEntryId,
    closureEntryId: record.candidate.closureEntryId,
  });
}

export function validateQualificationEnvelope(value: unknown): QualificationEnvelope {
  if (!isRecord(value)) schema("qualification envelope must be an object");
  requireExactFields(value, ["qualification", "qualificationDigest", "schemaVersion"]);
  const qualification = validateQualificationRecord(value.qualification);
  const qualificationDigest = requireDigest(value.qualificationDigest, "qualificationDigest");
  if (canonicalDigest(qualification) !== qualificationDigest) {
    integrity("qualificationDigest does not match the canonical T-007A record");
  }
  if (
    !qualification.qualifies ||
    Object.values(qualification.criteria).some((criterion) => !criterion) ||
    qualification.reasonCodes.length !== 0 ||
    qualification.candidate === undefined ||
    qualification.candidate.estimatedTokens < 2_048 ||
    qualification.candidate.closureEvidence.length === 0 ||
    new Set(qualification.candidate.closureEvidence).size !==
      qualification.candidate.closureEvidence.length ||
    qualification.candidate.subsequentRequestIds.length !== 5 ||
    new Set(qualification.candidate.subsequentRequestIds).size !== 5 ||
    qualification.annotatorIds.length !== 0 ||
    qualification.adjudicationStatus !== "not-needed"
  ) {
    schema("catalog accepts only internally consistent, pre-annotation T-007A records");
  }
  assertOpaqueQualificationReferences(qualification);
  return Object.freeze({
    schemaVersion: requireSchemaVersion(value.schemaVersion),
    qualificationDigest,
    qualification,
  });
}

export function qualificationCatalogDigest(values: readonly unknown[]): string {
  const digests = values
    .map(validateQualificationEnvelope)
    .map((value) => value.qualificationDigest);
  if (new Set(digests).size !== digests.length) schema("qualification candidates must be unique");
  return canonicalDigest([...digests].sort());
}

export function validateBlindedAnnotationRecord(value: unknown): BlindedAnnotationRecord {
  if (!isRecord(value)) schema("annotation must be an object");
  requireExactFields(value, [
    "annotationId",
    "annotatorId",
    "catalogDigest",
    "annotatorKind",
    "claims",
    "corpusId",
    "decision",
    "reasonCodes",
    "schemaVersion",
    "selectedRank",
  ]);
  if (
    value.annotatorKind !== "owner" &&
    value.annotatorKind !== "independent-human" &&
    value.annotatorKind !== "consented-model"
  ) {
    schema("Unsupported annotatorKind");
  }
  if (value.decision !== "candidates-identified" && value.decision !== "no-qualifying-candidate") {
    schema("Unsupported annotation decision");
  }
  const claims = validateClaims(value.claims);
  const reasonCodes = validateReasons(value.reasonCodes);
  if (
    value.decision === "candidates-identified" &&
    (claims.length === 0 || reasonCodes.length !== 0)
  ) {
    schema("candidates-identified requires claims and no no-candidate reasons");
  }
  if (
    value.decision === "no-qualifying-candidate" &&
    (claims.length !== 0 || reasonCodes.length === 0)
  ) {
    schema("no-qualifying-candidate requires reasons and no claims");
  }
  return Object.freeze({
    schemaVersion: requireSchemaVersion(value.schemaVersion),
    annotationId: requireDigest(value.annotationId, "annotationId"),
    catalogDigest: requireDigest(value.catalogDigest, "catalogDigest"),
    corpusId: requireDigest(value.corpusId, "corpusId"),
    selectedRank: requireRank(value.selectedRank),
    annotatorId: requireDigest(value.annotatorId, "annotatorId"),
    annotatorKind: value.annotatorKind,
    decision: value.decision,
    claims,
    reasonCodes,
  });
}

export function validateAdjudicationRecord(value: unknown): AdjudicationRecord {
  if (!isRecord(value)) schema("adjudication must be an object");
  requireExactFields(value, [
    "adjudicationId",
    "adjudicatorId",
    "annotationDigests",
    "corpusId",
    "reasonCodes",
    "resolvedClaims",
    "schemaVersion",
    "selectedRank",
    "status",
  ]);
  if (value.status !== "resolved" && value.status !== "unresolved") {
    schema("Unsupported adjudication status");
  }
  if (!Array.isArray(value.annotationDigests) || value.annotationDigests.length !== 2) {
    schema("annotationDigests must contain exactly two digests");
  }
  const annotationDigests = value.annotationDigests.map((digest) =>
    requireDigest(digest, "annotationDigest"),
  );
  if (annotationDigests[0] === annotationDigests[1])
    schema("annotationDigests must be independent");
  const resolvedClaims = validateClaims(value.resolvedClaims);
  const reasonCodes = validateReasons(value.reasonCodes);
  if (value.status === "unresolved" && (resolvedClaims.length !== 0 || reasonCodes.length !== 0)) {
    schema("unresolved adjudication cannot contain a resolution");
  }
  if (value.status === "resolved" && (resolvedClaims.length === 0) === (reasonCodes.length === 0)) {
    schema("resolved adjudication requires exactly claims or no-candidate reasons");
  }
  return Object.freeze({
    schemaVersion: requireSchemaVersion(value.schemaVersion),
    adjudicationId: requireDigest(value.adjudicationId, "adjudicationId"),
    corpusId: requireDigest(value.corpusId, "corpusId"),
    selectedRank: requireRank(value.selectedRank),
    adjudicatorId: requireDigest(value.adjudicatorId, "adjudicatorId"),
    annotationDigests: Object.freeze([...annotationDigests].sort()) as readonly [string, string],
    status: value.status,
    resolvedClaims,
    reasonCodes,
  });
}

function claimsIdentity(annotation: BlindedAnnotationRecord): string {
  return canonicalJson({
    decision: annotation.decision,
    claims: annotation.claims,
    reasonCodes: annotation.reasonCodes,
  });
}

function selectionBase(
  corpusId: string,
  selectedRank: number,
  annotationDigests: readonly [string, string],
): Pick<
  CandidateSelectionResult,
  "schemaVersion" | "corpusId" | "selectedRank" | "annotationDigests"
> {
  return { schemaVersion: SCHEMA_VERSION, corpusId, selectedRank, annotationDigests };
}

function finalizedQualification(
  selected: BoundCandidate,
  claim: AnnotationClaim,
  annotatorIds: readonly string[],
  adjudicationStatus: "not-needed" | "resolved",
): QualificationRecord {
  const base = selected.envelope.qualification;
  if (base.candidate === undefined) integrity("selected qualification lost its candidate");
  return validateQualificationRecord({
    ...base,
    candidate: { ...base.candidate, closureEvidence: claim.closureEvidence },
    annotatorIds: [...annotatorIds].sort(),
    adjudicationStatus,
  });
}

/** Resolve two independent blinded annotations and apply earliest-close then earliest-start. */
export function selectAnnotatedCandidate(
  qualificationValues: readonly unknown[],
  annotationValues: readonly unknown[],
  adjudicationValue?: unknown,
): CandidateSelectionResult {
  const envelopes = qualificationValues.map(validateQualificationEnvelope);
  const annotations = annotationValues.map(validateBlindedAnnotationRecord);
  if (annotations.length !== 2) schema("exactly two independent annotations are required");
  const [first, second] = annotations as [BlindedAnnotationRecord, BlindedAnnotationRecord];
  if (first.annotationId === second.annotationId) schema("annotation IDs must be independent");
  if (first.annotatorId === second.annotatorId) schema("annotator IDs must be independent");
  const ownerCount = [first, second].filter((record) => record.annotatorKind === "owner").length;
  if (ownerCount !== 1) {
    schema("annotations require one owner and one independent human or consented model");
  }
  if (first.corpusId !== second.corpusId || first.selectedRank !== second.selectedRank) {
    integrity("annotations do not refer to the same sampled session");
  }
  const corpusId = first.corpusId;
  const selectedRank = first.selectedRank;
  const catalogDigest = qualificationCatalogDigest(envelopes);
  if (first.catalogDigest !== catalogDigest || second.catalogDigest !== catalogDigest) {
    integrity("annotations are not bound to the supplied qualification catalog");
  }
  const byCandidateId = new Map<string, BoundCandidate>();
  for (const envelope of envelopes) {
    const qualification = envelope.qualification;
    if (qualification.corpusId !== corpusId || qualification.selectedRank !== selectedRank) {
      integrity("qualification catalog crosses sampled sessions");
    }
    const candidateId = candidateIdForQualification(qualification);
    if (byCandidateId.has(candidateId)) schema("qualification candidates must be unique");
    byCandidateId.set(candidateId, { candidateId, envelope });
  }
  const validateSubmittedClaim = (claim: AnnotationClaim): void => {
    const bound = byCandidateId.get(claim.candidateId);
    if (bound === undefined) integrity("annotation references a non-eligible candidate");
    const structuralEvidence = bound.envelope.qualification.candidate?.closureEvidence ?? [];
    if (claim.closureEvidence.some((code) => !structuralEvidence.includes(code))) {
      integrity("annotation closure evidence is not supported by the T-007A record");
    }
  };
  for (const annotation of annotations) {
    for (const claim of annotation.claims) validateSubmittedClaim(claim);
  }
  const annotationDigests = Object.freeze(
    [canonicalDigest(first), canonicalDigest(second)].sort(),
  ) as readonly [string, string];
  const agrees = claimsIdentity(first) === claimsIdentity(second);
  let claims: readonly AnnotationClaim[];
  let adjudicationDigest: string | undefined;
  let adjudicationStatus: "not-needed" | "resolved" = "not-needed";
  if (agrees) {
    if (adjudicationValue !== undefined) schema("adjudication is forbidden when annotations agree");
    claims = first.claims;
  } else {
    if (adjudicationValue === undefined) {
      return Object.freeze({
        ...selectionBase(corpusId, selectedRank, annotationDigests),
        status: "blocked",
        reasonCode: "annotation-disagreement-unresolved",
      });
    }
    const adjudication = validateAdjudicationRecord(adjudicationValue);
    if (adjudication.corpusId !== corpusId || adjudication.selectedRank !== selectedRank) {
      integrity("adjudication refers to a different sampled session");
    }
    if (canonicalJson(adjudication.annotationDigests) !== canonicalJson(annotationDigests)) {
      integrity("adjudication does not bind the two annotation digests");
    }
    adjudicationDigest = canonicalDigest(adjudication);
    if (adjudication.status === "unresolved") {
      return Object.freeze({
        ...selectionBase(corpusId, selectedRank, annotationDigests),
        status: "blocked",
        reasonCode: "annotation-disagreement-unresolved",
        adjudicationDigest,
      });
    }
    adjudicationStatus = "resolved";
    claims = adjudication.resolvedClaims;
  }

  if (claims.length === 0) {
    return Object.freeze({
      ...selectionBase(corpusId, selectedRank, annotationDigests),
      status: "none",
      reasonCode: "no-agreed-eligible-candidate",
      ...(adjudicationDigest === undefined ? {} : { adjudicationDigest }),
    });
  }
  const eligible = claims.map((claim) => {
    validateSubmittedClaim(claim);
    return { bound: byCandidateId.get(claim.candidateId)!, claim };
  });
  eligible.sort((left, right) => {
    const leftCandidate = left.bound.envelope.qualification.candidate!;
    const rightCandidate = right.bound.envelope.qualification.candidate!;
    return (
      leftCandidate.closureOrder - rightCandidate.closureOrder ||
      leftCandidate.startOrder - rightCandidate.startOrder ||
      left.bound.candidateId.localeCompare(right.bound.candidateId)
    );
  });
  const selected = eligible[0];
  return Object.freeze({
    ...selectionBase(corpusId, selectedRank, annotationDigests),
    status: "selected",
    reasonCode: "candidate-selected",
    ...(adjudicationDigest === undefined ? {} : { adjudicationDigest }),
    qualification: finalizedQualification(
      selected.bound,
      selected.claim,
      [first.annotatorId, second.annotatorId],
      adjudicationStatus,
    ),
  });
}

/** Validate the complete selected T-007B handoff consumed by snapshot freezing. */
export function validateSelectedCandidateResult(value: unknown): CandidateSelectionResult & {
  readonly status: "selected";
  readonly qualification: QualificationRecord;
} {
  if (!isRecord(value)) schema("selected candidate result must be an object");
  const hasAdjudication = Object.hasOwn(value, "adjudicationDigest");
  requireExactFields(value, [
    ...(hasAdjudication ? ["adjudicationDigest"] : []),
    "annotationDigests",
    "corpusId",
    "qualification",
    "reasonCode",
    "schemaVersion",
    "selectedRank",
    "status",
  ]);
  if (value.status !== "selected" || value.reasonCode !== "candidate-selected") {
    schema("snapshot handoff requires selected candidate status");
  }
  if (!Array.isArray(value.annotationDigests) || value.annotationDigests.length !== 2) {
    schema("selected result requires two annotation digests");
  }
  const annotationDigests = value.annotationDigests.map((digest) =>
    requireDigest(digest, "annotationDigest"),
  );
  if (new Set(annotationDigests).size !== 2) schema("annotation digests must be independent");
  const qualification = validateQualificationRecord(value.qualification);
  const corpusId = requireDigest(value.corpusId, "corpusId");
  const selectedRank = requireRank(value.selectedRank);
  if (qualification.corpusId !== corpusId || qualification.selectedRank !== selectedRank) {
    integrity("selected qualification does not match result identity");
  }
  const adjudicationDigest = hasAdjudication
    ? requireDigest(value.adjudicationDigest, "adjudicationDigest")
    : undefined;
  if (
    (qualification.adjudicationStatus === "resolved") !== (adjudicationDigest !== undefined) ||
    qualification.adjudicationStatus === "unresolved"
  ) {
    integrity("selected qualification and adjudication digest are inconsistent");
  }
  return Object.freeze({
    schemaVersion: requireSchemaVersion(value.schemaVersion),
    corpusId,
    selectedRank,
    status: "selected",
    reasonCode: "candidate-selected",
    annotationDigests: Object.freeze([...annotationDigests].sort()) as readonly [string, string],
    ...(adjudicationDigest === undefined ? {} : { adjudicationDigest }),
    qualification,
  });
}

export function validateCandidateSelectionInput(value: unknown): {
  readonly candidates: readonly unknown[];
  readonly annotations: readonly unknown[];
  readonly adjudication?: unknown;
} {
  if (!isRecord(value)) schema("selection input must be an object");
  const hasAdjudication = Object.hasOwn(value, "adjudication");
  requireExactFields(value, [
    "annotations",
    "candidates",
    ...(hasAdjudication ? ["adjudication"] : []),
  ]);
  if (!Array.isArray(value.candidates) || !Array.isArray(value.annotations)) {
    schema("candidates and annotations must be arrays");
  }
  return {
    candidates: value.candidates,
    annotations: value.annotations,
    ...(hasAdjudication ? { adjudication: value.adjudication } : {}),
  };
}
