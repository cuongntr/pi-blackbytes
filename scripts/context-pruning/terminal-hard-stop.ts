/** Terminal, content-free orchestration for a verified T-009B blocking outcome. */
import { Buffer } from "node:buffer";

import { canonicalDigest, canonicalJson } from "./canonical-json.js";
import {
  BREAK_EVEN_BY_5_THRESHOLD,
  REDUCTION5_PASS_THRESHOLD,
  REDUCTION5_REVISE_THRESHOLD,
} from "./cost.js";
import {
  DECISION_P95_REVISE_MAX_MS,
  MINIMUM_QUALIFYING_SNAPSHOT_COUNT,
  REQUIRED_SAMPLED_SESSION_COUNT,
} from "./decision.js";
import { CORPUS_KEY_FILENAME, hmacDigest } from "./evidence-store.js";
import { authenticateRedactedReportInput, buildRedactedReport } from "./export-redacted.js";
import { loadVerifiedT017AggregateSummary, loadVerifiedTargetSelection } from "./formal-run.js";
import { BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS } from "./lifecycle/benchmark.js";
import {
  ensurePrivateDir,
  getSafeRunId,
  safeRunFileExists,
  safeRunPublishExclusiveFile,
  safeRunReadFile,
} from "./path-safety.js";
import type { SafeRun } from "./path-safety.js";
import {
  loadT009BPrivateInputs,
  verifyPersistedGeneratedCompactionProof,
} from "./provider-runner.js";
import { RECALL_DELTA_THRESHOLD } from "./scoring.js";
import { EvidenceStoreError, SCHEMA_VERSION } from "./types.js";

const DIRECTORY = "terminal-hard-stop";
const DECISION_FILE = `${DIRECTORY}/decision.json`;
const REPORT_LOCAL_FILE = `${DIRECTORY}/report.local.json`;
const REPORT_AGGREGATE_FILE = `${DIRECTORY}/report.aggregate.json`;
const REPORT_SUPPLEMENT_FILE = `${DIRECTORY}/report-supplement-v1.json`;
const DIGEST = /^[a-f0-9]{64}$/;
const DISPOSITION_AUTH_DOMAIN = "pi-blackbytes:context-pruning:terminal-hard-stop:v2\0";

export const QUALIFICATION_RANGES = ["1-20", "21-40"] as const;
export type QualificationRange = (typeof QUALIFICATION_RANGES)[number];
export const HARD_STOP_STAGES = [
  "qualification",
  "adjudication",
  "freeze",
  "lifecycle",
  "replay",
] as const;
export type HardStopStage = (typeof HARD_STOP_STAGES)[number];
type RequiredDisposition = {
  readonly stage: HardStopStage;
  readonly range: QualificationRange | null;
};

interface HardStopDisposition {
  readonly schemaVersion: 1;
  readonly type: "terminal-hard-stop-disposition-v2";
  readonly runId: string;
  readonly stage: HardStopStage;
  readonly range: QualificationRange | null;
  readonly targetSelectionDigest: string;
  readonly upstreamResolutionDigest: string;
  readonly dispositionDigest: string;
  readonly authenticationTag: string;
}

interface HardStopDecision {
  readonly schemaVersion: 1;
  readonly type: "terminal-hard-stop-decision-v2";
  readonly runId: string;
  readonly targetSelectionDigest: string;
  readonly upstreamResolutionDigest: string;
  readonly decision: "NO-GO";
  readonly decisionTrace: readonly {
    readonly id: string;
    readonly status: "unavailable" | "blocked" | "terminal";
    readonly threshold: string;
    readonly detail: string;
  }[];
  readonly decisionDigest: string;
}

type CorpusSummary = Awaited<ReturnType<typeof loadVerifiedT017AggregateSummary>>["corpusSummary"];

interface ReportSupplement {
  readonly schemaVersion: 1;
  readonly type: "terminal-hard-stop-report-supplement-v1";
  readonly runId: string;
  readonly runManifestDigest: string;
  readonly targetSelectionDigest: string;
  readonly upstreamResolutionDigest: string;
  readonly terminalDecisionDigest: string;
  readonly inventoryDigest: string;
  readonly sampleDigest: string;
  readonly gateEvidence: {
    readonly sampleCount: {
      readonly actual: number;
      readonly required: number;
      readonly status: "passed";
    };
    readonly qualifyingSnapshots: {
      readonly required: number;
      readonly status: "blocked";
    };
  };
  readonly corpusSummary: CorpusSummary;
  readonly supplementDigest: string;
}

