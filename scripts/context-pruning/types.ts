/**
 * Core versioned types for the context-pruning evaluation toolchain.
 *
 * T-001: Foundation types only. Inventory, sampling, qualification, scoring,
 * decision, and report types are defined here but are stubs until their
 * respective beads implement them.
 *
 * @module
 */

// ── Error taxonomy ──────────────────────────────────────────────────────────

/** All defined evaluation error codes. */
export const E_EVAL_CODES = [
  "E_EVAL_CONFIG",
  "E_EVAL_PRIVACY",
  "E_EVAL_INTEGRITY",
  "E_EVAL_SCHEMA",
  "E_EVAL_INCOMPLETE",
  "E_EVAL_PROVIDER",
  "E_EVAL_UNSAFE_PATH",
] as const;

/** A valid evaluation error code. */
export type EvalErrorCode = (typeof E_EVAL_CODES)[number];

/**
 * Structured evaluation error, emitted as JSON to stderr.
 *
 * @see Design §10 — CLI API
 */
export interface EvidenceError {
  readonly code: EvalErrorCode;
  readonly message: string;
  readonly recordId?: string;
}

// ── Schema version ──────────────────────────────────────────────────────────

/** Current schema version for all evaluation records. */
export const SCHEMA_VERSION = 1;

// ── CLI commands ─────────────────────────────────────────────────────────────

/** All CLI commands exposed by the evaluation toolchain. */
export const CLI_COMMANDS = [
  "init",
  "inventory",
  "sample",
  "select-target",
  "qualify",
  "adjudicate",
  "freeze",
  "replay",
  "score",
  "lifecycle",
  "decide",
  "report",
  "verify",
  "cleanup",
] as const;

/** A valid CLI command name. */
export type CliCommand = (typeof CLI_COMMANDS)[number];

// ── Core entity types (Design §9.2) ─────────────────────────────────────────

/** Fixed, privacy-allowlisted entry buckets emitted by metadata inventory. */
export type InventoryEntryType =
  | "session"
  | "message"
  | "thinking_level_change"
  | "model_change"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "label"
  | "session_info"
  | "custom_message"
  | "unknown"
  | "malformed";

/** Fixed, privacy-allowlisted message role buckets emitted by metadata inventory. */
export type InventoryRole = "user" | "assistant" | "toolResult" | "unknown";

/** Numeric assistant usage and actual `usage.cost` aggregates; values are never estimated. */
export interface InventoryUsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

/**
 * Content-free inventory record for one discovered session file.
 *
 * `entryCounts` and `roleCounts` have only the fixed allowlisted keys above.
 * `usageCompleteness` is complete usage records divided by `requestCount`.
 *
 * @see Design §9.2
 */
export interface InventoryRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** Per-file identity: HMAC(corpusKey, UTF8(canonicalPath) || UTF8(sessionHeaderId)). */
  readonly corpusId: string;
  /** HMAC(corpusKey, UTF8(canonical source parent directory)) for readable sources only. */
  readonly repositoryId?: string;
  /** Domain-separated identity of the resolved in-corpus lineage root, when known. */
  readonly lineageRootId?: string;
  readonly sourceDigest: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly sessionVersion?: number;
  readonly parentStatus: "parent" | "fork" | "unknown";
  readonly parseStatus: "valid" | "partial" | "unreadable";
  readonly entryCounts: Readonly<Record<InventoryEntryType, number>>;
  readonly roleCounts: Readonly<Record<InventoryRole, number>>;
  readonly usageTotals: InventoryUsageTotals;
  /** Assistant usage records across the entire source, not just the selected branch. */
  readonly requestCount: number;
  /** Number of terminal leaves in the source topology. */
  readonly branchCount: number;
  readonly selectedLeafId?: string;
  readonly selectedLeafLineIndex?: number;
  readonly finalBranchEntryCount: number;
  readonly finalBranchRequestCount: number;
  readonly abandonedEntryCount: number;
  readonly lineageStatus: "root" | "resolved" | "unresolved" | "cycle" | "unknown";
  readonly lineageDisposition: "unique" | "duplicate-lineage" | "excluded";
  readonly usageCompleteness: number;
  readonly maxContextRatio?: number;
  readonly compactionCount: number;
  readonly exclusionReasons: readonly string[];
}

/**
 * Qualification record for one sampled session.
 *
 * @see Design §9.2
 */
/** One content-free entry in a frozen deterministic sample. */
export interface SampleManifestEntry {
  readonly rank: number;
  readonly corpusId: string;
  readonly selectionKey: string;
  readonly repositoryId: string;
  readonly lineageRootId: string;
}

/** Pseudonym-only repository concentration for a frame or frozen sample. */
export interface RepositoryConcentration {
  readonly repositoryId: string;
  readonly count: number;
  readonly share: number;
}

