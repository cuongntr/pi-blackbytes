/** Deterministic, evaluation-only qualification and complete-range validation. */

import { canonicalJson } from "./canonical-json.js";
import { COMPLETE_RANGE_PROVENANCE_POLICY, QUALIFICATION_ESTIMATOR_POLICY } from "./protocol.js";
import { EvidenceStoreError, QUALIFICATION_REASON_CODES, SCHEMA_VERSION } from "./types.js";
import type { QualificationReasonCode, QualificationRecord } from "./types.js";

export const CONTEXT_PRESSURE_THRESHOLD = 0.7;
export const REQUIRED_SUBSEQUENT_REQUESTS = 5;

const CLOSURE_CODES = ["user-accepted", "goal-transition", "verification-passed"] as const;
const CLOSURE_CODE_SET = new Set<string>(CLOSURE_CODES);
const REASON_CODE_SET = new Set<string>(QUALIFICATION_REASON_CODES);

type ClosureEvidence = (typeof CLOSURE_CODES)[number];
type MessageRole = "user" | "assistant" | "toolResult";

export interface QualificationMessage {
  readonly role: MessageRole;
  readonly content: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly stopReason?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: Readonly<Record<string, unknown>>;
}

export interface QualificationEntry {
  readonly id: string;
  readonly parentId?: string;
  readonly type: "message" | "compaction" | "other";
  readonly message?: QualificationMessage;
  /** Only explicit main-agent requests count toward the frozen future horizon. */
  readonly requestOrigin?: "main" | "compaction" | "worker" | "unknown";
}

export interface ContextPressurePoint {
  readonly contextPercent?: number;
  readonly totalTokens?: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly provider?: string;
  readonly model?: string;
}

export interface FrozenModelRegistry {
  readonly contextWindows: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

export interface CandidateRangeInput {
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly entryIds: readonly string[];
  readonly closureEntryId: string;
  readonly closureEvidence: readonly ClosureEvidence[];
  readonly objectiveVerificationEntryId?: string;
}

export interface QualificationInput {
  readonly corpusId: string;
  readonly selectedRank: number;
  readonly parentStatus: "parent" | "fork" | "unknown";
  readonly selectedLeafId: string;
  readonly entries: readonly QualificationEntry[];
  readonly pressurePoints: readonly ContextPressurePoint[];
  readonly nativeCompactionCount: number;
  readonly frozenModelRegistry: FrozenModelRegistry;
  readonly candidate: CandidateRangeInput;
}

interface RangeAnalysis {
  readonly complete: boolean;
  readonly candidate?: QualificationRecord["candidate"];
  readonly subsequentCount: number;
  readonly reasons: readonly QualificationReasonCode[];
}

function schema(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  );
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Resolve pressure only from recorded percent or an exact frozen provider/model window. */
export function evaluateContextPressure(
  points: readonly ContextPressurePoint[],
  registry: FrozenModelRegistry,
  nativeCompactionCount: number,
): { readonly pass: boolean; readonly maxRatio?: number } {
  if (!Number.isSafeInteger(nativeCompactionCount) || nativeCompactionCount < 0) {
    schema("nativeCompactionCount must be a non-negative safe integer");
  }
  let maxRatio: number | undefined;
  for (const point of points) {
    let ratio: number | undefined;
    if (finiteNonnegative(point.contextPercent)) {
      ratio = point.contextPercent / 100;
    } else {
      let total = finiteNonnegative(point.totalTokens) ? point.totalTokens : undefined;
      if (
        total === undefined &&
        finiteNonnegative(point.input) &&
        finiteNonnegative(point.output) &&
        finiteNonnegative(point.cacheRead) &&
        finiteNonnegative(point.cacheWrite)
      ) {
        total = point.input + point.output + point.cacheRead + point.cacheWrite;
      }
      const window =
        typeof point.provider === "string" && typeof point.model === "string"
          ? registry.contextWindows.get(point.provider)?.get(point.model)
          : undefined;
      if (total !== undefined && finiteNonnegative(window) && window > 0) ratio = total / window;
    }
    if (ratio !== undefined && Number.isFinite(ratio)) {
      maxRatio = maxRatio === undefined ? ratio : Math.max(maxRatio, ratio);
    }
  }
  return Object.freeze({
    pass:
      nativeCompactionCount > 0 ||
      (maxRatio !== undefined && maxRatio >= CONTEXT_PRESSURE_THRESHOLD),
    ...(maxRatio === undefined ? {} : { maxRatio }),
  });
}

function modelVisibleMessage(message: QualificationMessage): Record<string, unknown> {
  if (message.role === "toolResult") {
    return {
      role: message.role,
      ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
      ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
      content: message.content,
      ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
    };
  }
  return { role: message.role, content: message.content };
}

/** Frozen qualification-only byte/4 estimator; never actual, billed, removed, or saved tokens. */
export function estimateQualificationTokens(messages: readonly QualificationMessage[]): number {
  const canonical = canonicalJson(messages.map(modelVisibleMessage));
  return Math.ceil(
    Buffer.byteLength(canonical, "utf8") / QUALIFICATION_ESTIMATOR_POLICY.bytesPerEstimatedToken,
  );
}

function assistantToolCallIds(message: QualificationMessage): readonly string[] | undefined {
  if (!Array.isArray(message.content)) return undefined;
  const ids: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) return undefined;
    if (block.type === "toolCall") {
      if (typeof block.id !== "string" || block.id.length === 0) return undefined;
      ids.push(block.id);
    }
  }
  return ids;
}