function fail(
  code: "E_EVAL_CONFIG" | "E_EVAL_INTEGRITY" | "E_EVAL_INCOMPLETE",
  message: string,
): never {
  throw new EvidenceStoreError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index]))
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop artifact has an invalid closed schema");
}

function requiredDispositions(): readonly RequiredDisposition[] {
  return Object.freeze([
    ...QUALIFICATION_RANGES.map((range) => ({ stage: "qualification" as const, range })),
    { stage: "adjudication" as const, range: null },
    { stage: "freeze" as const, range: null },
    { stage: "lifecycle" as const, range: null },
    { stage: "replay" as const, range: null },
  ]);
}

function dispositionPath(stage: HardStopStage, range: QualificationRange | null): string {
  return `${DIRECTORY}/${stage}${range === null ? "" : `-${range}`}.json`;
}

async function readCanonical(safeRun: SafeRun, path: string): Promise<unknown> {
  const raw = (await safeRunReadFile(safeRun, path)).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop artifact is malformed");
  }
  if (canonicalJson(value) !== raw)
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop artifact is noncanonical");
  return value;
}

async function verifiedBlockingResolution(
  safeRun: SafeRun,
  runId: string,
  expectedDigest?: string,
): Promise<{ readonly resolutionDigest: string; readonly targetSelectionDigest: string }> {
  if (getSafeRunId(safeRun) !== runId)
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop run ID does not match the verified run manifest");
  if (expectedDigest !== undefined && !DIGEST.test(expectedDigest))
    fail("E_EVAL_CONFIG", "--not-applicable must be a lowercase SHA-256 digest");
  // This validates the sampling lock, target runId, and immutable HMAC-sealed target anchor.
  const target = await loadVerifiedTargetSelection(safeRun);
  if (target.runId !== runId)
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop target does not belong to the verified run");
  const inputs = await loadT009BPrivateInputs(safeRun, target);
  const resolution = await verifyPersistedGeneratedCompactionProof({ safeRun, ...inputs });
  if (resolution.outcome !== "blocking-incomplete")
    fail("E_EVAL_INCOMPLETE", "Terminal hard-stop requires verified T-009B blocking-incomplete");
  if (expectedDigest !== undefined && resolution.resolutionDigest !== expectedDigest)
    fail(
      "E_EVAL_INTEGRITY",
      "--not-applicable does not match this run's verified T-009B resolution",
    );
  return Object.freeze({
    resolutionDigest: resolution.resolutionDigest,
    targetSelectionDigest: canonicalDigest(target),
  });
}

/** Determine whether a verified same-run T-009B blocker exists without opening sampled content. */
export async function hasVerifiedBlockingIncomplete(
  safeRun: SafeRun,
  runId: string,
): Promise<boolean> {
  // Runs that have not reached immutable target selection cannot have a verified T-009B outcome.
  // This preserves ordinary pre-proof behavior without opening a stage input.
  if (!(await safeRunFileExists(safeRun, "target-selection.json"))) return false;
  try {
    await verifiedBlockingResolution(safeRun, runId);
    return true;
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError && error.code === "E_EVAL_INCOMPLETE") return false;
    throw error;
  }
}

function dispositionUnsigned(
  runId: string,
  stage: HardStopStage,
  range: QualificationRange | null,
  resolutionDigest: string,
  targetSelectionDigest: string,
) {
  const base = {
    schemaVersion: 1 as const,
    type: "terminal-hard-stop-disposition-v2" as const,
    runId,
    stage,
    range,
    targetSelectionDigest,
    upstreamResolutionDigest: resolutionDigest,
  };
  return Object.freeze({
    ...base,
    dispositionDigest: canonicalDigest({
      domain: "terminal-hard-stop-disposition-v2",
      disposition: base,
    }),
  });
}

