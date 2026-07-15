/**
 * Conservative, evaluation-only provenance claims for copied lifecycle fixtures.
 *
 * A one-for-one identical replacement is unobservable after Pi deep-clones the
 * context and therefore cannot be a passing synthetic scenario. Retaining the
 * original beside a copy makes the bucket ambiguous and deliberately unowned.
 * Every externally visible identifier is an opaque SHA-256 pseudonym.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { canonicalJson } from "../canonical-json.js";
import { COMPLETE_RANGE_PROVENANCE_POLICY } from "../protocol.js";
import { EvidenceStoreError } from "../types.js";

export const UNIQUE_STRUCTURAL_EXACT_METHOD = "unique-structural-exact-v1" as const;

export type ContextMessage = ContextEvent["messages"][number];

export interface SourceProjection {
  readonly sourceEntryId: string;
  readonly message: ContextMessage;
}

export interface CandidateRange {
  readonly candidateId: string;
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly estimatedTokens: number;
}

export interface GroundTruthBoundary {
  readonly startContextIndex: number;
  readonly endContextIndex: number;
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly requiredSourceEntryIds: readonly string[];
}

export interface GroundTruthRange extends GroundTruthBoundary {
  readonly candidateId: string;
}

/** Content-free oracle prepared before the synthetic context transformation. */
export interface ProvenanceGroundTruth {
  readonly contextOwners: readonly (string | null)[];
  readonly completeTurns: readonly GroundTruthBoundary[];
  readonly ranges: readonly GroundTruthRange[];
}

export interface OwnershipClaim {
  readonly contextIndex: number;
  readonly sourceEntryId: string;
  readonly method: typeof UNIQUE_STRUCTURAL_EXACT_METHOD;
}

export interface CompleteTurnClaim {
  readonly start: OwnershipClaim;
  readonly end: OwnershipClaim;
}

export interface CompleteRangeClaim {
  readonly candidateId: string;
  readonly start: OwnershipClaim;
  readonly end: OwnershipClaim;
}

/** The only content-free evidence record emitted by this module. */
export interface ProvenanceEvidence {
  readonly ownershipClaims: readonly OwnershipClaim[];
  readonly completeTurnClaims: readonly CompleteTurnClaim[];
  readonly completeRangeClaims: readonly CompleteRangeClaim[];
}

export interface CoverageCount {
  readonly expected: number;
  readonly correct: number;
  readonly coverage: number;
}

export interface ProvenanceComparison {
  readonly pass: boolean;
  readonly ownershipFalsePositives: number;
  readonly boundaryFalsePositives: number;
  readonly qualifyingCandidateCount: number;
  readonly fullyCoveredQualifyingCandidateCount: number;
  readonly messageCoverage: CoverageCount;
  readonly turnCoverage: CoverageCount;
}

export interface ProvenanceEvaluation {
  readonly evidence: ProvenanceEvidence;
  readonly comparison: ProvenanceComparison;
}

const SCHEMA_MESSAGE = "Invalid provenance evaluation schema";
const INTEGRITY_MESSAGE = "Invalid provenance evaluation integrity";
const PSEUDONYM = /^[a-f0-9]{64}$/;
const SAFE_CANDIDATE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const OWNERSHIP_FIELDS = ["contextIndex", "method", "sourceEntryId"] as const;
const TURN_FIELDS = ["end", "start"] as const;
const RANGE_FIELDS = ["candidateId", "end", "start"] as const;
const BOUNDARY_FIELDS = [
  "endContextIndex",
  "endEntryId",
  "requiredSourceEntryIds",
  "startContextIndex",
  "startEntryId",
] as const;

function schemaError(): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", SCHEMA_MESSAGE);
}

function integrityError(): never {
  throw new EvidenceStoreError("E_EVAL_INTEGRITY", INTEGRITY_MESSAGE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  );
}

