import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { atomicManifestWrite, corpusKeyDigest, loadOrCreateCorpusKey } from "../evidence-store.js";
import {
  BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS,
  BENCHMARK_EVIDENCE_PATH,
  BENCHMARK_MEASURED_ITERATIONS,
  BENCHMARK_WARMUP_ITERATIONS,
  evaluateBenchmarkGate,
  nearestRankPercentile,
  runLifecycleBenchmark,
  selectLargestBenchmarkFixture,
  summarizeLatencies,
} from "../lifecycle/benchmark.js";
import type {
  BenchmarkFixture,
  BenchmarkProcessRequest,
  BenchmarkResult,
} from "../lifecycle/benchmark.js";
import { CANONICAL_PI_PACKAGE, PI_074_VERSION } from "../lifecycle/runner.js";
import type {
  LifecycleMatrixMetadata,
  PiInstallationPin,
  PinnedPiInstallation,
} from "../lifecycle/runner.js";
import { ensurePrivateRunRoot, openSafeRun, preManifestRunPath } from "../path-safety.js";
import type { RunManifest } from "../types.js";

let root: string;
let sequence = 0;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeSafeRun() {
  sequence += 1;
  const agentDir = join(root, `agent-${sequence}`);
  const runId = `benchmark-${sequence}`;
  const preRun = await ensurePrivateRunRoot(agentDir, runId);
  const key = await loadOrCreateCorpusKey(preRun);
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId,
    createdAt: "2026-07-15T00:00:00.000Z",
    corpusKeyDigest: corpusKeyDigest(key),
    eventCount: 0,
  };
  await atomicManifestWrite(preRun, manifest);
  return {
    safeRun: await openSafeRun(agentDir, runId),
    runRoot: preManifestRunPath(preRun),
  };
}

interface InstallationFixture {
  readonly installation: PinnedPiInstallation;
  readonly pin: PiInstallationPin;
  readonly packageBytes: Uint8Array;
  readonly binaryBytes: Uint8Array;
}

function installationFixture(id: string, version: string): InstallationFixture {
  const packageBytes = Buffer.from(JSON.stringify({ name: CANONICAL_PI_PACKAGE, version }));
  const binaryBytes = Buffer.from(`benchmark-${id}-${version}`);
  return {
    installation: {
      id,
      packageManifestPath: `/${id}/package.json`,
      binaryPath: `/${id}/pi`,
    },
    pin: {
      id,
      version,
      packageIntegrityDigest: digest(packageBytes),
      binaryDigest: digest(binaryBytes),
    },
    packageBytes,
    binaryBytes,
  };
}

function installations(): readonly [InstallationFixture, InstallationFixture] {
  return [
    installationFixture("pi-074", PI_074_VERSION),
    installationFixture("pi-current", "0.80.6"),
  ];
}

function metadata(
  items: readonly [InstallationFixture, InstallationFixture],
): LifecycleMatrixMetadata {
  return {
    installations: [items[0].installation, items[1].installation],
    protocolPins: [items[0].pin, items[1].pin],
  };
}

function readerFor(items: readonly InstallationFixture[]) {
  const files = new Map<string, Uint8Array>();
  for (const item of items) {
    files.set(item.installation.packageManifestPath, item.packageBytes);
    files.set(item.installation.binaryPath, item.binaryBytes);
  }
  return {
    readFile: async (path: string): Promise<Uint8Array> => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error("missing mock installation");
      return bytes;
    },
  };
}

function fixtures(): readonly [BenchmarkFixture<string>, BenchmarkFixture<string>] {
  return [
    {
      fixtureId: "generated-small",
      sourceDigest: digest(Buffer.from("small")),
      modelVisibleBytes: 4_096,
      payload: "PRIVATE_SMALL_CANARY",
    },
    {
      fixtureId: "generated-largest",
      sourceDigest: digest(Buffer.from("largest")),
      modelVisibleBytes: 65_536,
      payload: "PRIVATE_LARGEST_CANARY",
    },
  ];
}

