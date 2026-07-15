/** Hermetic T-016 integration evidence: fabricated inputs only; no opt-in adapters. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  candidateIdForQualification,
  qualificationCatalogDigest,
  selectAnnotatedCandidate,
} from "../annotations.js";
import { canonicalDigest } from "../canonical-json.js";
import { decide } from "../decision.js";
import {
  appendEvent,
  atomicManifestWrite,
  corpusKeyDigest,
  generateCorpusKey,
  hmacDigest,
  loadExistingEventIds,
  loadOrCreateCorpusKey,
} from "../evidence-store.js";
import { authenticateRedactedReportInput, buildRedactedReport } from "../export-redacted.js";
import {
  createDisposableSessionCopy,
  inventoryCorpus,
  validateDisposableSessionCopy,
} from "../inventory.js";
import { type BenchmarkProcessRequest, runLifecycleBenchmark } from "../lifecycle/benchmark.js";
import {
  captureCompactionUsage,
  createGeneratedCompactionUsageFixture,
  resumeCompactionUsageProbe,
} from "../lifecycle/compaction-usage.js";
import {
  CANONICAL_PI_PACKAGE,
  PI_074_VERSION,
  executeGeneratedScenario,
  runLifecycleMatrix,
} from "../lifecycle/runner.js";
import { createGeneratedLifecycleScenarios } from "../lifecycle/scenarios.js";
import {
  ensurePrivateDir,
  ensurePrivateRunRoot,
  openSafeRun,
  safeRunReadFile,
  safeRunWriteFile,
} from "../path-safety.js";
import { SAMPLING_LOCK_STAGE } from "../protocol.js";
import { providerPolicyDigest, runGeneratedCompactionProof } from "../provider-runner.js";
import { qualifySession } from "../qualification.js";
import { SyntheticModelAdapter, buildReplayPlan, executeSyntheticReplay } from "../replay.js";
import { sampleInventory, sampleManifestDigest } from "../sampling.js";
import { hiddenCheckDefinitionDigest, runSandboxContinuation } from "../sandbox-continuation.js";
import { scoreQuality } from "../scoring.js";
import {
  freezeSnapshot,
  nativeContextDigest,
  openReplaySnapshotAccess,
  persistFrozenSnapshot,
  readReplaySnapshot,
  summaryInstructionDigest,
} from "../snapshots.js";
import { EvidenceStoreError, type RunManifest, SCHEMA_VERSION } from "../types.js";

const DIGEST = (value: string): string => canonicalDigest(value);
const NOW = "2026-07-15T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function sessionLines(index: number): string {
  const entries: object[] = [
    { type: "session", id: `session-${index}`, version: 2, timestamp: NOW },
    {
      type: "message",
      id: "root",
      parentId: null,
      timestamp: NOW,
      message: { role: "user", content: "x" },
    },
    {
      type: "message",
      id: "start",
      parentId: "root",
      timestamp: NOW,
      message: { role: "user", content: "x".repeat(8_192) },
    },
    {
      type: "message",
      id: "candidate-answer",
      parentId: "start",
      timestamp: NOW,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x" }],
        stopReason: "stop",
        usage: usage(),
      },
    },
    {
      type: "message",
      id: "closure",
      parentId: "candidate-answer",
      timestamp: NOW,
      message: { role: "user", content: "x" },
    },
  ];
  let parentId = "closure";
  for (let request = 1; request <= 20; request += 1) {
    const id = `request-${request}`;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: NOW,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x" }],
        stopReason: "stop",
        usage: usage(),
      },
    });
    parentId = id;
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** Every inventory path is fabricated; the fail-fast resolver is the only non-fabricated branch. */
async function makeCorpus(root: string) {
  const inventoryRoot = join(root, "fabricated-sessions");
  await mkdir(inventoryRoot);
  const paths = Array.from({ length: 40 }, (_, index) => join(inventoryRoot, `s-${index}.jsonl`));
  await Promise.all(paths.map((path, index) => writeFile(path, sessionLines(index))));
  const realSourceCalls: string[] = [];
  const resolveSource = (path: string): string => {
    if (path.startsWith(`${inventoryRoot}/`)) return path;
    realSourceCalls.push(path);
    throw new Error(`real source resolver invoked: ${path}`);
  };
  const key = generateCorpusKey();
  return {
    key,
    paths,
    realSourceCalls,
    sourcePath: resolveSource,
    records: await inventoryCorpus(paths.map(resolveSource), key),
  };
}