function requirePseudonym(value: unknown): string {
  if (typeof value !== "string" || !PSEUDONYM.test(value)) schemaError();
  return value;
}

function requireCandidateId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_CANDIDATE.test(value)) schemaError();
  return value;
}

function requireIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) schemaError();
  return value as number;
}

function requireJson(value: unknown): void {
  try {
    canonicalJson(value);
  } catch {
    schemaError();
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function validateSourceProjections(value: unknown): readonly SourceProjection[] {
  if (!Array.isArray(value)) schemaError();
  const ids = new Set<string>();
  return value.map((projection) => {
    if (!isRecord(projection) || !hasExactFields(projection, ["message", "sourceEntryId"]))
      schemaError();
    const sourceEntryId = requirePseudonym(projection.sourceEntryId);
    if (ids.has(sourceEntryId)) integrityError();
    ids.add(sourceEntryId);
    if (!isRecord(projection.message)) schemaError();
    requireJson(projection.message);
    return { sourceEntryId, message: projection.message as unknown as ContextMessage };
  });
}

function validateMessages(value: unknown): readonly ContextMessage[] {
  if (!Array.isArray(value)) schemaError();
  return value.map((message) => {
    if (!isRecord(message)) schemaError();
    requireJson(message);
    return message as unknown as ContextMessage;
  });
}

function validateCandidates(
  value: unknown,
  sourceIds: ReadonlySet<string>,
): readonly CandidateRange[] {
  if (!Array.isArray(value)) schemaError();
  const ids = new Set<string>();
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactFields(candidate, ["candidateId", "endEntryId", "estimatedTokens", "startEntryId"])
    ) {
      schemaError();
    }
    const candidateId = requireCandidateId(candidate.candidateId);
    const startEntryId = requirePseudonym(candidate.startEntryId);
    const endEntryId = requirePseudonym(candidate.endEntryId);
    if (
      ids.has(candidateId) ||
      !sourceIds.has(startEntryId) ||
      !sourceIds.has(endEntryId) ||
      typeof candidate.estimatedTokens !== "number" ||
      !Number.isSafeInteger(candidate.estimatedTokens) ||
      candidate.estimatedTokens < 0
    ) {
      integrityError();
    }
    ids.add(candidateId);
    return { candidateId, startEntryId, endEntryId, estimatedTokens: candidate.estimatedTokens };
  });
}

function validateBoundary(value: unknown): GroundTruthBoundary {
  if (!isRecord(value) || !hasExactFields(value, BOUNDARY_FIELDS)) schemaError();
  if (!Array.isArray(value.requiredSourceEntryIds)) schemaError();
  const requiredSourceEntryIds = value.requiredSourceEntryIds.map(requirePseudonym);
  if (requiredSourceEntryIds.length === 0) integrityError();
  return {
    startContextIndex: requireIndex(value.startContextIndex),
    endContextIndex: requireIndex(value.endContextIndex),
    startEntryId: requirePseudonym(value.startEntryId),
    endEntryId: requirePseudonym(value.endEntryId),
    requiredSourceEntryIds,
  };
}

function boundaryKey(boundary: GroundTruthBoundary): string {
  return `${boundary.startContextIndex}\u0000${boundary.startEntryId}\u0000${boundary.endContextIndex}\u0000${boundary.endEntryId}`;
}