function mockProcess(request: BenchmarkProcessRequest<string>) {
  const absoluteSamplesMs = Array.from(
    { length: BENCHMARK_MEASURED_ITERATIONS },
    (_, index) => 5 + (index % 20) / 10,
  );
  const noOpSamplesMs = absoluteSamplesMs.map(() => 1);
  return Promise.resolve({
    warmupInvocations: request.warmupIterations,
    measuredInvocations: request.measuredIterations,
    coldStartAbsoluteMs: 8,
    coldStartNoOpMs: 2,
    absoluteSamplesMs,
    noOpSamplesMs,
    childEnvironment: {
      isolationId: `process-${request.cellId.slice(0, 32)}`,
      piVersion: request.installation.version,
      nodeVersion: "v24.0.0",
      platform: "generated",
      architecture: "generated",
    },
  });
}

function fakeResult(fixtureId: string, p95Ms: number): BenchmarkResult {
  return {
    matrixAttemptId: "attempt-1",
    fixtureId,
    sourceDigest: "a".repeat(64),
    modelVisibleBytes: 1,
    mandatoryLargestFixture: false,
    installationId: "pi-074",
    piVersion: PI_074_VERSION,
    coldStart: { absoluteMs: 1, noOpMs: 0, adjustedMs: 1 },
    absolute: { p50Ms: p95Ms, p95Ms, maxMs: p95Ms },
    noOpAdjusted: { p50Ms: p95Ms, p95Ms, maxMs: p95Ms },
    environmentDigest: "b".repeat(64),
  };
}

