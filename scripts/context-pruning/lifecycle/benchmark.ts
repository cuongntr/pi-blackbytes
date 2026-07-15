/** Evaluation-only lifecycle benchmark orchestration. Real process execution belongs to T-021. */

import { readFile } from "node:fs/promises";

import { canonicalDigest } from "../canonical-json.js";
import { appendEvent } from "../evidence-store.js";
import type { SafeRun } from "../path-safety.js";
import { EvidenceStoreError } from "../types.js";
import {
  CANONICAL_PI_PACKAGE,
  lifecycleEnvironmentDigest,
  parseLifecycleMatrixMetadata,
  probePiBinaryVersion,
  validatePinnedPiInstallation,
} from "./runner.js";
import type {
  InstallationReader,
  LifecycleChildEnvironment,
  LifecycleMatrixMetadata,
  PiVersionProbe,
  ValidatedPiInstallation,
} from "./runner.js";

export const BENCHMARK_WARMUP_ITERATIONS = 100;
export const BENCHMARK_MEASURED_ITERATIONS = 1_000;
export const BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS = 25;
export const BENCHMARK_EVIDENCE_PATH = "benchmarks.jsonl";
export const BENCHMARK_RESULT_EVENT_TYPE = "lifecycle-benchmark-result-v1";
export const BENCHMARK_GATE_EVENT_TYPE = "lifecycle-benchmark-gate-v1";

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_ENV_VALUE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export interface BenchmarkFixture<TPayload = unknown> {
  readonly fixtureId: string;
  readonly sourceDigest: string;
  readonly modelVisibleBytes: number;
  /** Private payload copied into one isolated process; never persisted in evidence. */
  readonly payload: TPayload;
}

export interface BenchmarkProcessRequest<TPayload = unknown> {
  readonly installation: ValidatedPiInstallation;
  readonly fixture: BenchmarkFixture<TPayload>;
  readonly cellId: string;
  readonly warmupIterations: typeof BENCHMARK_WARMUP_ITERATIONS;
  readonly measuredIterations: typeof BENCHMARK_MEASURED_ITERATIONS;
}

export interface BenchmarkProcessResult {
  readonly warmupInvocations: number;
  readonly measuredInvocations: number;
  readonly coldStartAbsoluteMs: number;
  readonly coldStartNoOpMs: number;
  readonly absoluteSamplesMs: readonly number[];
  readonly noOpSamplesMs: readonly number[];
  readonly childEnvironment: LifecycleChildEnvironment;
}

export type IsolatedBenchmarkExecutor<TPayload = unknown> = (
  request: BenchmarkProcessRequest<TPayload>,
) => Promise<BenchmarkProcessResult>;