function validateGroundTruth(
  value: unknown,
  sourceEntryIds: readonly string[],
  candidates: readonly CandidateRange[],
  observedLength: number,
): ProvenanceGroundTruth {
  if (!isRecord(value) || !hasExactFields(value, ["completeTurns", "contextOwners", "ranges"]))
    schemaError();
  if (
    !Array.isArray(value.contextOwners) ||
    !Array.isArray(value.completeTurns) ||
    !Array.isArray(value.ranges)
  )
    schemaError();
  if (value.contextOwners.length !== observedLength) integrityError();
  const sourceIds = new Set(sourceEntryIds);
  const sourceIndexById = new Map(sourceEntryIds.map((id, index) => [id, index]));
  const seenOwners = new Set<string>();
  const contextOwners = value.contextOwners.map((owner) => {
    if (owner === null) return null;
    const id = requirePseudonym(owner);
    if (!sourceIds.has(id)) integrityError();
    if (seenOwners.has(id)) integrityError();
    seenOwners.add(id);
    return id;
  });
  const validateReferencedBoundary = (boundary: GroundTruthBoundary): GroundTruthBoundary => {
    if (
      boundary.startContextIndex >= contextOwners.length ||
      boundary.endContextIndex >= contextOwners.length ||
      contextOwners[boundary.startContextIndex] !== boundary.startEntryId ||
      contextOwners[boundary.endContextIndex] !== boundary.endEntryId ||
      boundary.requiredSourceEntryIds.length === 0 ||
      new Set(boundary.requiredSourceEntryIds).size !== boundary.requiredSourceEntryIds.length ||
      boundary.requiredSourceEntryIds[0] !== boundary.startEntryId ||
      boundary.requiredSourceEntryIds.at(-1) !== boundary.endEntryId
    ) {
      integrityError();
    }
    const firstSourceIndex = sourceIndexById.get(boundary.startEntryId);
    if (
      firstSourceIndex === undefined ||
      boundary.requiredSourceEntryIds.some(
        (id, offset) => sourceIndexById.get(id) !== firstSourceIndex + offset,
      )
    ) {
      integrityError();
    }
    return boundary;
  };
  const turnKeys = new Set<string>();
  const completeTurns = value.completeTurns.map((turn) => {
    const boundary = validateReferencedBoundary(validateBoundary(turn));
    const key = boundaryKey(boundary);
    if (turnKeys.has(key)) integrityError();
    turnKeys.add(key);
    return boundary;
  });
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const rangeIds = new Set<string>();
  const ranges = value.ranges.map((range) => {
    if (!isRecord(range) || !hasExactFields(range, ["candidateId", ...BOUNDARY_FIELDS]))
      schemaError();
    const candidateId = requireCandidateId(range.candidateId);
    if (rangeIds.has(candidateId)) integrityError();
    rangeIds.add(candidateId);
    const candidate = candidateById.get(candidateId);
    const boundary = validateReferencedBoundary(
      validateBoundary({
        startContextIndex: range.startContextIndex,
        endContextIndex: range.endContextIndex,
        startEntryId: range.startEntryId,
        endEntryId: range.endEntryId,
        requiredSourceEntryIds: range.requiredSourceEntryIds,
      }),
    );
    if (
      candidate === undefined ||
      candidate.startEntryId !== boundary.startEntryId ||
      candidate.endEntryId !== boundary.endEntryId
    ) {
      integrityError();
    }
    return { candidateId, ...boundary };
  });
  return { contextOwners, completeTurns, ranges };
}

function messageRole(message: ContextMessage): string | undefined {
  return isRecord(message) && typeof message.role === "string" ? message.role : undefined;
}

function assistantHasFailure(message: ContextMessage): boolean {
  return !isRecord(message) || message.stopReason === "error" || message.stopReason === "aborted";
}

function assistantToolCallIds(message: ContextMessage): readonly string[] | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const ids: string[] = [];
  for (const content of message.content) {
    if (!isRecord(content)) return undefined;
    if (content.type === "toolCall") {
      if (typeof content.id !== "string" || content.id.length === 0) return undefined;
      ids.push(content.id);
    }
  }
  return ids;
}

interface SourceTurn {
  readonly start: number;
  readonly end: number;
  readonly complete: boolean;
}

