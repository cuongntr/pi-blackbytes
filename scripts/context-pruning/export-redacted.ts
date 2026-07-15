/**
 * Allowlisted local reporting and committed-safe aggregate export.
 *
 * This module deliberately constructs the export from fixed fields instead of
 * redacting a source record. Redaction is a final defence-in-depth pass, never
 * the privacy boundary.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalDigest, canonicalJson } from "./canonical-json.js";
import { corpusKeyBytes } from "./evidence-store.js";
import { verifySourceDigest } from "./source-guard.js";
import { EvidenceStoreError, SCHEMA_VERSION } from "./types.js";

export const MINIMUM_INDEPENDENT_AGGREGATE_N = 5;

const DIGEST = /^[a-f0-9]{64}$/;
const BUCKETS = ["quality", "utility", "applicability", "feasibility", "lifecycle"] as const;
const DIAGNOSTIC_KINDS = ["exclusion", "failure", "skip"] as const;
const DIAGNOSTIC_CODES = [
  "qualification-unavailable",
  "provider-missing",
  "upstream-hard-stop",
  "integrity-failed",
  "source-changed",
  "retry-exhausted",
  "fixture-unavailable",
  "not-applicable",
] as const;

type AggregateBucket = (typeof BUCKETS)[number];
type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

export interface ReportArtifact {
  /** SHA-256(canonical JSON payload), checked before any calculation. */
  readonly digest: string;
  /** Local artifact payload; it is never copied to either report. */
  readonly payload: unknown;
}

export interface SourceDigestCheck {
  /** Private local path used only for authoritative T-002B source verification. */
  readonly sourcePath: string;
  /** Path-free keyed source digest evidence captured before evaluation. */
  readonly beforeDigest: string;
  /** Path-free keyed source digest evidence observed after evaluation. */
  readonly afterDigest: string;
}

export interface AggregateObservation {
  /** Private snapshot/session identity used solely to establish independence. */
  readonly snapshotId: string;
  /** Replicate identity. Replicates never add independent observations. */
  readonly replicateIndex: number;
  readonly bucket: AggregateBucket;
  readonly value: number;
}

export interface ReportDiagnostic {
  readonly kind: DiagnosticKind;
  /** An allowlisted machine-readable reason code; no free-text diagnostics are exported. */
  readonly code: string;
}

export interface RedactedReportInput {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly outcome: "GO" | "REVISE" | "NO-GO";
  readonly artifacts: readonly ReportArtifact[];
  readonly sourceChecks: readonly SourceDigestCheck[];
  readonly observations: readonly AggregateObservation[];
  readonly diagnostics: readonly ReportDiagnostic[];
  readonly repositoryClusteringObserved: boolean;
  readonly cacheIsolationAvailable: boolean;
}

export interface AuthenticatedRedactedReportInput {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly report: RedactedReportInput;
  readonly authenticationTag: string;
}

export interface AggregateCandidate {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly outcome: "GO" | "REVISE" | "NO-GO";
  readonly aggregates: readonly (
    | { readonly bucket: AggregateBucket; readonly status: "suppressed" }
    | {
        readonly bucket: AggregateBucket;
        readonly status: "reported";
        readonly independentN: number;
        readonly mean: number;
      }
  )[];
  /** Presence only: counts stay local because they are not independently sampled aggregates. */
  readonly retainedDiagnosticKinds: readonly DiagnosticKind[];
  readonly limitations: readonly string[];
}

export interface LocalDetailedReport {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly outcome: "GO" | "REVISE" | "NO-GO";
  readonly aggregateCandidate: AggregateCandidate;
  readonly diagnostics: readonly ReportDiagnostic[];
  readonly sourceCheckCount: number;
}

export interface RedactedReport {
  readonly local: LocalDetailedReport;
  readonly candidate: AggregateCandidate;
}

function schema(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}

function integrity(message: string): never {
  throw new EvidenceStoreError("E_EVAL_INTEGRITY", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    schema(`Expected exactly fields: ${sortedExpected.join(", ")}`);
  }
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) schema(`${field} must be a SHA-256 digest`);
  return value;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) schema(`${field} must be finite`);
  return value;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) schema(`${field} must be non-empty`);
  return value;
}

function bucket(value: unknown): AggregateBucket {
  if (!BUCKETS.includes(value as AggregateBucket)) schema("observation bucket is not allowlisted");
  return value as AggregateBucket;
}

function diagnosticKind(value: unknown): DiagnosticKind {
  if (!DIAGNOSTIC_KINDS.includes(value as DiagnosticKind))
    schema("diagnostic kind is not allowlisted");
  return value as DiagnosticKind;
}