function makeDisposition(
  corpusKey: string,
  runId: string,
  stage: HardStopStage,
  range: QualificationRange | null,
  resolutionDigest: string,
  targetSelectionDigest: string,
): HardStopDisposition {
  const unsigned = dispositionUnsigned(
    runId,
    stage,
    range,
    resolutionDigest,
    targetSelectionDigest,
  );
  return Object.freeze({
    ...unsigned,
    authenticationTag: hmacDigest(
      corpusKey,
      Buffer.from(`${DISPOSITION_AUTH_DOMAIN}${canonicalJson(unsigned)}`, "utf8"),
    ),
  });
}

function validateDisposition(
  value: unknown,
  corpusKey: string,
  runId: string,
  stage: HardStopStage,
  range: QualificationRange | null,
  resolutionDigest: string,
  targetSelectionDigest: string,
): HardStopDisposition {
  if (!isRecord(value)) fail("E_EVAL_INTEGRITY", "Terminal hard-stop disposition is invalid");
  exactKeys(value, [
    "authenticationTag",
    "dispositionDigest",
    "range",
    "runId",
    "schemaVersion",
    "stage",
    "targetSelectionDigest",
    "type",
    "upstreamResolutionDigest",
  ]);
  const expected = makeDisposition(
    corpusKey,
    runId,
    stage,
    range,
    resolutionDigest,
    targetSelectionDigest,
  );
  if (canonicalJson(value) !== canonicalJson(expected))
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop disposition authentication or binding is invalid");
  return expected;
}

/** Record exactly one authenticated, content-free downstream non-applicable stage. */
export async function recordHardStopDisposition(input: {
  readonly safeRun: SafeRun;
  readonly runId: string;
  readonly stage: HardStopStage;
  readonly range: QualificationRange | null;
  readonly upstreamResolutionDigest: string;
}): Promise<HardStopDisposition> {
  if ((input.stage === "qualification") !== (input.range !== null))
    fail("E_EVAL_CONFIG", "Only qualification dispositions carry an exact rank range");
  const upstream = await verifiedBlockingResolution(
    input.safeRun,
    input.runId,
    input.upstreamResolutionDigest,
  );
  const corpusKey = (await safeRunReadFile(input.safeRun, CORPUS_KEY_FILENAME)).toString("utf8");
  const disposition = makeDisposition(
    corpusKey,
    input.runId,
    input.stage,
    input.range,
    upstream.resolutionDigest,
    upstream.targetSelectionDigest,
  );
  await ensurePrivateDir(input.safeRun, DIRECTORY);
  if (
    !(await safeRunPublishExclusiveFile(
      input.safeRun,
      dispositionPath(input.stage, input.range),
      canonicalJson(disposition),
    ))
  ) {
    fail(
      "E_EVAL_INTEGRITY",
      "Terminal hard-stop disposition already exists; duplicate writes are forbidden",
    );
  }
  return disposition;
}

export async function loadTerminalHardStopDigest(safeRun: SafeRun, runId: string): Promise<string> {
  const path = dispositionPath("qualification", "1-20");
  if (!(await safeRunFileExists(safeRun, path)))
    fail("E_EVAL_INCOMPLETE", "Terminal hard-stop T-018 qualification disposition is missing");
  const value = await readCanonical(safeRun, path);
  if (
    !isRecord(value) ||
    typeof value.upstreamResolutionDigest !== "string" ||
    !DIGEST.test(value.upstreamResolutionDigest)
  )
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop T-018 qualification disposition is invalid");
  const upstream = await verifiedBlockingResolution(safeRun, runId, value.upstreamResolutionDigest);
  const key = (await safeRunReadFile(safeRun, CORPUS_KEY_FILENAME)).toString("utf8");
  validateDisposition(
    value,
    key,
    runId,
    "qualification",
    "1-20",
    upstream.resolutionDigest,
    upstream.targetSelectionDigest,
  );
  return upstream.resolutionDigest;
}