function identifyTurns(source: readonly SourceProjection[]): readonly SourceTurn[] {
  const turns: SourceTurn[] = [];
  let start = 0;
  while (start < source.length) {
    if (messageRole(source[start].message) !== "user") {
      let next = start + 1;
      while (next < source.length && messageRole(source[next].message) !== "user") next += 1;
      turns.push({ start, end: next - 1, complete: false });
      start = next;
      continue;
    }
    let end = start + 1;
    while (end < source.length && messageRole(source[end].message) !== "user") end += 1;
    const messages = source.slice(start, end);
    let complete = messages.length > 1;
    let sawAssistant = false;
    const seenCalls = new Set<string>();
    const seenResults = new Set<string>();
    const pendingCalls = new Set<string>();
    for (const projection of messages) {
      const role = messageRole(projection.message);
      if (role === "assistant") {
        sawAssistant = true;
        if (pendingCalls.size > 0) complete = false;
        const toolCallIds = assistantToolCallIds(projection.message);
        if (toolCallIds === undefined || assistantHasFailure(projection.message)) complete = false;
        const stopReason = isRecord(projection.message) ? projection.message.stopReason : undefined;
        if ((toolCallIds?.length ?? 0) === 0 && stopReason === "toolUse") complete = false;
        if ((toolCallIds?.length ?? 0) > 0 && stopReason !== "toolUse") complete = false;
        for (const id of toolCallIds ?? []) {
          if (seenCalls.has(id)) complete = false;
          seenCalls.add(id);
          pendingCalls.add(id);
        }
      } else if (role === "toolResult") {
        if (!isRecord(projection.message) || typeof projection.message.toolCallId !== "string") {
          complete = false;
          continue;
        }
        const toolCallId = projection.message.toolCallId;
        if (!pendingCalls.has(toolCallId) || seenResults.has(toolCallId)) complete = false;
        pendingCalls.delete(toolCallId);
        seenResults.add(toolCallId);
      } else if (role !== "user") {
        complete = false;
      }
    }
    if (!sawAssistant || pendingCalls.size > 0 || seenCalls.size !== seenResults.size) {
      complete = false;
    }
    turns.push({ start, end: end - 1, complete });
    start = end;
  }
  return turns;
}

function validateOwnershipClaim(value: unknown): OwnershipClaim {
  if (!isRecord(value) || !hasExactFields(value, OWNERSHIP_FIELDS)) schemaError();
  if (value.method !== UNIQUE_STRUCTURAL_EXACT_METHOD) schemaError();
  return {
    contextIndex: requireIndex(value.contextIndex),
    sourceEntryId: requirePseudonym(value.sourceEntryId),
    method: UNIQUE_STRUCTURAL_EXACT_METHOD,
  };
}

function validateEvidence(value: unknown): ProvenanceEvidence {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["completeRangeClaims", "completeTurnClaims", "ownershipClaims"])
  )
    schemaError();
  if (
    !Array.isArray(value.ownershipClaims) ||
    !Array.isArray(value.completeTurnClaims) ||
    !Array.isArray(value.completeRangeClaims)
  )
    schemaError();
  const ownershipClaims = value.ownershipClaims.map(validateOwnershipClaim);
  const completeTurnClaims = value.completeTurnClaims.map((claim) => {
    if (!isRecord(claim) || !hasExactFields(claim, TURN_FIELDS)) schemaError();
    return { start: validateOwnershipClaim(claim.start), end: validateOwnershipClaim(claim.end) };
  });
  const completeRangeClaims = value.completeRangeClaims.map((claim) => {
    if (!isRecord(claim) || !hasExactFields(claim, RANGE_FIELDS)) schemaError();
    return {
      candidateId: requireCandidateId(claim.candidateId),
      start: validateOwnershipClaim(claim.start),
      end: validateOwnershipClaim(claim.end),
    };
  });
  return { ownershipClaims, completeTurnClaims, completeRangeClaims };
}

function calculateCoverage(expected: number, correct: number): CoverageCount {
  return { expected, correct, coverage: expected === 0 ? 0 : correct / expected };
}