/** A non-decision frame count at a fixed request threshold. */
export interface SamplingSensitivitySummary {
  readonly requestThreshold: 10 | 15 | 20 | 25;
  readonly frameSize: number;
}

/** Immutable, content-free first-40 sample manifest. */
export interface SampleManifest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly samplingLockDigest: string;
  readonly inventoryDigest: string;
  readonly attemptIndex: number;
  readonly frameSize: number;
  readonly entries: readonly SampleManifestEntry[];
  readonly sensitivity: readonly SamplingSensitivitySummary[];
  readonly repositoryConcentration: {
    readonly frame: readonly RepositoryConcentration[];
    readonly sample: readonly RepositoryConcentration[];
  };
}

/** A frozen sample or a content-free underflow disposition. */
export type SamplingResult =
  | {
      readonly status: "frozen";
      readonly manifest: SampleManifest;
    }
  | {
      readonly status: "underflow-pending" | "underflow-hard-stop";
      readonly code: "E_EVAL_INCOMPLETE";
      readonly attemptIndex: number;
      readonly frameSize: number;
      readonly requiredSampleSize: number;
      readonly maxInventoryRefreshes: number;
      readonly collectionWindowEndsAt: string;
    };

export const QUALIFICATION_REASON_CODES = [
  "candidate-cross-branch",
  "candidate-cross-compaction",
  "candidate-not-contiguous",
  "candidate-range-missing",
  "closure-evidence-invalid",
  "closure-not-after-range",
  "context-pressure-missing",
  "context-pressure-under-threshold",
  "fewer-than-five-subsequent-requests",
  "incomplete-turn",
  "invalid-objective-verification",
  "not-eligible-parent",
  "range-under-token-minimum",
  "unmatched-tool-call",
] as const;

export type QualificationReasonCode = (typeof QUALIFICATION_REASON_CODES)[number];

export interface QualificationRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly corpusId: string;
  readonly selectedRank: number;
  readonly qualifies: boolean;
  readonly criteria: {
    readonly parent: boolean;
    readonly pressure: boolean;
    readonly completedSegment: boolean;
    readonly fiveSubsequentRequests: boolean;
  };
  readonly reasonCodes: readonly QualificationReasonCode[];
  readonly candidate?: {
    readonly branchLeafId: string;
    readonly startEntryId: string;
    readonly endEntryId: string;
    readonly closureEntryId: string;
    readonly startOrder: number;
    readonly endOrder: number;
    readonly closureOrder: number;
    readonly closureEvidence: readonly (
      | "user-accepted"
      | "goal-transition"
      | "verification-passed"
    )[];
    readonly estimatedTokens: number;
    readonly subsequentRequestIds: readonly string[];
  };
  readonly annotatorIds: readonly string[];
  readonly adjudicationStatus: "not-needed" | "resolved" | "unresolved";
}

/**
 * Gate result for one decision gate.
 */
export interface GateResult {
  readonly pass: boolean;
  readonly value: number;
  readonly threshold: number;
  readonly details: readonly string[];
}

/**
 * Final mechanical decision report.
 *
 * @see Design §9.2
 */
export interface DecisionReport {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly evaluationProtocolDigest: string;
  readonly inventoryDigest: string;
  readonly sampleDigest: string;
  readonly pricingDigest: string;
  readonly environmentDigest: string;
  readonly gates: {
    readonly quality: GateResult;
    readonly utility: GateResult;
    readonly applicability: GateResult;
    readonly feasibility: GateResult;
  };
  readonly decision: "GO" | "REVISE" | "NO-GO";
  readonly decisionTrace: readonly string[];
}

// ── Evidence store types (T-002A) ─────────────────────────────────────────────

/**
 * Run manifest stored as canonical JSON in the private run root.
 *
 * The corpus key itself is never serialized; only its SHA-256 digest
 * appears in the manifest for verification purposes.
 *
 * @see Design §2.2 — Local evidence root
 */
export interface RunManifest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly createdAt: string;
  readonly corpusKeyDigest: string;
  readonly eventCount: number;
}

/**
 * An append-only evidence event, serialized as one canonical JSONL line.
 *
 * Each event carries a stable opaque `eventId` for idempotent append and resume.
 * Failure events are retained in the log.
 */
export interface EvidenceEvent {
  readonly eventId: string;
  readonly timestamp: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly failed?: boolean;
  readonly error?: string;
}

// ── Evidence store error (moved from evidence-store.ts for T-002B) ────────────

/**
 * Structured error raised by the evidence store.
 */
export class EvidenceStoreError extends Error implements EvidenceError {
  constructor(
    public readonly code: EvalErrorCode,
    message: string,
    public readonly recordId?: string,
  ) {
    super(message);
    this.name = "EvidenceStoreError";
  }
}

/** Content-free path segments below `$PI_AGENT_DIR`. */
export const EVIDENCE_ROOT_SEGMENTS = ["blackbytes", "evaluations", "context-pruning"] as const;