function completeTurns(messages: readonly QualificationMessage[]): {
  readonly complete: boolean;
  readonly unmatchedTool: boolean;
} {
  if (messages.length === 0 || messages[0].role !== "user") {
    return { complete: false, unmatchedTool: false };
  }
  let turnStart = 0;
  let unmatchedTool = false;
  while (turnStart < messages.length) {
    if (messages[turnStart].role !== "user") return { complete: false, unmatchedTool };
    let turnEnd = turnStart + 1;
    while (turnEnd < messages.length && messages[turnEnd].role !== "user") turnEnd += 1;
    const pending = new Set<string>();
    const calls = new Set<string>();
    const results = new Set<string>();
    let sawAssistant = false;
    let complete = turnEnd > turnStart + 1;
    for (const message of messages.slice(turnStart, turnEnd)) {
      if (message.role === "assistant") {
        sawAssistant = true;
        if (
          pending.size > 0 ||
          message.stopReason === "error" ||
          message.stopReason === "aborted"
        ) {
          complete = false;
        }
        const ids = assistantToolCallIds(message);
        if (ids === undefined) complete = false;
        if ((ids?.length ?? 0) > 0 && message.stopReason !== "toolUse") complete = false;
        if ((ids?.length ?? 0) === 0 && message.stopReason === "toolUse") complete = false;
        for (const id of ids ?? []) {
          if (calls.has(id)) {
            unmatchedTool = true;
            complete = false;
          }
          calls.add(id);
          pending.add(id);
        }
      } else if (message.role === "toolResult") {
        const id = message.toolCallId;
        if (typeof id !== "string" || !pending.has(id) || results.has(id)) {
          unmatchedTool = true;
          complete = false;
        } else {
          pending.delete(id);
          results.add(id);
        }
      } else if (message !== messages[turnStart]) {
        complete = false;
      }
    }
    if (!sawAssistant || pending.size > 0 || calls.size !== results.size) {
      if (pending.size > 0 || calls.size !== results.size) unmatchedTool = true;
      complete = false;
    }
    if (!complete) return { complete: false, unmatchedTool };
    turnStart = turnEnd;
  }
  return { complete: true, unmatchedTool };
}