async function verifiedDispositions(
  safeRun: SafeRun,
  runId: string,
  digest: string,
  requireComplete = true,
): Promise<readonly HardStopDisposition[]> {
  const upstream = await verifiedBlockingResolution(safeRun, runId, digest);
  const corpusKey = (await safeRunReadFile(safeRun, CORPUS_KEY_FILENAME)).toString("utf8");
  const records: HardStopDisposition[] = [];
  let missingSeen = false;
  for (const { stage, range } of requiredDispositions()) {
    const path = dispositionPath(stage, range);
    if (!(await safeRunFileExists(safeRun, path))) {
      if (requireComplete)
        fail(
          "E_EVAL_INCOMPLETE",
          `Terminal hard-stop disposition is missing for ${stage}${range === null ? "" : ` ${range}`}`,
        );
      missingSeen = true;
      continue;
    }
    if (missingSeen)
      fail("E_EVAL_INTEGRITY", "Terminal hard-stop dispositions are not a contiguous stage prefix");
    records.push(
      validateDisposition(
        await readCanonical(safeRun, path),
        corpusKey,
        runId,
        stage,
        range,
        upstream.resolutionDigest,
        upstream.targetSelectionDigest,
      ),
    );
  }
  return Object.freeze(records);
}

/** A mechanical terminal trace: no measurement values are fabricated after T-009B blocks evidence. */
function makeDecision(
  runId: string,
  digest: string,
  targetSelectionDigest: string,
): HardStopDecision {
  const blocker =
    "verified same-run T-009B blocking-incomplete; downstream evidence was not collected";
  const unsigned = {
    schemaVersion: 1 as const,
    type: "terminal-hard-stop-decision-v2" as const,
    runId,
    targetSelectionDigest,
    upstreamResolutionDigest: digest,
    decision: "NO-GO" as const,
    decisionTrace: Object.freeze([
      {
        id: "G001.recall",
        status: "unavailable",
        threshold: `>= ${RECALL_DELTA_THRESHOLD}`,
        detail: blocker,
      },
      { id: "G001.completion", status: "unavailable", threshold: ">= 0", detail: blocker },
      {
        id: "G001.severe-event",
        status: "unavailable",
        threshold: "must be false",
        detail: blocker,
      },
      {
        id: "G002.actual-usage",
        status: "blocked",
        threshold: "complete attributable usage",
        detail: blocker,
      },
      {
        id: "G002.median-reduction",
        status: "unavailable",
        threshold: `>= ${REDUCTION5_PASS_THRESHOLD}`,
        detail: blocker,
      },
      {
        id: "G002.break-even-by-5",
        status: "unavailable",
        threshold: `>= ${BREAK_EVEN_BY_5_THRESHOLD}`,
        detail: blocker,
      },
      {
        id: "G003.sample-count",
        status: "blocked",
        threshold: `= ${REQUIRED_SAMPLED_SESSION_COUNT}`,
        detail: blocker,
      },
      {
        id: "G003.qualifying-snapshots",
        status: "blocked",
        threshold: `>= ${MINIMUM_QUALIFYING_SNAPSHOT_COUNT}`,
        detail: blocker,
      },
      {
        id: "G004.provenance",
        status: "unavailable",
        threshold: "= 0 false positives",
        detail: blocker,
      },
      {
        id: "G004.lifecycle-scenarios",
        status: "unavailable",
        threshold: "= 0 misses",
        detail: blocker,
      },
      {
        id: "G004.p95",
        status: "unavailable",
        threshold: `< ${BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS}ms`,
        detail: blocker,
      },
      {
        id: "REVISE.utility",
        status: "unavailable",
        threshold: `[${REDUCTION5_REVISE_THRESHOLD}, ${REDUCTION5_PASS_THRESHOLD}) with break-even >= ${BREAK_EVEN_BY_5_THRESHOLD}`,
        detail: blocker,
      },
      {
        id: "REVISE.performance",
        status: "unavailable",
        threshold: `[${BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS}ms, ${DECISION_P95_REVISE_MAX_MS}ms] with non-invasive optimization`,
        detail: blocker,
      },
      {
        id: "REVISE.lifecycle",
        status: "unavailable",
        threshold: "one non-provenance miss with non-invasive fix",
        detail: blocker,
      },
      {
        id: "REVISE.provider-data",
        status: "blocked",
        threshold: "one permitted collection extension",
        detail: blocker,
      },
      {
        id: "REVISE.exactly-one-deviation",
        status: "blocked",
        threshold: "exactly one permitted deviation",
        detail: blocker,
      },
      {
        id: "OUTCOME",
        status: "terminal",
        threshold: "any blocked required gate => NO-GO",
        detail: "NO-GO",
      },
    ] satisfies HardStopDecision["decisionTrace"]),
  };
  return Object.freeze({
    ...unsigned,
    decisionDigest: canonicalDigest({
      domain: "terminal-hard-stop-decision-v2",
      decision: unsigned,
    }),
  });
}