before(() => {
  root = join(tmpdir(), `lifecycle-benchmark-${randomBytes(8).toString("hex")}`);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("lifecycle benchmark statistics", () => {
  it("uses nearest-rank p50, p95, and maximum without interpolation", () => {
    const samples = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    assert.equal(nearestRankPercentile(samples, 0.5), 5);
    assert.equal(nearestRankPercentile(samples, 0.95), 10);
    assert.deepEqual(summarizeLatencies(samples), { p50Ms: 5, p95Ms: 10, maxMs: 10 });
    assert.throws(() => nearestRankPercentile([], 0.5), { code: "E_EVAL_SCHEMA" });
    assert.throws(() => nearestRankPercentile(samples, 0), { code: "E_EVAL_SCHEMA" });
  });

  it("selects the largest fixture deterministically with an ID tie-breaker", () => {
    const candidates = [
      { ...fixtures()[0], fixtureId: "z", modelVisibleBytes: 10 },
      { ...fixtures()[1], fixtureId: "a", modelVisibleBytes: 10 },
    ];
    assert.equal(selectLargestBenchmarkFixture(candidates).fixtureId, "a");
  });

  it("gates on maximum per-fixture absolute p95, never a pooled percentile", () => {
    const gate = evaluateBenchmarkGate([
      fakeResult("many-fast", 2),
      fakeResult("largest", BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS),
    ]);
    assert.equal(gate.maxAbsoluteP95Ms, BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS);
    assert.equal(gate.pass, false);
    assert.equal(evaluateBenchmarkGate([fakeResult("all-fast", 24.99)]).pass, true);
  });
});

describe("parameterized isolated lifecycle benchmark", () => {
  it("runs fixed iterations in one unique process per fixture/version and writes aggregate JSONL", async () => {
    const items = installations();
    const generatedFixtures = fixtures();
    const { safeRun, runRoot } = await makeSafeRun();
    const calls: string[] = [];
    const result = await runLifecycleBenchmark({
      ...metadata(items),
      safeRun,
      matrixAttemptId: "attempt-1",
      eventTimestamp: "2026-07-15T00:00:00.000Z",
      fixtures: generatedFixtures,
      largestFixtureId: "generated-largest",
      reader: readerFor(items),
      probeVersion: async (path) =>
        path === items[0].installation.binaryPath ? PI_074_VERSION : "0.80.6",
      executeIsolatedBenchmark: async (request) => {
        assert.equal(request.warmupIterations, 100);
        assert.equal(request.measuredIterations, 1_000);
        calls.push(request.cellId);
        return mockProcess(request);
      },
    });

    assert.equal(result.results.length, 4);
    assert.equal(new Set(calls).size, 4);
    assert.equal(result.results.filter((item) => item.mandatoryLargestFixture).length, 2);
    assert.ok(result.results.every((item) => item.absolute.p95Ms === 6.8));
    assert.ok(result.results.every((item) => item.noOpAdjusted.p95Ms === 5.8));
    assert.ok(result.results.every((item) => item.environmentDigest.length === 64));
    assert.equal(result.gate.pass, true);

    const evidence = await readFile(join(runRoot, BENCHMARK_EVIDENCE_PATH), "utf8");
    assert.equal(evidence.trimEnd().split("\n").length, 5);
    assert.equal(evidence.includes("PRIVATE_SMALL_CANARY"), false);
    assert.equal(evidence.includes("PRIVATE_LARGEST_CANARY"), false);
    assert.equal(evidence.includes(items[0].installation.binaryPath), false);
    assert.match(evidence, /lifecycle-benchmark-result-v1/);
    assert.match(evidence, /lifecycle-benchmark-gate-v1/);
  });

  it("rejects a wrong largest declaration before invoking a process", async () => {
    const items = installations();
    const { safeRun } = await makeSafeRun();
    let invoked = false;
    await assert.rejects(
      () =>
        runLifecycleBenchmark({
          ...metadata(items),
          safeRun,
          matrixAttemptId: "attempt-2",
          eventTimestamp: "2026-07-15T00:00:00.000Z",
          fixtures: fixtures(),
          largestFixtureId: "generated-small",
          reader: readerFor(items),
          probeVersion: async (path) =>
            path === items[0].installation.binaryPath ? PI_074_VERSION : "0.80.6",
          executeIsolatedBenchmark: async (request) => {
            invoked = true;
            return mockProcess(request);
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
    assert.equal(invoked, false);
  });

  it("rejects wrong iteration counts and reused process isolation identities", async () => {
    const items = installations();
    const firstRun = await makeSafeRun();
    await assert.rejects(
      () =>
        runLifecycleBenchmark({
          ...metadata(items),
          safeRun: firstRun.safeRun,
          matrixAttemptId: "attempt-3",
          eventTimestamp: "2026-07-15T00:00:00.000Z",
          fixtures: fixtures(),
          largestFixtureId: "generated-largest",
          reader: readerFor(items),
          probeVersion: async (path) =>
            path === items[0].installation.binaryPath ? PI_074_VERSION : "0.80.6",
          executeIsolatedBenchmark: async (request) => ({
            ...(await mockProcess(request)),
            measuredInvocations: 999,
          }),
        }),
      { code: "E_EVAL_INTEGRITY" },
    );

    const secondRun = await makeSafeRun();
    await assert.rejects(
      () =>
        runLifecycleBenchmark({
          ...metadata(items),
          safeRun: secondRun.safeRun,
          matrixAttemptId: "attempt-4",
          eventTimestamp: "2026-07-15T00:00:00.000Z",
          fixtures: fixtures(),
          largestFixtureId: "generated-largest",
          reader: readerFor(items),
          probeVersion: async (path) =>
            path === items[0].installation.binaryPath ? PI_074_VERSION : "0.80.6",
          executeIsolatedBenchmark: async (request) => ({
            ...(await mockProcess(request)),
            childEnvironment: {
              ...(await mockProcess(request)).childEnvironment,
              isolationId: "reused-process",
            },
          }),
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
  });

  it("rejects installation pin failures before invoking the benchmark adapter", async () => {
    const items = installations();
    const { safeRun } = await makeSafeRun();
    let invoked = false;
    await assert.rejects(
      () =>
        runLifecycleBenchmark({
          ...metadata(items),
          protocolPins: [items[0].pin, { ...items[1].pin, binaryDigest: "f".repeat(64) }],
          safeRun,
          matrixAttemptId: "attempt-5",
          eventTimestamp: "2026-07-15T00:00:00.000Z",
          fixtures: fixtures(),
          largestFixtureId: "generated-largest",
          reader: readerFor(items),
          probeVersion: async (path) =>
            path === items[0].installation.binaryPath ? PI_074_VERSION : "0.80.6",
          executeIsolatedBenchmark: async (request) => {
            invoked = true;
            return mockProcess(request);
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
    assert.equal(invoked, false);
  });
});