function diagnosticCode(value: unknown): string {
  const code = nonEmpty(value, "diagnostic.code");
  if (!DIAGNOSTIC_CODES.includes(code as (typeof DIAGNOSTIC_CODES)[number]))
    schema("diagnostic code is not allowlisted");
  return code;
}

/** Strict validation intentionally rejects free-form fields before report construction. */
export function validateRedactedReportInput(value: unknown): RedactedReportInput {
  if (!isRecord(value)) schema("report input must be an object");
  exactKeys(value, [
    "artifacts",
    "cacheIsolationAvailable",
    "diagnostics",
    "observations",
    "outcome",
    "repositoryClusteringObserved",
    "schemaVersion",
    "sourceChecks",
  ]);
  if (value.schemaVersion !== SCHEMA_VERSION) schema(`schemaVersion must equal ${SCHEMA_VERSION}`);
  if (value.outcome !== "GO" && value.outcome !== "REVISE" && value.outcome !== "NO-GO")
    schema("outcome is invalid");
  if (!Array.isArray(value.artifacts) || !Array.isArray(value.sourceChecks))
    schema("artifacts and sourceChecks must be arrays");
  if (!Array.isArray(value.observations) || !Array.isArray(value.diagnostics))
    schema("observations and diagnostics must be arrays");
  if (
    typeof value.repositoryClusteringObserved !== "boolean" ||
    typeof value.cacheIsolationAvailable !== "boolean"
  ) {
    schema("limitation flags must be boolean");
  }

  const artifacts = value.artifacts.map((item) => {
    if (!isRecord(item)) schema("artifact must be an object");
    exactKeys(item, ["digest", "payload"]);
    return Object.freeze({ digest: digest(item.digest, "artifact.digest"), payload: item.payload });
  });
  const sourceChecks = value.sourceChecks.map((item) => {
    if (!isRecord(item)) schema("source check must be an object");
    exactKeys(item, ["afterDigest", "beforeDigest", "sourcePath"]);
    return Object.freeze({
      sourcePath: nonEmpty(item.sourcePath, "sourceCheck.sourcePath"),
      beforeDigest: digest(item.beforeDigest, "sourceCheck.beforeDigest"),
      afterDigest: digest(item.afterDigest, "sourceCheck.afterDigest"),
    });
  });
  const observations = value.observations.map((item) => {
    if (!isRecord(item)) schema("observation must be an object");
    exactKeys(item, ["bucket", "replicateIndex", "snapshotId", "value"]);
    const replicateIndex = finite(item.replicateIndex, "observation.replicateIndex");
    if (!Number.isSafeInteger(replicateIndex) || replicateIndex < 1)
      schema("observation.replicateIndex must be a positive safe integer");
    return Object.freeze({
      snapshotId: nonEmpty(item.snapshotId, "observation.snapshotId"),
      replicateIndex,
      bucket: bucket(item.bucket),
      value: finite(item.value, "observation.value"),
    });
  });
  const diagnostics = value.diagnostics.map((item) => {
    if (!isRecord(item)) schema("diagnostic must be an object");
    exactKeys(item, ["code", "kind"]);
    return Object.freeze({
      kind: diagnosticKind(item.kind),
      code: diagnosticCode(item.code),
    });
  });
  if (artifacts.length === 0 || sourceChecks.length === 0) {
    schema("report input requires at least one artifact and one source check");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    outcome: value.outcome,
    artifacts: Object.freeze(artifacts),
    sourceChecks: Object.freeze(sourceChecks),
    observations: Object.freeze(observations),
    diagnostics: Object.freeze(diagnostics),
    repositoryClusteringObserved: value.repositoryClusteringObserved,
    cacheIsolationAvailable: value.cacheIsolationAvailable,
  });
}

const REPORT_AUTH_DOMAIN = "pi-blackbytes:context-pruning:redacted-report-input:v1";

function reportAuthenticationTag(input: RedactedReportInput, corpusKey: string): string {
  return createHmac("sha256", corpusKeyBytes(corpusKey, "E_EVAL_INTEGRITY"))
    .update(REPORT_AUTH_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(input), "utf8")
    .digest("hex");
}

/** Seal all calculation inputs with the private run key before cross-process reporting. */
export function authenticateRedactedReportInput(
  value: unknown,
  corpusKey: string,
): AuthenticatedRedactedReportInput {
  const report = validateRedactedReportInput(value);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    report,
    authenticationTag: reportAuthenticationTag(report, corpusKey),
  });
}