function claimBoundaryKey(
  start: OwnershipClaim,
  end: OwnershipClaim,
  candidateId?: string,
): string {
  const namespace = candidateId === undefined ? "turn" : `range\u0000${candidateId}`;
  return `${namespace}\u0000${start.contextIndex}\u0000${start.sourceEntryId}\u0000${end.contextIndex}\u0000${end.sourceEntryId}`;
}

function expectedBoundaryKey(boundary: GroundTruthBoundary, candidateId?: string): string {
  const namespace = candidateId === undefined ? "turn" : `range\u0000${candidateId}`;
  return `${namespace}\u0000${boundary.startContextIndex}\u0000${boundary.startEntryId}\u0000${boundary.endContextIndex}\u0000${boundary.endEntryId}`;
}

function boundaryIsFullyObserved(
  boundary: GroundTruthBoundary,
  contextOwners: readonly (string | null)[],
): boolean {
  const observed = contextOwners.slice(boundary.startContextIndex, boundary.endContextIndex + 1);
  return (
    observed.length === boundary.requiredSourceEntryIds.length &&
    observed.every((owner, index) => owner === boundary.requiredSourceEntryIds[index])
  );
}

function rangeTurnsPartition(
  range: GroundTruthRange,
  turns: readonly GroundTruthBoundary[],
): readonly GroundTruthBoundary[] | undefined {
  const included = turns.filter((turn) => {
    const start = range.requiredSourceEntryIds.indexOf(turn.startEntryId);
    const end = range.requiredSourceEntryIds.indexOf(turn.endEntryId);
    return (
      start >= 0 &&
      end >= start &&
      turn.requiredSourceEntryIds.every(
        (id, offset) => range.requiredSourceEntryIds[start + offset] === id,
      )
    );
  });
  const flattened = included.flatMap((turn) => turn.requiredSourceEntryIds);
  if (included.length === 0 || flattened.length !== range.requiredSourceEntryIds.length)
    return undefined;
  return flattened.every((id, index) => id === range.requiredSourceEntryIds[index])
    ? included
    : undefined;
}