function samplingLock() {
  return {
    stage: SAMPLING_LOCK_STAGE,
    schemaVersion: SCHEMA_VERSION,
    runId: "hermetic-e2e",
    protocolSeed: "hermetic-seed",
    longSessionMinRequests: 20,
    collectionWindowEndsAt: "2030-01-01T00:00:00.000Z",
    maxInventoryRefreshes: 1,
    modelRegistryDigest: DIGEST("model-registry"),
    estimatorPolicyDigest: DIGEST("estimator"),
  } as const;
}

async function safeRun(root: string) {
  const agentDir = join(root, "agent");
  const runId = "hermetic-e2e";
  const preRun = await ensurePrivateRunRoot(agentDir, runId);
  const key = await loadOrCreateCorpusKey(preRun);
  await atomicManifestWrite(preRun, {
    schemaVersion: SCHEMA_VERSION,
    runId,
    createdAt: NOW,
    corpusKeyDigest: corpusKeyDigest(key),
    eventCount: 0,
  } satisfies RunManifest);
  return { key, agentDir, runId, run: await openSafeRun(agentDir, runId) };
}

function qualification(corpusId: string, key: string) {
  const id = (raw: string) => hmacDigest(key, Buffer.from(raw));
  const entries = [
    { id: id("root"), type: "message" as const, message: { role: "user" as const, content: "x" } },
    {
      id: id("start"),
      type: "message" as const,
      message: { role: "user" as const, content: "x".repeat(8_192) },
    },
    {
      id: id("candidate-answer"),
      type: "message" as const,
      message: {
        role: "assistant" as const,
        content: [{ type: "text", text: "x" }],
        stopReason: "stop",
        usage: usage(),
      },
    },
    {
      id: id("closure"),
      type: "message" as const,
      message: { role: "user" as const, content: "x" },
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: id(`request-${index + 1}`),
      type: "message" as const,
      requestOrigin: "main" as const,
      message: {
        role: "assistant" as const,
        content: [{ type: "text", text: "x" }],
        stopReason: "stop",
        usage: usage(),
      },
    })),
  ].map((entry, index, all) => ({
    ...entry,
    ...(index === 0 ? {} : { parentId: all[index - 1]!.id }),
  }));
  return qualifySession({
    corpusId,
    selectedRank: 1,
    parentStatus: "parent",
    selectedLeafId: entries.at(-1)!.id,
    entries,
    pressurePoints: [{ contextPercent: 70 }],
    nativeCompactionCount: 0,
    frozenModelRegistry: { contextWindows: new Map() },
    candidate: {
      startEntryId: id("start"),
      endEntryId: id("candidate-answer"),
      entryIds: [id("start"), id("candidate-answer")],
      closureEntryId: id("closure"),
      closureEvidence: ["goal-transition"],
    },
  });
}

/** Produce the actual T-007A envelope, two blinded records, and the sole T-008 selection. */
function annotatedSelection(corpusId: string, key: string) {
  const qualified = qualification(corpusId, key);
  assert.equal(qualified.qualifies, true);
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    qualificationDigest: canonicalDigest(qualified),
    qualification: qualified,
  };
  const candidateId = candidateIdForQualification(qualified);
  const annotations = [
    {
      schemaVersion: SCHEMA_VERSION,
      annotationId: DIGEST("annotation-owner"),
      catalogDigest: qualificationCatalogDigest([envelope]),
      corpusId,
      selectedRank: 1,
      annotatorId: DIGEST("annotator-owner"),
      annotatorKind: "owner" as const,
      decision: "candidates-identified" as const,
      claims: [{ candidateId, closureEvidence: ["goal-transition"] as const }],
      reasonCodes: [],
    },
    {
      schemaVersion: SCHEMA_VERSION,
      annotationId: DIGEST("annotation-independent"),
      catalogDigest: qualificationCatalogDigest([envelope]),
      corpusId,
      selectedRank: 1,
      annotatorId: DIGEST("annotator-independent"),
      annotatorKind: "independent-human" as const,
      decision: "candidates-identified" as const,
      claims: [{ candidateId, closureEvidence: ["goal-transition"] as const }],
      reasonCodes: [],
    },
  ];
  const selection = selectAnnotatedCandidate([envelope], annotations);
  assert.equal(selection.status, "selected");
  if (selection.status !== "selected" || selection.qualification === undefined)
    throw new Error("annotation selection unexpectedly blocked");
  return selection;
}