function activeBranch(
  entries: readonly QualificationEntry[],
  leafId: string,
): readonly QualificationEntry[] {
  const byId = new Map<string, QualificationEntry>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.length === 0 || byId.has(entry.id)) {
      schema("Qualification entries require unique non-empty IDs");
    }
    byId.set(entry.id, entry);
  }
  const reverse: QualificationEntry[] = [];
  const visited = new Set<string>();
  let current = byId.get(leafId);
  if (current === undefined) schema("selectedLeafId is absent from entries");
  while (current !== undefined) {
    if (visited.has(current.id)) schema("Qualification branch contains a cycle");
    visited.add(current.id);
    reverse.push(current);
    current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    if (reverse.at(-1)?.parentId !== undefined && current === undefined) {
      schema("Qualification branch has a missing parent");
    }
  }
  return reverse.reverse();
}

function analyzeRange(
  input: QualificationInput,
  branch: readonly QualificationEntry[],
): RangeAnalysis {
  const reasons = new Set<QualificationReasonCode>();
  const indexById = new Map(branch.map((entry, index) => [entry.id, index]));
  const start = indexById.get(input.candidate.startEntryId);
  const end = indexById.get(input.candidate.endEntryId);
  const closure = indexById.get(input.candidate.closureEntryId);
  if (start === undefined || end === undefined || closure === undefined) {
    reasons.add("candidate-cross-branch");
    return { complete: false, subsequentCount: 0, reasons: [...reasons] };
  }
  if (start > end) {
    reasons.add("candidate-range-missing");
    return { complete: false, subsequentCount: 0, reasons: [...reasons] };
  }
  const range = branch.slice(start, end + 1);
  if (
    input.candidate.entryIds.length !== range.length ||
    input.candidate.entryIds.some((id, index) => id !== range[index].id)
  ) {
    reasons.add("candidate-not-contiguous");
  }
  if (closure <= end) reasons.add("closure-not-after-range");
  if (
    input.candidate.closureEvidence.length === 0 ||
    new Set(input.candidate.closureEvidence).size !== input.candidate.closureEvidence.length ||
    input.candidate.closureEvidence.some((code) => !CLOSURE_CODE_SET.has(code))
  ) {
    reasons.add("closure-evidence-invalid");
  }

  let epoch = 0;
  const epochs = new Map<string, number>();
  for (const entry of branch) {
    if (entry.type === "compaction") epoch += 1;
    epochs.set(entry.id, epoch);
  }
  if (epochs.get(input.candidate.startEntryId) !== epochs.get(input.candidate.endEntryId)) {
    reasons.add("candidate-cross-compaction");
  }

  const messages = range.flatMap((entry) =>
    entry.type === "message" && entry.message !== undefined ? [entry.message] : [],
  );
  if (messages.length !== range.length) reasons.add("incomplete-turn");
  const turnResult = completeTurns(messages);
  if (!turnResult.complete) reasons.add("incomplete-turn");
  if (turnResult.unmatchedTool) reasons.add("unmatched-tool-call");

  const estimatedTokens = estimateQualificationTokens(messages);
  if (estimatedTokens < COMPLETE_RANGE_PROVENANCE_POLICY.qualificationEstimatedTokenMinimum) {
    reasons.add("range-under-token-minimum");
  }

  if (input.candidate.closureEvidence.includes("verification-passed")) {
    const verificationIndex =
      input.candidate.objectiveVerificationEntryId === undefined
        ? undefined
        : indexById.get(input.candidate.objectiveVerificationEntryId);
    const verificationEntry =
      verificationIndex === undefined ? undefined : branch[verificationIndex];
    if (
      verificationIndex === undefined ||
      verificationIndex < start ||
      verificationIndex > end ||
      verificationEntry?.message?.role !== "toolResult" ||
      verificationEntry.message.isError !== false
    ) {
      reasons.add("invalid-objective-verification");
    }
  }

  const subsequent = branch
    .slice(closure + 1)
    .filter(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        entry.requestOrigin === "main" &&
        isRecord(entry.message.usage),
    )
    .map((entry) => entry.id);
  if (subsequent.length < REQUIRED_SUBSEQUENT_REQUESTS) {
    reasons.add("fewer-than-five-subsequent-requests");
  }

  const structuralReasons = new Set<QualificationReasonCode>([
    "candidate-cross-branch",
    "candidate-cross-compaction",
    "candidate-not-contiguous",
    "candidate-range-missing",
    "closure-evidence-invalid",
    "closure-not-after-range",
    "incomplete-turn",
    "invalid-objective-verification",
    "range-under-token-minimum",
    "unmatched-tool-call",
  ]);
  const complete = ![...reasons].some((reason) => structuralReasons.has(reason));
  const validClosureEvidence = input.candidate.closureEvidence.filter((code) =>
    CLOSURE_CODE_SET.has(code),
  );
  const candidate = {
    branchLeafId: input.selectedLeafId,
    startEntryId: input.candidate.startEntryId,
    endEntryId: input.candidate.endEntryId,
    closureEntryId: input.candidate.closureEntryId,
    startOrder: start,
    endOrder: end,
    closureOrder: closure,
    closureEvidence: Object.freeze(validClosureEvidence),
    estimatedTokens,
    subsequentRequestIds: Object.freeze(subsequent.slice(0, REQUIRED_SUBSEQUENT_REQUESTS)),
  };
  return { complete, candidate, subsequentCount: subsequent.length, reasons: [...reasons].sort() };
}