function validateAuthenticatedRedactedReportInput(
  value: unknown,
  corpusKey: string,
): RedactedReportInput {
  if (!isRecord(value)) schema("authenticated report input must be an object");
  exactKeys(value, ["authenticationTag", "report", "schemaVersion"]);
  if (value.schemaVersion !== SCHEMA_VERSION) schema(`schemaVersion must equal ${SCHEMA_VERSION}`);
  const authenticationTag = digest(value.authenticationTag, "authenticationTag");
  const report = validateRedactedReportInput(value.report);
  const expected = reportAuthenticationTag(report, corpusKey);
  if (!timingSafeEqual(Buffer.from(authenticationTag, "hex"), Buffer.from(expected, "hex"))) {
    integrity("Authenticated report input does not match the private run");
  }
  return report;
}

/** Refuse reporting before any aggregation when artifact evidence has drifted. */
export function verifyRedactedReportIntegrity(input: RedactedReportInput): void {
  for (const artifact of input.artifacts) {
    if (canonicalDigest(artifact.payload) !== artifact.digest)
      integrity("Report artifact digest mismatch");
  }
  for (const source of input.sourceChecks) {
    if (source.beforeDigest !== source.afterDigest)
      integrity("Source digest changed during evaluation");
  }
}

/** Re-open every original source through the T-002B digest verifier. */
export async function verifyRedactedReportSources(
  input: RedactedReportInput,
  corpusKey: string,
): Promise<void> {
  for (const source of input.sourceChecks) {
    await verifySourceDigest(source.sourcePath, corpusKey, source.beforeDigest);
  }
}

/** Final defense in depth, deliberately applied after the fixed allowlist is constructed. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\b(?:Bearer|token|secret|password)\s+[^\s]+/gi, "[REDACTED]");
}

function redactReport<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactReport) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactReport(item)]),
    ) as T;
  }
  return value;
}

function aggregateBucket(
  observations: readonly AggregateObservation[],
  selectedBucket: AggregateBucket,
): AggregateCandidate["aggregates"][number] {
  const bySnapshot = new Map<string, number[]>();
  for (const observation of observations) {
    if (observation.bucket !== selectedBucket) continue;
    const values = bySnapshot.get(observation.snapshotId) ?? [];
    values.push(observation.value);
    bySnapshot.set(observation.snapshotId, values);
  }
  if (bySnapshot.size < MINIMUM_INDEPENDENT_AGGREGATE_N) {
    return Object.freeze({ bucket: selectedBucket, status: "suppressed" as const });
  }
  const snapshotMeans = [...bySnapshot.values()].map(
    (values) => values.reduce((total, value) => total + value, 0) / values.length,
  );
  return Object.freeze({
    bucket: selectedBucket,
    status: "reported" as const,
    independentN: bySnapshot.size,
    mean: snapshotMeans.reduce((total, value) => total + value, 0) / snapshotMeans.length,
  });
}

/**
 * Build both reports only from a private-key-authenticated input. The committed
 * candidate is made only from fixed aggregate fields, then redacted; it never
 * receives IDs, diagnostics, paths, or payloads.
 */
export async function buildRedactedReport(
  value: unknown,
  corpusKey: string,
): Promise<RedactedReport> {
  const input = validateAuthenticatedRedactedReportInput(value, corpusKey);
  verifyRedactedReportIntegrity(input);
  await verifyRedactedReportSources(input, corpusKey);
  const retainedDiagnosticKinds = DIAGNOSTIC_KINDS.filter((kind) =>
    input.diagnostics.some((item) => item.kind === kind),
  );
  const limitations = [
    "Aggregate subgroups with fewer than five independent snapshots are suppressed; replicates do not increase n.",
    "Repository clustering may limit independence and generalizability.",
    "Cache isolation status is recorded; cache effects are not inferred away.",
    ...(input.repositoryClusteringObserved ? ["Repository clustering was observed."] : []),
    ...(input.cacheIsolationAvailable ? [] : ["Cache isolation was unavailable."]),
  ];
  const candidate = redactReport(
    Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      outcome: input.outcome,
      aggregates: Object.freeze(BUCKETS.map((item) => aggregateBucket(input.observations, item))),
      retainedDiagnosticKinds: Object.freeze(retainedDiagnosticKinds),
      limitations: Object.freeze(limitations),
    }),
  );
  const local = redactReport(
    Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      outcome: input.outcome,
      aggregateCandidate: candidate,
      diagnostics: Object.freeze(input.diagnostics.map((item) => Object.freeze({ ...item }))),
      sourceCheckCount: input.sourceChecks.length,
    }),
  );
  return Object.freeze({ local, candidate });
}