function freezeInput(
  corpusId: string,
  key: string,
  selection: ReturnType<typeof annotatedSelection>,
) {
  const id = (raw: string) => hmacDigest(key, Buffer.from(raw));
  const entry = (raw: string, role: "user" | "assistant", content: unknown) => ({
    entryId: id(raw),
    message: { role, content },
  });
  const beforeCandidate = [entry("root", "user", "x")];
  const candidateRange = [
    entry("start", "user", "x".repeat(8_192)),
    entry("candidate-answer", "assistant", [{ type: "text", text: "x" }]),
  ];
  return {
    selection,
    checkpoints: Array.from({ length: 5 }, (_, index) => {
      const checkpointIndex = (index + 1) as 1 | 2 | 3 | 4 | 5;
      const requestEntryId = id(`request-${checkpointIndex}`);
      const afterCandidate = [
        entry("closure", "user", "x"),
        ...Array.from({ length: index }, (_, prior) =>
          entry(`request-${prior + 1}`, "assistant", [{ type: "text", text: "x" }]),
        ),
      ];
      return {
        checkpointIndex,
        requestEntryId,
        nativeContextDigest: nativeContextDigest({
          checkpointIndex,
          requestEntryId,
          beforeCandidate,
          candidateRange,
          afterCandidate,
        }),
      };
    }),
    targetSelectionDigest: DIGEST("target"),
    systemPromptDigest: DIGEST("system"),
    toolSchemaDigest: DIGEST("tools"),
    summaryInstruction: "x",
    summaryInstructionDigest: summaryInstructionDigest("x"),
    rubricDigest: DIGEST("rubric"),
    objectiveChecksDigest: DIGEST("objective"),
    fixture: {
      status: "unavailable" as const,
      executionTarget: "none" as const,
      reasonCode: "fixture-not-captured" as const,
    },
    goldFacts: [
      {
        factId: DIGEST("fact"),
        category: "goal" as const,
        sourceEntryIds: [id("start")],
        statement: "x",
        diagnosticAtCheckpoints: [true, true, true, true, true] as const,
      },
    ],
  };
}

function installationFixtures() {
  const fixture = (id: string, version: string) => {
    const packageBytes = Buffer.from(JSON.stringify({ name: CANONICAL_PI_PACKAGE, version }));
    const binaryBytes = Buffer.from(`generated-${id}-${version}`);
    return {
      installation: { id, packageManifestPath: `/${id}/package.json`, binaryPath: `/${id}/pi` },
      pin: {
        id,
        version,
        packageIntegrityDigest: createHash("sha256").update(packageBytes).digest("hex"),
        binaryDigest: createHash("sha256").update(binaryBytes).digest("hex"),
      },
      packageBytes,
      binaryBytes,
    };
  };
  return [fixture("pi-074", PI_074_VERSION), fixture("pi-current", "0.80.6")] as const;
}

function lifecycleSeams(items: ReturnType<typeof installationFixtures>) {
  const files = new Map<string, Uint8Array>();
  const versions = new Map<string, string>();
  for (const item of items) {
    files.set(item.installation.packageManifestPath, item.packageBytes);
    files.set(item.installation.binaryPath, item.binaryBytes);
    versions.set(item.installation.binaryPath, item.pin.version);
  }
  return {
    installations: [items[0].installation, items[1].installation] as const,
    protocolPins: [items[0].pin, items[1].pin] as const,
    reader: {
      readFile: async (path: string): Promise<Uint8Array> =>
        files.get(path) ?? Promise.reject(new Error("mock pin path missing")),
    },
    probeVersion: async (path: string): Promise<string> =>
      versions.get(path) ?? Promise.reject(new Error("mock binary missing")),
  };
}

function benchmarkProcess(request: BenchmarkProcessRequest) {
  const absoluteSamplesMs = Array.from({ length: 1_000 }, (_, index) => 5 + (index % 20) / 10);
  return Promise.resolve({
    warmupInvocations: request.warmupIterations,
    measuredInvocations: request.measuredIterations,
    coldStartAbsoluteMs: 8,
    coldStartNoOpMs: 2,
    absoluteSamplesMs,
    noOpSamplesMs: absoluteSamplesMs.map(() => 1),
    childEnvironment: {
      isolationId: `benchmark-${request.cellId.slice(0, 24)}`,
      piVersion: request.installation.version,
      nodeVersion: "v24.0.0",
      platform: "generated",
      architecture: "generated",
    },
  });
}