/** Evaluate all four locked criteria and emit a content-free record. */
export function qualifySession(input: QualificationInput): QualificationRecord {
  if (!Number.isSafeInteger(input.selectedRank) || input.selectedRank < 1) {
    schema("selectedRank must be a positive safe integer");
  }
  const parent = input.parentStatus === "parent";
  const pressure = evaluateContextPressure(
    input.pressurePoints,
    input.frozenModelRegistry,
    input.nativeCompactionCount,
  );
  const branch = activeBranch(input.entries, input.selectedLeafId);
  const range = analyzeRange(input, branch);
  const reasonCodes = new Set(range.reasons);
  if (!parent) reasonCodes.add("not-eligible-parent");
  if (!pressure.pass) {
    reasonCodes.add(
      pressure.maxRatio === undefined
        ? "context-pressure-missing"
        : "context-pressure-under-threshold",
    );
  }
  const fiveSubsequentRequests = range.subsequentCount >= REQUIRED_SUBSEQUENT_REQUESTS;
  const record: QualificationRecord = {
    schemaVersion: SCHEMA_VERSION,
    corpusId: input.corpusId,
    selectedRank: input.selectedRank,
    qualifies: parent && pressure.pass && range.complete && fiveSubsequentRequests,
    criteria: {
      parent,
      pressure: pressure.pass,
      completedSegment: range.complete,
      fiveSubsequentRequests,
    },
    reasonCodes: Object.freeze([...reasonCodes].sort()),
    ...(range.candidate === undefined ? {} : { candidate: range.candidate }),
    annotatorIds: Object.freeze([]),
    adjudicationStatus: "not-needed",
  };
  return validateQualificationRecord(record);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    schema(`${field} must be a non-empty string`);
  return value;
}