export interface LatencyPercentiles {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface BenchmarkResult {
  readonly matrixAttemptId: string;
  readonly fixtureId: string;
  readonly sourceDigest: string;
  readonly modelVisibleBytes: number;
  readonly mandatoryLargestFixture: boolean;
  readonly installationId: string;
  readonly piVersion: string;
  readonly coldStart: {
    readonly absoluteMs: number;
    readonly noOpMs: number;
    readonly adjustedMs: number;
  };
  readonly absolute: LatencyPercentiles;
  readonly noOpAdjusted: LatencyPercentiles;
  readonly environmentDigest: string;
}

export interface BenchmarkGate {
  readonly pass: boolean;
  readonly maxAbsoluteP95Ms: number;
  readonly thresholdMs: typeof BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS;
  readonly resultCount: number;
}

export interface BenchmarkRunResult {
  readonly results: readonly BenchmarkResult[];
  readonly gate: BenchmarkGate;
}

export interface BenchmarkRunRequest<TPayload = unknown> extends LifecycleMatrixMetadata {
  readonly safeRun: SafeRun;
  readonly matrixAttemptId: string;
  readonly eventTimestamp: string;
  readonly fixtures: readonly BenchmarkFixture<TPayload>[];
  readonly largestFixtureId: string;
  readonly executeIsolatedBenchmark: IsolatedBenchmarkExecutor<TPayload>;
  readonly reader?: InstallationReader;
  readonly probeVersion?: PiVersionProbe;
}

function schema(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}

function integrity(message: string): never {
  throw new EvidenceStoreError("E_EVAL_INTEGRITY", message);
}

function assertFiniteLatency(value: number): void {
  if (!Number.isFinite(value) || value < 0)
    integrity("Benchmark latency must be finite and non-negative");
}

/** Nearest-rank percentile: sorted sample at ceil(p * n), with ranks starting at one. */
export function nearestRankPercentile(samples: readonly number[], percentile: number): number {
  if (samples.length === 0 || !Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    schema("Nearest-rank percentile requires samples and 0 < percentile <= 1");
  }
  for (const sample of samples) assertFiniteLatency(sample);
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

export function summarizeLatencies(samples: readonly number[]): LatencyPercentiles {
  return Object.freeze({
    p50Ms: nearestRankPercentile(samples, 0.5),
    p95Ms: nearestRankPercentile(samples, 0.95),
    maxMs: nearestRankPercentile(samples, 1),
  });
}

/** Deterministic largest selection: bytes descending, fixture ID ascending for ties. */
export function selectLargestBenchmarkFixture<TPayload>(
  fixtures: readonly BenchmarkFixture<TPayload>[],
): BenchmarkFixture<TPayload> {
  if (fixtures.length === 0) schema("Benchmark requires at least one fixture");
  return [...fixtures].sort((left, right) => {
    const sizeOrder = right.modelVisibleBytes - left.modelVisibleBytes;
    if (sizeOrder !== 0) return sizeOrder;
    return left.fixtureId < right.fixtureId ? -1 : left.fixtureId > right.fixtureId ? 1 : 0;
  })[0];
}

export function evaluateBenchmarkGate(results: readonly BenchmarkResult[]): BenchmarkGate {
  if (results.length === 0) schema("Benchmark gate requires per-fixture results");
  const maxAbsoluteP95Ms = Math.max(...results.map((result) => result.absolute.p95Ms));
  return Object.freeze({
    pass: maxAbsoluteP95Ms < BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS,
    maxAbsoluteP95Ms,
    thresholdMs: BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS,
    resultCount: results.length,
  });
}

function validateAttempt(matrixAttemptId: string, eventTimestamp: string): void {
  if (!SAFE_ID.test(matrixAttemptId)) schema("Benchmark matrixAttemptId is invalid");
  const parsed = new Date(eventTimestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== eventTimestamp) {
    schema("Benchmark eventTimestamp must be an exact ISO-8601 instant");
  }
}

function validateFixtures<TPayload>(
  fixtures: readonly BenchmarkFixture<TPayload>[],
  largestFixtureId: string,
): void {
  if (
    fixtures.length === 0 ||
    new Set(fixtures.map((fixture) => fixture.fixtureId)).size !== fixtures.length
  ) {
    schema("Benchmark fixtures must be non-empty with unique IDs");
  }
  for (const fixture of fixtures) {
    if (
      !SAFE_ID.test(fixture.fixtureId) ||
      !DIGEST.test(fixture.sourceDigest) ||
      !Number.isSafeInteger(fixture.modelVisibleBytes) ||
      fixture.modelVisibleBytes <= 0
    ) {
      schema("Benchmark fixture metadata is invalid");
    }
  }
  if (selectLargestBenchmarkFixture(fixtures).fixtureId !== largestFixtureId) {
    integrity("Declared largest benchmark fixture does not match deterministic selection");
  }
}

function validateProcessResult(
  processResult: BenchmarkProcessResult,
  installation: ValidatedPiInstallation,
  isolationIds: Set<string>,
): void {
  if (
    processResult.warmupInvocations !== BENCHMARK_WARMUP_ITERATIONS ||
    processResult.measuredInvocations !== BENCHMARK_MEASURED_ITERATIONS ||
    processResult.absoluteSamplesMs.length !== BENCHMARK_MEASURED_ITERATIONS ||
    processResult.noOpSamplesMs.length !== BENCHMARK_MEASURED_ITERATIONS
  ) {
    integrity("Isolated benchmark did not execute the fixed warmup/measurement protocol");
  }
  assertFiniteLatency(processResult.coldStartAbsoluteMs);
  assertFiniteLatency(processResult.coldStartNoOpMs);
  for (const sample of processResult.absoluteSamplesMs) assertFiniteLatency(sample);
  for (const sample of processResult.noOpSamplesMs) assertFiniteLatency(sample);
  const child = processResult.childEnvironment;
  if (
    !SAFE_ID.test(child.isolationId) ||
    !SAFE_ENV_VALUE.test(child.piVersion) ||
    !SAFE_ENV_VALUE.test(child.nodeVersion) ||
    !SAFE_ENV_VALUE.test(child.platform) ||
    !SAFE_ENV_VALUE.test(child.architecture) ||
    child.piVersion !== installation.version
  ) {
    integrity("Isolated benchmark returned invalid child environment metadata");
  }
  if (isolationIds.has(child.isolationId))
    integrity("Benchmark process isolation identity was reused");
  isolationIds.add(child.isolationId);
}

function resultEvent(result: BenchmarkResult, timestamp: string, cellId: string) {
  return {
    eventId: canonicalDigest({
      cellId,
      matrixAttemptId: result.matrixAttemptId,
      type: BENCHMARK_RESULT_EVENT_TYPE,
    }),
    timestamp,
    type: BENCHMARK_RESULT_EVENT_TYPE,
    data: { ...result },
  };
}

function gateEvent(gate: BenchmarkGate, timestamp: string, matrixAttemptId: string) {
  return {
    eventId: canonicalDigest({ matrixAttemptId, type: BENCHMARK_GATE_EVENT_TYPE }),
    timestamp,
    type: BENCHMARK_GATE_EVENT_TYPE,
    data: { matrixAttemptId, ...gate },
  };
}

/** Run one fresh isolated process per fixture/version and persist aggregate timings only. */
export async function runLifecycleBenchmark<TPayload>(
  request: BenchmarkRunRequest<TPayload>,
): Promise<BenchmarkRunResult> {
  validateAttempt(request.matrixAttemptId, request.eventTimestamp);
  const metadata = parseLifecycleMatrixMetadata({
    installations: request.installations,
    protocolPins: request.protocolPins,
  });
  validateFixtures(request.fixtures, request.largestFixtureId);
  const reader = request.reader ?? { readFile };
  const probeVersion = request.probeVersion ?? probePiBinaryVersion;
  const pinById = new Map(metadata.protocolPins.map((pin) => [pin.id, pin]));
  const installations = await Promise.all(
    metadata.installations.map((installation) =>
      validatePinnedPiInstallation(
        installation,
        pinById.get(installation.id)!,
        reader,
        probeVersion,
      ),
    ),
  );

  const results: BenchmarkResult[] = [];
  const isolationIds = new Set<string>();
  for (const installation of installations) {
    for (const fixture of request.fixtures) {
      const cellId = canonicalDigest({
        fixtureId: fixture.fixtureId,
        installationId: installation.id,
        matrixAttemptId: request.matrixAttemptId,
      });
      const privateFixture = structuredClone(fixture);
      const processResult = await request.executeIsolatedBenchmark({
        installation,
        fixture: privateFixture,
        cellId,
        warmupIterations: BENCHMARK_WARMUP_ITERATIONS,
        measuredIterations: BENCHMARK_MEASURED_ITERATIONS,
      });
      validateProcessResult(processResult, installation, isolationIds);
      const adjustedSamples = processResult.absoluteSamplesMs.map((sample, index) =>
        Math.max(0, sample - processResult.noOpSamplesMs[index]),
      );
      const result: BenchmarkResult = Object.freeze({
        matrixAttemptId: request.matrixAttemptId,
        fixtureId: fixture.fixtureId,
        sourceDigest: fixture.sourceDigest,
        modelVisibleBytes: fixture.modelVisibleBytes,
        mandatoryLargestFixture: fixture.fixtureId === request.largestFixtureId,
        installationId: installation.id,
        piVersion: installation.version,
        coldStart: {
          absoluteMs: processResult.coldStartAbsoluteMs,
          noOpMs: processResult.coldStartNoOpMs,
          adjustedMs: Math.max(
            0,
            processResult.coldStartAbsoluteMs - processResult.coldStartNoOpMs,
          ),
        },
        absolute: summarizeLatencies(processResult.absoluteSamplesMs),
        noOpAdjusted: summarizeLatencies(adjustedSamples),
        environmentDigest: lifecycleEnvironmentDigest(installation, processResult.childEnvironment),
      });
      await appendEvent(
        request.safeRun,
        BENCHMARK_EVIDENCE_PATH,
        resultEvent(result, request.eventTimestamp, cellId),
      );
      results.push(result);
    }
  }
  const gate = evaluateBenchmarkGate(results);
  await appendEvent(
    request.safeRun,
    BENCHMARK_EVIDENCE_PATH,
    gateEvent(gate, request.eventTimestamp, request.matrixAttemptId),
  );
  return Object.freeze({ results: Object.freeze(results), gate });
}

export function requireT021RealBenchmarkExecutor(): never {
  throw new EvidenceStoreError(
    "E_EVAL_INCOMPLETE",
    `T-021 must supply ${CANONICAL_PI_PACKAGE} isolated benchmark processes and the selected largest fixture`,
  );
}