type StageName = "sampling" | "compaction" | "lifecycle";
type StageDisposition = Readonly<{
  stage: StageName;
  status: "not-applicable";
  upstreamDigest: string;
  recordDigest: string;
}>;
function deriveNotApplicable(
  key: string,
  outputs: readonly [StageName, unknown][],
): readonly StageDisposition[] {
  let upstreamDigest = hmacDigest(key, Buffer.from(canonicalDigest(outputs[0]![1])));
  return outputs.map(([stage, output]) => {
    const recordDigest = hmacDigest(
      key,
      Buffer.from(canonicalDigest({ stage, upstreamDigest, output })),
    );
    const result: StageDisposition = {
      stage,
      status: "not-applicable",
      upstreamDigest,
      recordDigest,
    };
    upstreamDigest = recordDigest;
    return result;
  });
}

const providerPolicy = {
  maxRetriesPerPlannedRequest: 1 as const,
  retryableErrorClasses: ["timeout", "rate-limit"] as const,
  timeoutMs: { summary: 1_000, checkpoint: 2_000 },
  upperCostPerAttempt: { summary: 0.01, checkpoint: 0.02 },
  priceCardDigest: DIGEST("price-card"),
  cacheStrategy: "per-plan-per-request-v1" as const,
  confirmationPolicy: "exact-plan-target-call-count-upper-cost-v2" as const,
};
const targetSelection = {
  stage: "target-selection" as const,
  schemaVersion: SCHEMA_VERSION as 1,
  runId: "hermetic-e2e",
  provider: "fake-provider",
  model: "fake-model",
  api: "fake-api",
  reasoning: "fake-reasoning",
  samplingLockDigest: DIGEST("sampling-lock"),
  inventoryDigest: DIGEST("inventory"),
  sampleDigest: DIGEST("sample"),
  providerPolicyDigest: providerPolicyDigest(providerPolicy),
};
const proofPolicy = {
  maxRetriesPerPlannedRequest: 1 as const,
  upperCostPerAttempt: { nativeCompaction: 0.01, followingMain: 0.02 },
  priceCardDigest: providerPolicy.priceCardDigest,
  cacheStrategy: providerPolicy.cacheStrategy,
  confirmationPolicy: "exact-generated-compaction-proof-v1" as const,
};