async function verifiedDecision(
  safeRun: SafeRun,
  runId: string,
  digest: string,
): Promise<HardStopDecision> {
  await verifiedDispositions(safeRun, runId, digest);
  const upstream = await verifiedBlockingResolution(safeRun, runId, digest);
  if (!(await safeRunFileExists(safeRun, DECISION_FILE)))
    fail("E_EVAL_INCOMPLETE", "Terminal hard-stop decision is missing");
  const decision = makeDecision(runId, digest, upstream.targetSelectionDigest);
  if (canonicalJson(await readCanonical(safeRun, DECISION_FILE)) !== canonicalJson(decision))
    fail(
      "E_EVAL_INTEGRITY",
      "Terminal hard-stop decision is invalid, overridden, or from another run",
    );
  return decision;
}

/** Create the sole non-overridable NO-GO decision after every downstream disposition exists. */
export async function decideTerminalHardStop(input: {
  readonly safeRun: SafeRun;
  readonly runId: string;
  readonly upstreamResolutionDigest: string;
}): Promise<HardStopDecision> {
  await verifiedDispositions(input.safeRun, input.runId, input.upstreamResolutionDigest);
  const upstream = await verifiedBlockingResolution(
    input.safeRun,
    input.runId,
    input.upstreamResolutionDigest,
  );
  const decision = makeDecision(
    input.runId,
    upstream.resolutionDigest,
    upstream.targetSelectionDigest,
  );
  if (!(await safeRunPublishExclusiveFile(input.safeRun, DECISION_FILE, canonicalJson(decision))))
    fail(
      "E_EVAL_INTEGRITY",
      "Terminal hard-stop decision already exists; duplicate or override writes are forbidden",
    );
  return decision;
}