/** Compare claims with a separately supplied, content-free synthetic ground truth. */
export function compareProvenanceEvidence(
  evidenceValue: unknown,
  groundTruthValue: unknown,
  candidatesValue: unknown,
  sourceEntryIdsValue: readonly string[],
): ProvenanceComparison {
  if (!Array.isArray(sourceEntryIdsValue)) schemaError();
  if (sourceEntryIdsValue.some((id) => typeof id !== "string" || !PSEUDONYM.test(id))) {
    schemaError();
  }
  if (new Set(sourceEntryIdsValue).size !== sourceEntryIdsValue.length) integrityError();
  const sourceIds = new Set(sourceEntryIdsValue);
  const candidates = validateCandidates(candidatesValue, sourceIds);
  const expectedContextLength =
    isRecord(groundTruthValue) && Array.isArray(groundTruthValue.contextOwners)
      ? groundTruthValue.contextOwners.length
      : -1;
  const groundTruth = validateGroundTruth(
    groundTruthValue,
    sourceEntryIdsValue,
    candidates,
    expectedContextLength,
  );
  const evidence = validateEvidence(evidenceValue);
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const claimedContextIndices = new Set<number>();
  const claimedSourceIds = new Set<string>();
  const correctOwners = new Set<string>();
  let ownershipFalsePositives = 0;
  let correctOwnerCount = 0;
  for (const claim of evidence.ownershipClaims) {
    const duplicate =
      claimedContextIndices.has(claim.contextIndex) || claimedSourceIds.has(claim.sourceEntryId);
    claimedContextIndices.add(claim.contextIndex);
    claimedSourceIds.add(claim.sourceEntryId);
    if (
      duplicate ||
      !sourceIds.has(claim.sourceEntryId) ||
      groundTruth.contextOwners[claim.contextIndex] !== claim.sourceEntryId
    ) {
      ownershipFalsePositives += 1;
    } else {
      correctOwners.add(claim.sourceEntryId);
      correctOwnerCount += 1;
    }
  }
  const expectedTurns = new Set(groundTruth.completeTurns.map((turn) => expectedBoundaryKey(turn)));
  const expectedRanges = new Set(
    groundTruth.ranges.map((range) => expectedBoundaryKey(range, range.candidateId)),
  );
  const correctTurns = new Set<string>();
  const correctRanges = new Set<string>();
  const claimedBoundaries = new Set<string>();
  let boundaryFalsePositives = 0;
  for (const claim of evidence.completeTurnClaims) {
    const key = claimBoundaryKey(claim.start, claim.end);
    const duplicate = claimedBoundaries.has(key);
    claimedBoundaries.add(key);
    if (
      duplicate ||
      !sourceIds.has(claim.start.sourceEntryId) ||
      !sourceIds.has(claim.end.sourceEntryId) ||
      !expectedTurns.has(key)
    ) {
      boundaryFalsePositives += 1;
    } else {
      correctTurns.add(key);
    }
  }
  for (const claim of evidence.completeRangeClaims) {
    const key = claimBoundaryKey(claim.start, claim.end, claim.candidateId);
    const duplicate = claimedBoundaries.has(key);
    claimedBoundaries.add(key);
    if (
      duplicate ||
      !candidateIds.has(claim.candidateId) ||
      !sourceIds.has(claim.start.sourceEntryId) ||
      !sourceIds.has(claim.end.sourceEntryId) ||
      !expectedRanges.has(key)
    ) {
      boundaryFalsePositives += 1;
    } else {
      correctRanges.add(key);
    }
  }
  const fullyCoveredTurns = groundTruth.completeTurns.filter(
    (turn) =>
      boundaryIsFullyObserved(turn, groundTruth.contextOwners) &&
      turn.requiredSourceEntryIds.every((entryId) => correctOwners.has(entryId)) &&
      correctTurns.has(expectedBoundaryKey(turn)),
  ).length;
  const qualifyingCandidates = candidates.filter(
    (candidate) =>
      candidate.estimatedTokens >=
      COMPLETE_RANGE_PROVENANCE_POLICY.qualificationEstimatedTokenMinimum,
  );
  const fullyCoveredQualifyingCandidateCount = qualifyingCandidates.filter((candidate) => {
    const range = groundTruth.ranges.find((item) => item.candidateId === candidate.candidateId);
    if (
      range === undefined ||
      !boundaryIsFullyObserved(range, groundTruth.contextOwners) ||
      !correctRanges.has(expectedBoundaryKey(range, range.candidateId)) ||
      !range.requiredSourceEntryIds.every((entryId) => correctOwners.has(entryId))
    ) {
      return false;
    }
    const turns = rangeTurnsPartition(range, groundTruth.completeTurns);
    return turns?.every((turn) => correctTurns.has(expectedBoundaryKey(turn))) ?? false;
  }).length;
  const expectedOwnerCount = groundTruth.contextOwners.filter((owner) => owner !== null).length;
  return deepFreeze({
    pass:
      ownershipFalsePositives === 0 &&
      boundaryFalsePositives === 0 &&
      fullyCoveredQualifyingCandidateCount >=
        COMPLETE_RANGE_PROVENANCE_POLICY.requiredCompleteQualifyingRangesPerApplicableScenario,
    ownershipFalsePositives,
    boundaryFalsePositives,
    qualifyingCandidateCount: qualifyingCandidates.length,
    fullyCoveredQualifyingCandidateCount,
    messageCoverage: calculateCoverage(expectedOwnerCount, correctOwnerCount),
    turnCoverage: calculateCoverage(groundTruth.completeTurns.length, fullyCoveredTurns),
  });
}