describe("T-016 hermetic evidence pipeline", () => {
  it("fans actual selection, replay, lifecycle, benchmark, sandbox, resume, decision, and report through fabricated seams", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-pruning-hermetic-"));
    roots.push(root);
    const corpus = await makeCorpus(root);
    const firstSample = sampleInventory({
      samplingLock: samplingLock(),
      inventoryRecords: corpus.records,
      attemptIndex: 0,
      now: NOW,
    });
    const secondSample = sampleInventory({
      samplingLock: samplingLock(),
      inventoryRecords: corpus.records,
      attemptIndex: 0,
      now: NOW,
    });
    assert.equal(firstSample.status, "frozen");
    assert.equal(secondSample.status, "frozen");
    if (firstSample.status !== "frozen" || secondSample.status !== "frozen")
      throw new Error("fabricated frame unexpectedly underflowed");
    assert.deepEqual(firstSample.manifest, secondSample.manifest);
    assert.equal(
      sampleManifestDigest(firstSample.manifest),
      sampleManifestDigest(secondSample.manifest),
    );
    assert.equal(corpus.realSourceCalls.length, 0);

    const selectedEntry = firstSample.manifest.entries[0]!;
    const record = corpus.records.find((item) => item.corpusId === selectedEntry.corpusId);
    assert.ok(record);
    const safe = await safeRun(root);
    const copy = await createDisposableSessionCopy(record, safe.run);
    assert.equal((await validateDisposableSessionCopy(copy)).status, "matched");

    const selection = annotatedSelection(selectedEntry.corpusId, safe.key);
    const input = freezeInput(selectedEntry.corpusId, safe.key, selection);
    const bundle = await freezeSnapshot(safe.run, input);
    await persistFrozenSnapshot(safe.run, bundle);
    const frozenBeforeResume = await safeRunReadFile(
      safe.run,
      `frozen/${selectedEntry.corpusId}.json`,
    );
    const access = await openReplaySnapshotAccess(safe.run, selectedEntry.corpusId);
    const replayInput = { protocolSeed: "synthetic", replicateCount: 3, requestBudget: 16 };
    const replay = await buildReplayPlan(access, selection, replayInput);
    const replayAgain = await buildReplayPlan(access, selection, replayInput);
    assert.equal(replay.planDigest, replayAgain.planDigest);
    const adapter = new SyntheticModelAdapter();
    const synthetic = await executeSyntheticReplay(access, selection, replayInput, replay, adapter);
    const repeatedAdapter = new SyntheticModelAdapter();
    const repeatedSynthetic = await executeSyntheticReplay(
      access,
      selection,
      replayInput,
      replay,
      repeatedAdapter,
    );
    assert.deepEqual(repeatedSynthetic.attempts, synthetic.attempts);
    assert.deepEqual(repeatedAdapter.calls, adapter.calls);
    const checkpoints = synthetic.attempts.filter((attempt) => attempt.kind === "checkpoint");
    assert.equal(checkpoints.length, 30);
    assert.equal(adapter.calls.length, synthetic.attempts.length);

    const hiddenChecks = [
      {
        checkId: "rubric",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 1_000,
      },
    ] as const;
    const generatedOriginal = join(root, "generated-original");
    await mkdir(generatedOriginal);
    const artifactId = DIGEST("generated-sandbox-artifact");
    const archive = "generated-sandbox-fixture";
    await ensurePrivateDir(safe.run, `fixtures/${artifactId}`);
    await safeRunWriteFile(safe.run, `fixtures/${artifactId}/archive`, archive);
    const sandbox = await runSandboxContinuation({
      safeRun: safe.run,
      snapshotDigest: bundle.snapshot.snapshotDigest,
      objectiveChecksDigest: hiddenCheckDefinitionDigest(hiddenChecks),
      fixture: {
        status: "exact",
        executionTarget: "disposable-only",
        commitDigest: DIGEST("generated-sandbox-commit"),
        archiveDigest: createHash("sha256").update(archive).digest("hex"),
        artifactId,
      },
      originalRepositoryPath: generatedOriginal,
      caps: { allowedTools: ["read"], requestLimit: 1 },
      hiddenChecks,
      materializer: {
        async materialize({ destination }) {
          await writeFile(join(destination, "fixture.txt"), archive);
        },
      },
      continuation: {
        async continue({ caps }) {
          return { requestsUsed: 1, toolsUsed: [caps.allowedTools[0]!] };
        },
      },
    });
    assert.equal(sandbox.execution, "executed");
    if (sandbox.execution !== "executed") throw new Error("generated sandbox did not execute");
    const taskCompletionByArm = new Map(
      sandbox.arms.map((arm) => [
        arm.arm,
        arm.checks.length > 0 && arm.checks.every((check) => check.status === "pass"),
      ]),
    );
    assert.deepEqual(
      taskCompletionByArm,
      new Map([
        ["native", true],
        ["selective", true],
      ]),
    );

    const scoredAttempts = checkpoints.map((attempt) => {
      assert.ok(attempt.checkpointIndex);
      return {
        snapshotId: bundle.snapshot.snapshotId,
        replicateIndex: attempt.replicateIndex,
        checkpointIndex: attempt.checkpointIndex!,
        facts: [{ factId: DIGEST("fact"), judgment: "correct" as const }],
        taskCompletion: taskCompletionByArm.get(attempt.arm)!,
        severeEvent: false,
        arm: attempt.arm,
      };
    });
    assert.deepEqual(
      scoredAttempts.map(({ replicateIndex, checkpointIndex, arm }) => ({
        replicateIndex,
        checkpointIndex,
        arm,
      })),
      checkpoints.map(({ replicateIndex, checkpointIndex, arm }) => ({
        replicateIndex,
        checkpointIndex,
        arm,
      })),
    );
    const score = scoreQuality(
      scoredAttempts,
      "synthetic",
      sampleManifestDigest(firstSample.manifest),
      true,
    );

    // Interruption occurs after real probe/replay artifacts exist; a fresh SafeRun resumes both identities.
    const probeFacts = createGeneratedCompactionUsageFixture().complete.events;
    const intermediate = await resumeCompactionUsageProbe(
      safe.run,
      "pipeline-probe",
      NOW,
      probeFacts,
    );
    const checkpointEvent = {
      eventId: canonicalDigest({ planDigest: replay.planDigest, attempt: checkpoints[0] }),
      timestamp: NOW,
      type: "synthetic-replay-checkpoint",
      data: { planDigest: replay.planDigest, inputDigest: checkpoints[0]!.inputDigest },
    };
    await appendEvent(safe.run, "synthetic-replay.jsonl", checkpointEvent);
    const reopened = await openSafeRun(safe.agentDir, safe.runId);
    const reopenedAccess = await openReplaySnapshotAccess(reopened, selectedEntry.corpusId);
    const resumed = await resumeCompactionUsageProbe(
      reopened,
      "pipeline-probe",
      "2026-07-15T00:00:01.000Z",
      probeFacts,
    );
    assert.deepEqual(resumed, intermediate);
    await appendEvent(reopened, "synthetic-replay.jsonl", checkpointEvent);
    assert.equal((await loadExistingEventIds(reopened, "synthetic-replay.jsonl")).size, 1);
    assert.deepEqual(
      await safeRunReadFile(reopened, `frozen/${selectedEntry.corpusId}.json`),
      frozenBeforeResume,
    );
    assert.equal(readReplaySnapshot(reopenedAccess).snapshotDigest, bundle.snapshot.snapshotDigest);

    const fixtures = installationFixtures();
    const seams = lifecycleSeams(fixtures);
    const lifecycle = await runLifecycleMatrix({
      ...seams,
      safeRun: reopened,
      matrixAttemptId: "matrix-success",
      eventTimestamp: NOW,
      executeIsolatedScenario: executeGeneratedScenario,
    });
    assert.ok(lifecycle.every((result) => result.pass));
    const provenanceFalsePositiveCount = lifecycle.reduce(
      (total, result) =>
        total + result.coverage.ownershipFalsePositives + result.coverage.boundaryFalsePositives,
      0,
    );
    const lifecycleScenarioMissCount = lifecycle.filter((result) => !result.pass).length;

    const generatedScenarios = createGeneratedLifecycleScenarios();
    const benchmarkFixtures = generatedScenarios.slice(0, 2).map((scenario) => ({
      fixtureId: `generated-${scenario.id}`,
      sourceDigest: scenario.sourceDigest,
      modelVisibleBytes: scenario.qualificationEstimatedTokens,
      payload: scenario,
    }));
    const benchmark = await runLifecycleBenchmark({
      ...seams,
      safeRun: reopened,
      matrixAttemptId: "benchmark-success",
      eventTimestamp: NOW,
      fixtures: benchmarkFixtures,
      largestFixtureId: benchmarkFixtures.reduce((largest, fixture) =>
        fixture.modelVisibleBytes > largest.modelVisibleBytes ? fixture : largest,
      ).fixtureId,
      executeIsolatedBenchmark: benchmarkProcess,
    });
    assert.equal(benchmark.gate.pass, true);

    // No confirmation is an actual provider seam refusal, not a disconnected sentinel.
    let providerCalls = 0;
    const incompleteProof = await runGeneratedCompactionProof({
      safeRun: reopened,
      targetSelection,
      providerPolicy,
      proofPolicy,
      environmentDigest: DIGEST("proof-environment"),
      adapter: {
        kind: "fake" as const,
        target: {
          provider: targetSelection.provider,
          model: targetSelection.model,
          api: targetSelection.api,
          reasoning: targetSelection.reasoning,
        },
        cacheCapability: {
          configuredStrategy: providerPolicy.cacheStrategy,
          observedIsolation: "isolated" as const,
        },
        async execute(_request) {
          providerCalls += 1;
          throw new Error("provider must not run without confirmation");
        },
      },
      now: () => NOW,
    });
    assert.equal(incompleteProof.status, "refused");
    assert.equal(incompleteProof.resolution.outcome, "blocking-incomplete");
    assert.equal(providerCalls, 0);

    // Pin validation fails before the external-Pi executor seam is reached.
    let externalPiCalls = 0;
    await assert.rejects(
      () =>
        runLifecycleMatrix({
          ...seams,
          safeRun: reopened,
          matrixAttemptId: "matrix-invalid-pin",
          eventTimestamp: NOW,
          protocolPins: [fixtures[0].pin, { ...fixtures[1].pin, version: "0.80.7" }] as const,
          executeIsolatedScenario: async () => {
            externalPiCalls += 1;
            throw new Error("external Pi executor must not run");
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
    assert.equal(externalPiCalls, 0);

    const qualifyingSnapshotCount = firstSample.manifest.entries
      .slice(0, 10)
      .filter((entry) => qualification(entry.corpusId, safe.key).qualifies).length;
    const decisionInput = {
      quality: {
        recallDelta: score.recallDelta,
        taskCompletionDelta: score.taskCompletionDelta!,
        treatmentOnlySevereEvent: score.treatmentOnlySevereEvent,
      },
      utility: {
        status: "missing" as const,
        collectionExtension: {
          status: "permitted" as const,
          description: "synthetic accounting does not resolve DQ-004",
        },
      },
      applicability: {
        sampledSessionCount: firstSample.manifest.entries.length,
        qualifyingSnapshotCount,
      },
      feasibility: {
        provenanceFalsePositiveCount,
        lifecycleScenarioMissCount,
        lifecycleFix: null,
        p95Ms: benchmark.gate.maxAbsoluteP95Ms,
        performanceOptimization: null,
      },
    };
    const decision = decide(decisionInput);
    const repeatedDecision = decide({
      ...decisionInput,
      quality: { ...decisionInput.quality },
      feasibility: { ...decisionInput.feasibility },
    });
    assert.deepEqual(repeatedDecision, decision);
    assert.equal(decision.outcome, "REVISE");

    const source = corpus.sourcePath(corpus.paths[corpus.records.indexOf(record)]!);
    const sourceDigest = hmacDigest(safe.key, await readFile(source));
    const reportInput = {
      schemaVersion: SCHEMA_VERSION,
      outcome: decision.outcome,
      artifacts: [
        {
          digest: canonicalDigest({ decision, score, replay: replay.planDigest }),
          payload: { decision, score, replay: replay.planDigest },
        },
      ],
      sourceChecks: [{ sourcePath: source, beforeDigest: sourceDigest, afterDigest: sourceDigest }],
      observations: [
        {
          snapshotId: bundle.snapshot.snapshotId,
          replicateIndex: 1,
          bucket: "quality" as const,
          value: score.recallDelta,
        },
      ],
      diagnostics: [{ kind: "skip" as const, code: "provider-missing" }],
      repositoryClusteringObserved: false,
      cacheIsolationAvailable: false,
    };
    const report = await buildRedactedReport(
      authenticateRedactedReportInput(reportInput, safe.key),
      safe.key,
    );
    const repeatedReport = await buildRedactedReport(
      authenticateRedactedReportInput(reportInput, safe.key),
      safe.key,
    );
    assert.deepEqual(repeatedReport.candidate, report.candidate);
    assert.equal(report.candidate.outcome, decision.outcome);
    assert.equal(JSON.stringify(report.candidate).includes(source), false);
    assert.equal(corpus.realSourceCalls.length, 0);
  });

  it("derives hard-stop and not-applicable paths from actual failed stage outputs without downstream calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-pruning-hard-stops-"));
    roots.push(root);
    const safe = await safeRun(root);
    const underflow = sampleInventory({
      samplingLock: samplingLock(),
      inventoryRecords: [],
      attemptIndex: 1,
      now: NOW,
    });
    assert.equal(underflow.status, "underflow-hard-stop");

    const key = generateCorpusKey();
    const fewerThanTen = Array.from({ length: 9 }, (_, index) =>
      qualification(DIGEST(`few-${index}`), key),
    ).filter((item) => item.qualifies);
    assert.equal(fewerThanTen.length, 9);
    assert.equal(
      captureCompactionUsage(createGeneratedCompactionUsageFixture().complete).status,
      "complete",
    );
    const incompleteCompaction = captureCompactionUsage(
      createGeneratedCompactionUsageFixture().missing,
    );
    assert.equal(incompleteCompaction.status, "missing");

    const fixtures = installationFixtures();
    const seams = lifecycleSeams(fixtures);
    const lifecycleFailure = await runLifecycleMatrix({
      ...seams,
      safeRun: safe.run,
      matrixAttemptId: "matrix-failure",
      eventTimestamp: NOW,
      executeIsolatedScenario: async (cell) => {
        const generated = await executeGeneratedScenario(cell);
        return {
          ...generated,
          observedMessages: generated.observedMessages.map((message) => ({
            ...message,
            content: [{ type: "text", text: "corrupted generated lifecycle fixture" }],
          })),
        };
      },
    });
    assert.ok(lifecycleFailure.some((result) => !result.pass));

    const dispositions = deriveNotApplicable(safe.key, [
      ["sampling", underflow],
      ["compaction", incompleteCompaction],
      ["lifecycle", lifecycleFailure],
    ]);
    assert.equal(dispositions.length, 3);
    assert.ok(
      dispositions.every(
        (item, index) =>
          index === 0 || item.upstreamDigest === dispositions[index - 1]!.recordDigest,
      ),
    );
    assert.ok(dispositions.every((item) => /^[a-f0-9]{64}$/.test(item.recordDigest)));

    let providerCalls = 0;
    let repositoryCalls = 0;
    const hiddenChecks = [
      {
        checkId: "rubric",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 1_000,
      },
    ] as const;
    const unavailable = await runSandboxContinuation({
      safeRun: safe.run,
      snapshotDigest: DIGEST("unavailable-snapshot"),
      objectiveChecksDigest: hiddenCheckDefinitionDigest(hiddenChecks),
      fixture: {
        status: "unavailable",
        executionTarget: "none",
        reasonCode: "fixture-not-captured",
      },
      originalRepositoryPath: join(root, "real-repository"),
      caps: { allowedTools: ["read"], requestLimit: 1 },
      hiddenChecks,
      materializer: {
        async materialize() {
          repositoryCalls += 1;
          throw new Error("repository seam invoked");
        },
      },
      continuation: {
        async continue() {
          repositoryCalls += 1;
          throw new Error("continuation seam invoked");
        },
      },
    });
    assert.equal(unavailable.execution, "rubric-only");
    assert.equal(repositoryCalls, 0);

    // The derived disposition chain leaves downstream provider work in the real refusal path.
    const downstreamProof = await runGeneratedCompactionProof({
      safeRun: safe.run,
      targetSelection,
      providerPolicy,
      proofPolicy,
      environmentDigest: DIGEST("downstream-proof-environment"),
      adapter: {
        kind: "fake" as const,
        target: {
          provider: targetSelection.provider,
          model: targetSelection.model,
          api: targetSelection.api,
          reasoning: targetSelection.reasoning,
        },
        cacheCapability: {
          configuredStrategy: providerPolicy.cacheStrategy,
          observedIsolation: "isolated" as const,
        },
        async execute(_request) {
          providerCalls += 1;
          throw new Error("downstream provider seam invoked");
        },
      },
      now: () => NOW,
    });
    assert.equal(downstreamProof.resolution.outcome, "blocking-incomplete");
    assert.equal(providerCalls, 0);
    const source = join(root, "fabricated-source.jsonl");
    await writeFile(source, "x");
    const sourceDigest = hmacDigest(safe.key, Buffer.from("x"));
    const decision = decide({
      quality: { recallDelta: 0, taskCompletionDelta: 0, treatmentOnlySevereEvent: false },
      utility: {
        status: "missing",
        collectionExtension: {
          status: "permitted",
          description: "actual incomplete compaction remains unresolved",
        },
      },
      applicability: { sampledSessionCount: 40, qualifyingSnapshotCount: fewerThanTen.length },
      feasibility: {
        provenanceFalsePositiveCount: lifecycleFailure.reduce(
          (count, result) =>
            count +
            result.coverage.ownershipFalsePositives +
            result.coverage.boundaryFalsePositives,
          0,
        ),
        lifecycleScenarioMissCount: lifecycleFailure.filter((result) => !result.pass).length,
        lifecycleFix: null,
        p95Ms: 0,
        performanceOptimization: null,
      },
    });
    assert.equal(decision.outcome, "NO-GO");
    const report = await buildRedactedReport(
      authenticateRedactedReportInput(
        {
          schemaVersion: SCHEMA_VERSION,
          outcome: decision.outcome,
          artifacts: [{ digest: canonicalDigest(dispositions), payload: dispositions }],
          sourceChecks: [
            { sourcePath: source, beforeDigest: sourceDigest, afterDigest: sourceDigest },
          ],
          observations: [],
          diagnostics: dispositions.map(() => ({ kind: "skip" as const, code: "not-applicable" })),
          repositoryClusteringObserved: false,
          cacheIsolationAvailable: false,
        },
        safe.key,
      ),
      safe.key,
    );
    assert.equal(
      report.local.diagnostics.filter((item) => item.code === "not-applicable").length,
      dispositions.length,
    );

    await writeFile(source, "y");
    await assert.rejects(
      () =>
        buildRedactedReport(
          authenticateRedactedReportInput(
            {
              schemaVersion: SCHEMA_VERSION,
              outcome: "NO-GO",
              artifacts: [
                { digest: canonicalDigest({ integrity: true }), payload: { integrity: true } },
              ],
              sourceChecks: [
                { sourcePath: source, beforeDigest: sourceDigest, afterDigest: sourceDigest },
              ],
              observations: [],
              diagnostics: [],
              repositoryClusteringObserved: false,
              cacheIsolationAvailable: false,
            },
            safe.key,
          ),
          safe.key,
        ),
      (error: unknown) => error instanceof EvidenceStoreError && error.code === "E_EVAL_INTEGRITY",
    );

    await assert.rejects(
      () =>
        appendEvent(safe.run, "privacy.jsonl", {
          eventId: DIGEST("privacy"),
          timestamp: NOW,
          type: "privacy",
          data: { corpusKey: "forbidden" },
        }),
      (error: unknown) => error instanceof EvidenceStoreError && error.code === "E_EVAL_PRIVACY",
    );
  });
});