function reportInput(decision: HardStopDecision, dispositions: readonly HardStopDisposition[]) {
  const artifacts = [decision, ...dispositions].map((payload) => ({
    digest: canonicalDigest(payload),
    payload,
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    outcome: "NO-GO" as const,
    artifacts,
    sourceChecks: [],
    observations: [],
    diagnostics: [
      { kind: "skip" as const, code: "upstream-hard-stop" },
      { kind: "skip" as const, code: "not-applicable" },
    ],
    repositoryClusteringObserved: false,
    cacheIsolationAvailable: false,
  };
}

async function publishOrVerifyIdentical(
  safeRun: SafeRun,
  path: string,
  value: unknown,
): Promise<void> {
  const content = canonicalJson(value);
  if (await safeRunPublishExclusiveFile(safeRun, path, content)) return;
  if ((await safeRunReadFile(safeRun, path)).toString("utf8") !== content)
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop report output conflicts with the verified result");
}

async function verifiedRunManifestDigest(safeRun: SafeRun, runId: string): Promise<string> {
  const manifest = await readCanonical(safeRun, "manifest.json");
  if (!isRecord(manifest) || manifest.runId !== runId)
    fail("E_EVAL_INTEGRITY", "Terminal supplement run manifest is invalid");
  return canonicalDigest(manifest);
}

function makeReportSupplement(input: {
  readonly runId: string;
  readonly runManifestDigest: string;
  readonly upstreamResolutionDigest: string;
  readonly decision: HardStopDecision;
  readonly corpusSummary: Awaited<ReturnType<typeof loadVerifiedT017AggregateSummary>>;
}): ReportSupplement {
  const { decision, corpusSummary } = input;
  if (
    decision.runId !== input.runId ||
    decision.upstreamResolutionDigest !== input.upstreamResolutionDigest ||
    decision.targetSelectionDigest !== corpusSummary.targetSelectionDigest
  )
    fail("E_EVAL_INTEGRITY", "Terminal supplement bindings do not match the verified decision");
  const unsigned = {
    schemaVersion: 1 as const,
    type: "terminal-hard-stop-report-supplement-v1" as const,
    runId: input.runId,
    runManifestDigest: input.runManifestDigest,
    targetSelectionDigest: corpusSummary.targetSelectionDigest,
    upstreamResolutionDigest: input.upstreamResolutionDigest,
    terminalDecisionDigest: canonicalDigest(decision),
    inventoryDigest: corpusSummary.inventoryDigest,
    sampleDigest: corpusSummary.sampleDigest,
    gateEvidence: Object.freeze({
      sampleCount: Object.freeze({
        actual: corpusSummary.corpusSummary.sampleSize,
        required: REQUIRED_SAMPLED_SESSION_COUNT,
        status: "passed" as const,
      }),
      qualifyingSnapshots: Object.freeze({
        required: MINIMUM_QUALIFYING_SNAPSHOT_COUNT,
        status: "blocked" as const,
      }),
    }),
    corpusSummary: corpusSummary.corpusSummary,
  };
  if (unsigned.gateEvidence.sampleCount.actual !== unsigned.gateEvidence.sampleCount.required)
    fail("E_EVAL_INTEGRITY", "Terminal supplement sample-count evidence is not a pass");
  return Object.freeze({
    ...unsigned,
    supplementDigest: canonicalDigest({
      domain: "terminal-hard-stop-report-supplement-v1",
      supplement: unsigned,
    }),
  });
}

async function verifiedReportSupplement(input: {
  readonly safeRun: SafeRun;
  readonly runId: string;
  readonly upstreamResolutionDigest: string;
  readonly decision: HardStopDecision;
}): Promise<ReportSupplement> {
  const corpusSummary = await loadVerifiedT017AggregateSummary(input.safeRun);
  const runManifestDigest = await verifiedRunManifestDigest(input.safeRun, input.runId);
  const expected = makeReportSupplement({ ...input, corpusSummary, runManifestDigest });
  if (!(await safeRunFileExists(input.safeRun, REPORT_SUPPLEMENT_FILE)))
    fail("E_EVAL_INCOMPLETE", "Terminal hard-stop report supplement is missing");
  if (
    canonicalJson(await readCanonical(input.safeRun, REPORT_SUPPLEMENT_FILE)) !==
    canonicalJson(expected)
  )
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop report supplement is invalid");
  return expected;
}

/** Build content-free local and committed-safe reports; a partial prior publication resumes safely. */
export async function reportTerminalHardStop(input: {
  readonly safeRun: SafeRun;
  readonly runId: string;
  readonly upstreamResolutionDigest: string;
}) {
  const decision = await verifiedDecision(
    input.safeRun,
    input.runId,
    input.upstreamResolutionDigest,
  );
  const dispositions = await verifiedDispositions(
    input.safeRun,
    input.runId,
    input.upstreamResolutionDigest,
  );
  const corpusKey = (await safeRunReadFile(input.safeRun, CORPUS_KEY_FILENAME)).toString("utf8");
  const report = await buildRedactedReport(
    authenticateRedactedReportInput(reportInput(decision, dispositions), corpusKey),
    corpusKey,
  );
  await publishOrVerifyIdentical(input.safeRun, REPORT_LOCAL_FILE, report.local);
  await publishOrVerifyIdentical(input.safeRun, REPORT_AGGREGATE_FILE, report.candidate);
  const corpusSummary = await loadVerifiedT017AggregateSummary(input.safeRun);
  const runManifestDigest = await verifiedRunManifestDigest(input.safeRun, input.runId);
  const supplement = makeReportSupplement({ ...input, decision, corpusSummary, runManifestDigest });
  await publishOrVerifyIdentical(input.safeRun, REPORT_SUPPLEMENT_FILE, supplement);
  return Object.freeze({
    ...report,
    candidate: Object.freeze({ ...report.candidate, corpusSummary: corpusSummary.corpusSummary }),
  });
}

/** Verify a contiguous hard-stop stage prefix or the complete terminal report chain. */
export async function verifyTerminalHardStop(input: {
  readonly safeRun: SafeRun;
  readonly runId: string;
  readonly upstreamResolutionDigest: string;
}): Promise<
  | {
      readonly status: "verified";
      readonly terminal: "hard-stop-in-progress";
      readonly report: "pending";
      readonly verifiedDispositions: number;
      readonly nextStage: string;
    }
  | {
      readonly status: "verified";
      readonly terminal: "NO-GO";
      readonly report: "verified";
    }
> {
  const required = requiredDispositions();
  const dispositions = await verifiedDispositions(
    input.safeRun,
    input.runId,
    input.upstreamResolutionDigest,
    false,
  );
  if (dispositions.length === 0)
    fail("E_EVAL_INCOMPLETE", "Terminal hard-stop T-018 qualification disposition is missing");
  if (dispositions.length < required.length) {
    if (
      (await safeRunFileExists(input.safeRun, DECISION_FILE)) ||
      (await safeRunFileExists(input.safeRun, REPORT_LOCAL_FILE)) ||
      (await safeRunFileExists(input.safeRun, REPORT_AGGREGATE_FILE)) ||
      (await safeRunFileExists(input.safeRun, REPORT_SUPPLEMENT_FILE))
    )
      fail("E_EVAL_INTEGRITY", "Terminal outputs exist before all dispositions are verified");
    const next = required[dispositions.length]!;
    return Object.freeze({
      status: "verified" as const,
      terminal: "hard-stop-in-progress" as const,
      report: "pending" as const,
      verifiedDispositions: dispositions.length,
      nextStage: `${next.stage}${next.range === null ? "" : ` ${next.range}`}`,
    });
  }
  if (!(await safeRunFileExists(input.safeRun, DECISION_FILE))) {
    if (
      (await safeRunFileExists(input.safeRun, REPORT_LOCAL_FILE)) ||
      (await safeRunFileExists(input.safeRun, REPORT_AGGREGATE_FILE)) ||
      (await safeRunFileExists(input.safeRun, REPORT_SUPPLEMENT_FILE))
    )
      fail("E_EVAL_INTEGRITY", "Terminal report exists before the decision is verified");
    return Object.freeze({
      status: "verified" as const,
      terminal: "hard-stop-in-progress" as const,
      report: "pending" as const,
      verifiedDispositions: dispositions.length,
      nextStage: "decide",
    });
  }
  const decision = await verifiedDecision(
    input.safeRun,
    input.runId,
    input.upstreamResolutionDigest,
  );
  const corpusKey = (await safeRunReadFile(input.safeRun, CORPUS_KEY_FILENAME)).toString("utf8");
  const report = await buildRedactedReport(
    authenticateRedactedReportInput(reportInput(decision, dispositions), corpusKey),
    corpusKey,
  );
  if (!(await safeRunFileExists(input.safeRun, REPORT_LOCAL_FILE))) {
    if (await safeRunFileExists(input.safeRun, REPORT_AGGREGATE_FILE))
      fail("E_EVAL_INTEGRITY", "Aggregate terminal report exists before the local report");
    return Object.freeze({
      status: "verified" as const,
      terminal: "hard-stop-in-progress" as const,
      report: "pending" as const,
      verifiedDispositions: dispositions.length,
      nextStage: "report",
    });
  }
  if (
    canonicalJson(await readCanonical(input.safeRun, REPORT_LOCAL_FILE)) !==
    canonicalJson(report.local)
  )
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop local report is invalid");
  if (!(await safeRunFileExists(input.safeRun, REPORT_AGGREGATE_FILE))) {
    return Object.freeze({
      status: "verified" as const,
      terminal: "hard-stop-in-progress" as const,
      report: "pending" as const,
      verifiedDispositions: dispositions.length,
      nextStage: "report",
    });
  }
  if (
    canonicalJson(await readCanonical(input.safeRun, REPORT_AGGREGATE_FILE)) !==
    canonicalJson(report.candidate)
  )
    fail("E_EVAL_INTEGRITY", "Terminal hard-stop aggregate report is invalid");
  if (!(await safeRunFileExists(input.safeRun, REPORT_SUPPLEMENT_FILE)))
    return Object.freeze({
      status: "verified" as const,
      terminal: "hard-stop-in-progress" as const,
      report: "pending" as const,
      verifiedDispositions: dispositions.length,
      nextStage: "report",
    });
  await verifiedReportSupplement({ ...input, decision });
  return Object.freeze({
    status: "verified" as const,
    terminal: "NO-GO" as const,
    report: "verified" as const,
  });
}