/** Compute exact-only ownership and eligible complete source-turn/range claims. */
export function evaluateProvenance(input: unknown): ProvenanceEvaluation {
  if (
    !isRecord(input) ||
    !hasExactFields(input, ["candidates", "groundTruth", "observedMessages", "sourceProjections"])
  )
    schemaError();
  const source = validateSourceProjections(input.sourceProjections);
  const sourceEntryIds = source.map((projection) => projection.sourceEntryId);
  const sourceIds = new Set(sourceEntryIds);
  const observed = validateMessages(input.observedMessages);
  const candidates = validateCandidates(input.candidates, sourceIds);
  validateGroundTruth(input.groundTruth, sourceEntryIds, candidates, observed.length);
  const sourceBuckets = new Map<string, number[]>();
  const contextBuckets = new Map<string, number[]>();
  for (const [index, projection] of source.entries()) {
    const key = canonicalJson(projection.message);
    sourceBuckets.set(key, [...(sourceBuckets.get(key) ?? []), index]);
  }
  for (const [index, message] of observed.entries()) {
    const key = canonicalJson(message);
    contextBuckets.set(key, [...(contextBuckets.get(key) ?? []), index]);
  }
  const ownershipClaims: OwnershipClaim[] = [];
  const contextBySource = new Map<number, number>();
  for (const [key, sourceIndices] of sourceBuckets) {
    const contextIndices = contextBuckets.get(key);
    if (sourceIndices.length !== 1 || contextIndices?.length !== 1) continue;
    const sourceIndex = sourceIndices[0];
    const contextIndex = contextIndices[0];
    if (canonicalJson(source[sourceIndex].message) !== canonicalJson(observed[contextIndex]))
      continue;
    ownershipClaims.push({
      contextIndex,
      sourceEntryId: source[sourceIndex].sourceEntryId,
      method: UNIQUE_STRUCTURAL_EXACT_METHOD,
    });
    contextBySource.set(sourceIndex, contextIndex);
  }
  ownershipClaims.sort((left, right) => left.contextIndex - right.contextIndex);
  const atom = (sourceIndex: number): OwnershipClaim => ({
    contextIndex: contextBySource.get(sourceIndex)!,
    sourceEntryId: source[sourceIndex].sourceEntryId,
    method: UNIQUE_STRUCTURAL_EXACT_METHOD,
  });
  const turns = identifyTurns(source);
  const isContiguous = (start: number, end: number): boolean => {
    for (let index = start; index <= end; index += 1) {
      if (contextBySource.get(index) !== contextBySource.get(start)! + index - start) return false;
    }
    return true;
  };
  const completeTurnClaims = turns
    .filter((turn) => turn.complete && isContiguous(turn.start, turn.end))
    .map((turn) => ({ start: atom(turn.start), end: atom(turn.end) }));
  const completeRangeClaims: CompleteRangeClaim[] = [];
  for (const candidate of candidates) {
    if (
      candidate.estimatedTokens <
      COMPLETE_RANGE_PROVENANCE_POLICY.qualificationEstimatedTokenMinimum
    )
      continue;
    const start = sourceEntryIds.indexOf(candidate.startEntryId);
    const end = sourceEntryIds.indexOf(candidate.endEntryId);
    const includedTurns = turns.filter((turn) => turn.start >= start && turn.end <= end);
    if (
      start > end ||
      includedTurns.length === 0 ||
      includedTurns[0].start !== start ||
      includedTurns.at(-1)!.end !== end ||
      includedTurns.some((turn) => !turn.complete) ||
      !isContiguous(start, end)
    )
      continue;
    completeRangeClaims.push({
      candidateId: candidate.candidateId,
      start: atom(start),
      end: atom(end),
    });
  }
  const evidence = deepFreeze({ ownershipClaims, completeTurnClaims, completeRangeClaims });
  const comparison = compareProvenanceEvidence(
    evidence,
    input.groundTruth,
    candidates,
    sourceEntryIds,
  );
  return deepFreeze({ evidence, comparison });
}

/** Serialize only the allowlisted, content-free evidence record. */
export function serializeProvenanceEvidence(evidence: unknown): string {
  return canonicalJson(validateEvidence(evidence));
}