/** Strict privacy allowlist: unknown/content-bearing result fields are rejected. */
export function validateQualificationRecord(value: unknown): QualificationRecord {
  if (!isRecord(value)) schema("Qualification record must be an object");
  const hasCandidate = Object.hasOwn(value, "candidate");
  const fields = [
    "adjudicationStatus",
    "annotatorIds",
    ...(hasCandidate ? ["candidate"] : []),
    "corpusId",
    "criteria",
    "qualifies",
    "reasonCodes",
    "schemaVersion",
    "selectedRank",
  ];
  if (!exactFields(value, fields)) schema("Qualification record contains non-allowlisted fields");
  if (value.schemaVersion !== SCHEMA_VERSION) schema("Invalid qualification schemaVersion");
  if (!Number.isSafeInteger(value.selectedRank) || (value.selectedRank as number) < 1)
    schema("Invalid selectedRank");
  if (typeof value.qualifies !== "boolean") schema("Invalid qualifies value");
  if (
    !isRecord(value.criteria) ||
    !exactFields(value.criteria, [
      "completedSegment",
      "fiveSubsequentRequests",
      "parent",
      "pressure",
    ])
  ) {
    schema("Invalid qualification criteria");
  }
  for (const criterion of Object.values(value.criteria)) {
    if (typeof criterion !== "boolean") schema("Qualification criteria must be boolean");
  }
  if (
    !Array.isArray(value.reasonCodes) ||
    value.reasonCodes.some((code) => typeof code !== "string" || !REASON_CODE_SET.has(code))
  ) {
    schema("Invalid qualification reason code");
  }
  if (
    !Array.isArray(value.annotatorIds) ||
    value.annotatorIds.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    schema("Invalid annotatorIds");
  }
  if (
    value.adjudicationStatus !== "not-needed" &&
    value.adjudicationStatus !== "resolved" &&
    value.adjudicationStatus !== "unresolved"
  ) {
    schema("Invalid adjudicationStatus");
  }

  let candidate: QualificationRecord["candidate"];
  if (hasCandidate) {
    if (
      !isRecord(value.candidate) ||
      !exactFields(value.candidate, [
        "branchLeafId",
        "closureEntryId",
        "closureEvidence",
        "closureOrder",
        "endEntryId",
        "endOrder",
        "estimatedTokens",
        "startEntryId",
        "startOrder",
        "subsequentRequestIds",
      ])
    ) {
      schema("Invalid qualification candidate fields");
    }
    if (
      !Array.isArray(value.candidate.closureEvidence) ||
      value.candidate.closureEvidence.some(
        (code) => typeof code !== "string" || !CLOSURE_CODE_SET.has(code),
      )
    ) {
      schema("Invalid closureEvidence");
    }
    if (
      !Array.isArray(value.candidate.subsequentRequestIds) ||
      value.candidate.subsequentRequestIds.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      schema("Invalid subsequentRequestIds");
    }
    if (
      !Number.isSafeInteger(value.candidate.estimatedTokens) ||
      (value.candidate.estimatedTokens as number) < 0
    ) {
      schema("Invalid estimatedTokens");
    }
    for (const field of ["startOrder", "endOrder", "closureOrder"] as const) {
      if (!Number.isSafeInteger(value.candidate[field]) || (value.candidate[field] as number) < 0) {
        schema(`Invalid ${field}`);
      }
    }
    if (
      value.qualifies &&
      ((value.candidate.startOrder as number) > (value.candidate.endOrder as number) ||
        (value.candidate.endOrder as number) >= (value.candidate.closureOrder as number))
    ) {
      schema("Invalid candidate order bounds");
    }
    candidate = {
      branchLeafId: requireString(value.candidate.branchLeafId, "branchLeafId"),
      startEntryId: requireString(value.candidate.startEntryId, "startEntryId"),
      endEntryId: requireString(value.candidate.endEntryId, "endEntryId"),
      closureEntryId: requireString(value.candidate.closureEntryId, "closureEntryId"),
      startOrder: value.candidate.startOrder as number,
      endOrder: value.candidate.endOrder as number,
      closureOrder: value.candidate.closureOrder as number,
      closureEvidence: Object.freeze([...(value.candidate.closureEvidence as ClosureEvidence[])]),
      estimatedTokens: value.candidate.estimatedTokens as number,
      subsequentRequestIds: Object.freeze([...(value.candidate.subsequentRequestIds as string[])]),
    };
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    corpusId: requireString(value.corpusId, "corpusId"),
    selectedRank: value.selectedRank as number,
    qualifies: value.qualifies,
    criteria: Object.freeze({
      parent: value.criteria.parent as boolean,
      pressure: value.criteria.pressure as boolean,
      completedSegment: value.criteria.completedSegment as boolean,
      fiveSubsequentRequests: value.criteria.fiveSubsequentRequests as boolean,
    }),
    reasonCodes: Object.freeze([...(value.reasonCodes as QualificationReasonCode[])].sort()),
    ...(candidate === undefined ? {} : { candidate: Object.freeze(candidate) }),
    annotatorIds: Object.freeze([...(value.annotatorIds as string[])]),
    adjudicationStatus: value.adjudicationStatus,
  });
}
