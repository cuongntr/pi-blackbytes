import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { canonicalDigest, canonicalJson } from "../canonical-json.js";
import {
  atomicManifestWrite,
  corpusKeyDigest,
  generateCorpusKey,
  hmacDigest,
  loadOrCreateCorpusKey,
} from "../evidence-store.js";
import {
  createDisposableSessionCopy,
  inventorySource,
  validateDisposableSessionCopy,
} from "../inventory.js";
import { createGeneratedCompactionUsageFixture } from "../lifecycle/compaction-usage.js";
import { ensurePrivateRunRoot, openSafeRun, safeRunReadFile } from "../path-safety.js";
import {
  FakeReplayAdapter,
  PROVIDER_REPLAY_LEDGER_PATH,
  createGeneratedCompactionProofConfirmation,
  createGeneratedCompactionProofPlan,
  createProviderReplayConfirmation,
  declineGeneratedCompactionProof,
  prepareT009BPrivateInputs,
  providerPolicyDigest,
  providerReplayUpperBound,
  runGeneratedCompactionProof,
  runProviderReplay,
  t009bEnvironmentDigest,
  verifyPersistedGeneratedCompactionProof,
} from "../provider-runner.js";
import type {
  ProviderAdapterResult,
  ProviderReplayAdapter,
  ProviderReplayConfirmation,
  ProviderReplayRequest,
} from "../provider-runner.js";
import {
  SyntheticModelAdapter,
  assertPairedTeacherForcing,
  buildReplayPlan,
  executeSyntheticReplay,
  validateReplayPlan,
} from "../replay.js";
import {
  freezeSnapshot,
  nativeContextDigest,
  openReplaySnapshotAccess,
  persistFrozenSnapshot,
  summaryInstructionDigest,
} from "../snapshots.js";
import type { FreezeSnapshotInput } from "../snapshots.js";
import type { RunManifest } from "../types.js";

const digest = (character: string): string => character.repeat(64);
function generatedFacts(
  request: {
    readonly operation: "native-compaction" | "following-main";
    readonly requestId: string;
  },
  outcome: "complete" | "missing",
) {
  const facts = createGeneratedCompactionUsageFixture()[outcome].events;
  const native = request.operation === "native-compaction";
  return facts
    .filter((fact) =>
      native
        ? fact.type !== "before_provider_request" &&
          fact.type !== "usage_observation" &&
          fact.type !== "message_end"
          ? true
          : fact.requestId.endsWith("request-1")
        : (fact.type === "before_provider_request" ||
            fact.type === "usage_observation" ||
            fact.type === "message_end") &&
          fact.requestId.endsWith("request-2"),
    )
    .map((fact) =>
      fact.type === "before_provider_request" ||
      fact.type === "usage_observation" ||
      fact.type === "message_end"
        ? { ...fact, requestId: request.requestId }
        : fact,
    );
}
const providerPolicy = {
  maxRetriesPerPlannedRequest: 1 as const,
  retryableErrorClasses: ["timeout", "rate-limit"] as const,
  timeoutMs: { summary: 1_000, checkpoint: 2_000 },
  upperCostPerAttempt: { summary: 0.01, checkpoint: 0.02 },
  priceCardDigest: digest("8"),
  cacheStrategy: "per-plan-per-request-v1" as const,
  confirmationPolicy: "exact-plan-target-call-count-upper-cost-v2" as const,
};
const providerTarget = {
  stage: "target-selection" as const,
  schemaVersion: 1 as const,
  runId: "runner-target",
  provider: "fake-provider",
  model: "fake-model",
  api: "fake-api",
  reasoning: "fake-reasoning",
  samplingLockDigest: digest("a"),
  inventoryDigest: digest("b"),
  sampleDigest: digest("c"),
  providerPolicyDigest: providerPolicyDigest(providerPolicy),
};
let root = "";
let runNumber = 0;

type CompactionMode = "absent-candidate" | "none" | "retains-candidate";

function selectionInput(
  corpusId: string,
  key: string,
  compactionMode: CompactionMode = "none",
  target = providerTarget,
): FreezeSnapshotInput {
  const compacted = compactionMode !== "none";
  const pseudonym = (rawId: string) => hmacDigest(key, Buffer.from(rawId));
  const requestIds = [1, 2, 3, 4, 5].map((index) => pseudonym(`request-${index}`));
  return {
    selection: {
      schemaVersion: 1,
      corpusId,
      selectedRank: 1,
      status: "selected",
      reasonCode: "candidate-selected",
      annotationDigests: [digest("d"), digest("e")],
      adjudicationDigest: digest("f"),
      qualification: {
        schemaVersion: 1,
        corpusId,
        selectedRank: 1,
        qualifies: true,
        criteria: {
          parent: true,
          pressure: true,
          completedSegment: true,
          fiveSubsequentRequests: true,
        },
        reasonCodes: [],
        candidate: {
          branchLeafId: pseudonym("request-5"),
          startEntryId: pseudonym("start"),
          endEntryId: pseudonym("start"),
          closureEntryId: pseudonym("closure"),
          startOrder: 1,
          endOrder: 1,
          closureOrder: compacted ? 3 : 2,
          closureEvidence: ["goal-transition"],
          estimatedTokens: 2048,
          subsequentRequestIds: requestIds,
        },
        annotatorIds: [digest("b"), digest("c")],
        adjudicationStatus: "resolved",
      },
    },
    checkpoints: requestIds.map((requestEntryId, index) => {
      const entry = (rawId: string, role: "user" | "assistant", content: string) => ({
        entryId: pseudonym(rawId),
        message: { role, content },
      });
      const beforeCandidate =
        compactionMode === "retains-candidate"
          ? [
              {
                entryId: pseudonym("compact"),
                message: {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nnative summary that omits the candidate\n</summary>",
                    },
                  ],
                },
              },
            ]
          : [entry("root", "user", "root context")];
      const candidateRange = [entry("start", "user", "candidate context")];
      const afterCandidate = [
        entry("closure", "user", "closure context"),
        ...Array.from({ length: index }, (_, prior) =>
          entry(`request-${prior + 1}`, "assistant", `BASELINE_CANARY_${prior + 1}`),
        ),
      ];
      return {
        checkpointIndex: index + 1,
        requestEntryId,
        nativeContextDigest: nativeContextDigest({
          checkpointIndex: index + 1,
          requestEntryId,
          beforeCandidate,
          candidateRange,
          afterCandidate,
        }),
      };
    }),
    targetSelectionDigest: canonicalDigest(target),
    systemPromptDigest: digest("2"),
    toolSchemaDigest: digest("3"),
    summaryInstruction: "Produce a concise factual summary of the candidate context.",
    summaryInstructionDigest: summaryInstructionDigest(
      "Produce a concise factual summary of the candidate context.",
    ),
    rubricDigest: digest("5"),
    objectiveChecksDigest: digest("6"),
    fixture: { status: "unavailable", executionTarget: "none", reasonCode: "fixture-not-captured" },
    goldFacts: [
      {
        factId: digest("7"),
        category: "goal",
        sourceEntryIds: [pseudonym("start")],
        statement: "synthetic gold is never supplied to replay",
        diagnosticAtCheckpoints: [true, true, true, true, true],
      },
    ],
  };
}

async function preparedReplay(compactionMode: CompactionMode = "none", target = providerTarget) {
  const compacted = compactionMode !== "none";
  runNumber += 1;
  if (root === "") root = await mkdtemp(join(tmpdir(), "replay-test-"));
  const runId = `replay-${runNumber}`;
  const agentDir = join(root, runId);
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
  const run = await openSafeRun(agentDir, runId);
  const entryIds = [
    "root",
    "start",
    "closure",
    "request-1",
    "request-2",
    "request-3",
    "request-4",
    "request-5",
  ];
  const source = join(root, `${runId}.jsonl`);
  await writeFile(
    source,
    `${[
      {
        type: "session",
        id: "session",
        version: 2,
        timestamp: "2026-07-15T00:00:00.000Z",
        cwd: "/synthetic",
      },
      ...entryIds.flatMap((id, index) => [
        ...(compacted && id === "closure"
          ? [
              {
                type: "compaction",
                id: "compact",
                parentId: "start",
                timestamp: "2026-07-15T00:00:00.000Z",
                summary: "native summary that omits the candidate",
                firstKeptEntryId: compactionMode === "retains-candidate" ? "start" : "closure",
                tokensBefore: 10,
              },
            ]
          : []),
        {
          type: "message",
          id,
          parentId:
            index === 0 ? null : compacted && id === "closure" ? "compact" : entryIds[index - 1],
          timestamp: "2026-07-15T00:00:00.000Z",
          message:
            index < 3
              ? {
                  role: "user",
                  content: ["root context", "candidate context", "closure context"][index],
                }
              : {
                  role: "assistant",
                  content: `BASELINE_CANARY_${index - 2}`,
                  usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                },
        },
      ]),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const record = await inventorySource(source, generateCorpusKey());
  const copy = await createDisposableSessionCopy(record, run);
  assert.equal((await validateDisposableSessionCopy(copy)).status, "matched");
  const input = selectionInput(record.corpusId, key, compactionMode, target);
  const bundle = await freezeSnapshot(run, input);
  await persistFrozenSnapshot(run, bundle);
  return {
    access: await openReplaySnapshotAccess(run, record.corpusId),
    selection: input.selection,
    key,
    run,
  };
}

async function eligibleOrdinaryReplay(
  policy = providerPolicy,
  proofOutcome: "complete" | "incomplete" = "complete",
) {
  const target = {
    ...providerTarget,
    providerPolicyDigest: providerPolicyDigest(policy),
  };
  const prepared = await preparedReplay("none", target);
  const replayInput = { protocolSeed: "t012b", replicateCount: 3, requestBudget: 16 };
  const plan = await buildReplayPlan(prepared.access, prepared.selection, replayInput);
  const proofPolicy = {
    maxRetriesPerPlannedRequest: 1 as const,
    upperCostPerAttempt: { nativeCompaction: 0.01, followingMain: 0.02 },
    priceCardDigest: policy.priceCardDigest,
    cacheStrategy: policy.cacheStrategy,
    confirmationPolicy: "exact-generated-compaction-proof-v1" as const,
  };
  const proofConfirmation = createGeneratedCompactionProofConfirmation(
    target,
    policy,
    proofPolicy,
    digest("e"),
  );
  const proof = await runGeneratedCompactionProof({
    safeRun: prepared.run,
    targetSelection: target,
    providerPolicy: policy,
    proofPolicy,
    environmentDigest: digest("e"),
    confirmation: proofConfirmation,
    adapter: {
      kind: "fake",
      target: {
        provider: target.provider,
        model: target.model,
        api: target.api,
        reasoning: target.reasoning,
      },
      cacheCapability: {
        configuredStrategy: policy.cacheStrategy,
        observedIsolation: "isolated",
        namespace: "t012b-proof",
      },
      async execute(_request) {
        return {
          ok: true,
          billed: "billed",
          facts: generatedFacts(_request, proofOutcome === "complete" ? "complete" : "missing"),
        };
      },
    },
    now: () => "2026-07-15T00:00:00.000Z",
  });
  assert.equal(
    proof.resolution.outcome,
    proofOutcome === "complete" ? "complete" : "blocking-incomplete",
  );
  return {
    ...prepared,
    replayInput,
    plan,
    target,
    policy,
    confirmation: createProviderReplayConfirmation(plan, target, policy),
    gate: { frozenPlanDigest: plan.planDigest, resolution: proof.resolution },
  };
}

function replayAdapterTarget(target: typeof providerTarget) {
  return {
    provider: target.provider,
    model: target.model,
    api: target.api,
    reasoning: target.reasoning,
  };
}

async function readReplayLedger(run: Awaited<ReturnType<typeof preparedReplay>>["run"]) {
  const text = new TextDecoder().decode(await safeRunReadFile(run, PROVIDER_REPLAY_LEDGER_PATH));
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function executeEligible(
  eligible: Awaited<ReturnType<typeof eligibleOrdinaryReplay>>,
  adapter: ProviderReplayAdapter,
  confirmation: ProviderReplayConfirmation | string | undefined = eligible.confirmation,
  gate = eligible.gate,
) {
  return runProviderReplay({
    safeRun: eligible.run,
    replayAccess: eligible.access,
    selection: eligible.selection,
    replayInput: eligible.replayInput,
    plan: eligible.plan,
    targetSelection: eligible.target,
    providerPolicy: eligible.policy,
    confirmation,
    gate,
    adapter,
    now: () => "2026-07-15T00:00:01.000Z",
  });
}

after(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("provider-free paired replay", () => {
  it("constructs isolated five-checkpoint AB/BA teacher-forced contexts", async () => {
    const prepared = await preparedReplay();
    const pseudonym = (rawId: string) => hmacDigest(prepared.key, Buffer.from(rawId));
    const plan = await buildReplayPlan(prepared.access, prepared.selection, {
      protocolSeed: "synthetic-seed",
      replicateCount: 3,
      requestBudget: 4096,
    });

    assertPairedTeacherForcing(plan);
    assert.equal(plan.replicates.length, 3);
    const orders = plan.replicates.map((replicate) => replicate.armOrder.join("/"));
    assert.notEqual(orders[0], orders[1]);
    assert.equal(orders[0], orders[2]);
    for (const replicate of plan.replicates) {
      assert.equal(replicate.nativeContexts.length, 5);
      assert.equal(replicate.selectiveContexts.length, 5);
      assert.deepEqual(Object.keys(replicate.summaryGeneration).sort(), [
        "candidateMessages",
        "instruction",
      ]);
      for (const [index, native] of replicate.nativeContexts.entries()) {
        const selective = replicate.selectiveContexts[index]!;
        assert.deepEqual(
          { ...native, candidateRange: undefined },
          { ...selective, candidateRange: undefined },
        );
        assert.equal(native.shared.requestBudget, selective.shared.requestBudget);
        assert.equal(native.candidateRange.representation, "native-range");
        assert.equal(selective.candidateRange.representation, "selective-summary");
        assert.equal(
          JSON.stringify(native).includes(`BASELINE_CANARY_${index + 1}`),
          false,
          "the checkpoint's original assistant baseline must not be replayed",
        );
      }
    }

    const adapter = new SyntheticModelAdapter();
    const result = await executeSyntheticReplay(
      prepared.access,
      prepared.selection,
      { protocolSeed: "synthetic-seed", replicateCount: 3, requestBudget: 4096 },
      plan,
      adapter,
    );
    assert.equal(result.attempts.length, 33);
    assert.equal(result.attempts.filter((attempt) => attempt.kind === "summary").length, 3);
    assert.equal(result.attempts.filter((attempt) => attempt.kind === "checkpoint").length, 30);
    const mainOutputs = new Set(
      result.attempts
        .filter((attempt) => attempt.kind === "checkpoint")
        .map((attempt) => attempt.output),
    );
    for (const call of adapter.calls) {
      if (typeof call.input === "object" && call.input !== null) {
        assert.equal(JSON.stringify(call.input).includes("synthetic gold"), false);
        for (const output of mainOutputs)
          assert.equal(JSON.stringify(call.input).includes(output), false);
      }
    }
  });

  it("replays a Pi compaction when firstKeptEntryId retains the candidate", async () => {
    const prepared = await preparedReplay("retains-candidate");
    const input = { protocolSeed: "compaction-seed", replicateCount: 3, requestBudget: 16 };
    const plan = await buildReplayPlan(prepared.access, prepared.selection, input);
    const firstCheckpoint = plan.replicates[0]!.nativeContexts[0]!;

    assert.equal(
      JSON.stringify(firstCheckpoint.beforeCandidate).includes(
        "compacted into the following summary",
      ),
      true,
    );
    const result = await executeSyntheticReplay(prepared.access, prepared.selection, input, plan);
    assert.equal(result.attempts.length, 33);
  });

  it("fails closed when Pi compaction omits the candidate context", async () => {
    await assert.rejects(() => preparedReplay("absent-candidate"), {
      code: "E_EVAL_INTEGRITY",
      message: /cannot unambiguously map the candidate range/,
    });
  });

  it("enforces the bounded replicate protocol before plan allocation", async () => {
    const prepared = await preparedReplay();
    const maximum = { protocolSeed: "seed", replicateCount: 100, requestBudget: 1 };
    const plan = await buildReplayPlan(prepared.access, prepared.selection, maximum);
    assert.equal(plan.replicates.length, 100);
    await assert.rejects(
      () =>
        buildReplayPlan(prepared.access, prepared.selection, {
          ...maximum,
          replicateCount: Number.MAX_SAFE_INTEGER,
        }),
      { code: "E_EVAL_SCHEMA" },
    );
  });

  it("rejects fewer than three replicates", async () => {
    const prepared = await preparedReplay();
    const input = { protocolSeed: "seed", replicateCount: 2, requestBudget: 1 };
    await assert.rejects(() => buildReplayPlan(prepared.access, prepared.selection, input), {
      code: "E_EVAL_SCHEMA",
    });
  });

  it("rejects a forged plan even when its digest is recomputed", async () => {
    const prepared = await preparedReplay();
    const input = { protocolSeed: "seed", replicateCount: 3, requestBudget: 16 };
    const plan = await buildReplayPlan(prepared.access, prepared.selection, input);
    const forged = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
    const replicates = forged.replicates as Array<Record<string, unknown>>;
    const first = replicates[0]!;
    first.armOrder = ["native", "native"];
    const { planDigest: _ignored, ...unsigned } = forged;
    forged.planDigest = canonicalDigest({
      domain: "pi-blackbytes:context-pruning:replay-plan:v2",
      plan: unsigned,
    });
    await assert.rejects(
      () => validateReplayPlan(prepared.access, prepared.selection, input, forged),
      { code: "E_EVAL_INTEGRITY" },
    );
  });

  it("records an exact, content-free T-009B decline without an adapter or probe", async () => {
    const prepared = await preparedReplay();
    const proofPolicy = {
      maxRetriesPerPlannedRequest: 1 as const,
      upperCostPerAttempt: { nativeCompaction: 0.01, followingMain: 0.02 },
      priceCardDigest: providerPolicy.priceCardDigest,
      cacheStrategy: "per-plan-per-request-v1" as const,
      confirmationPolicy: "exact-generated-compaction-proof-v1" as const,
    };
    const environment = {
      schemaVersion: 1 as const,
      type: "t009b-generated-compaction-environment-v1" as const,
      runnerVersion: "test",
      platform: "generated",
    };
    const inputs = await prepareT009BPrivateInputs({
      safeRun: prepared.run,
      targetSelection: providerTarget,
      providerPolicy,
      proofPolicy,
      environment,
    });
    const plan = createGeneratedCompactionProofPlan(
      inputs.targetSelection,
      inputs.providerPolicy,
      inputs.proofPolicy,
      inputs.environment,
    );
    assert.equal(plan.plannedCalls.length, 2);
    assert.equal(plan.plannedCallCount, 4);
    assert.equal(plan.retryMax, 1);
    assert.equal(plan.upperCost, 0.06);
    const declined = await declineGeneratedCompactionProof({
      ...inputs,
      safeRun: prepared.run,
      planDigest: plan.planDigest,
    });
    assert.equal(declined.outcome, "blocking-incomplete");
    const verified = await verifyPersistedGeneratedCompactionProof({
      ...inputs,
      safeRun: prepared.run,
    });
    assert.equal(verified.outcome, "blocking-incomplete");
    const resumed = await declineGeneratedCompactionProof({
      ...inputs,
      safeRun: prepared.run,
      planDigest: plan.planDigest,
    });
    assert.equal(resumed.resolutionDigest, declined.resolutionDigest);
    assert.equal(
      JSON.stringify(
        await safeRunReadFile(
          prepared.run,
          `compaction-accounting-resolutions/${plan.generatedInputDigest}.json`,
        ),
      ).includes("BASELINE_CANARY"),
      false,
    );
  });

  it("uses a fixed internally generated T-009B proof before ordinary replay", async () => {
    const prepared = await preparedReplay();
    const input = { protocolSeed: "provider-success", replicateCount: 3, requestBudget: 16 };
    const plan = await buildReplayPlan(prepared.access, prepared.selection, input);
    const proofPolicy = {
      maxRetriesPerPlannedRequest: 1 as const,
      upperCostPerAttempt: { nativeCompaction: 0.01, followingMain: 0.02 },
      priceCardDigest: providerPolicy.priceCardDigest,
      cacheStrategy: "per-plan-per-request-v1" as const,
      confirmationPolicy: "exact-generated-compaction-proof-v1" as const,
    };
    const environment = {
      schemaVersion: 1 as const,
      type: "t009b-generated-compaction-environment-v1" as const,
      runnerVersion: "test",
      platform: "generated",
    };
    const environmentDigest = t009bEnvironmentDigest(environment);
    await prepareT009BPrivateInputs({
      safeRun: prepared.run,
      targetSelection: providerTarget,
      providerPolicy,
      proofPolicy,
      environment,
    });
    const proofConfirmation = createGeneratedCompactionProofConfirmation(
      providerTarget,
      providerPolicy,
      proofPolicy,
      environmentDigest,
    );
    const proof = await runGeneratedCompactionProof({
      safeRun: prepared.run,
      targetSelection: providerTarget,
      providerPolicy,
      proofPolicy,
      environmentDigest,
      confirmation: proofConfirmation,
      adapter: {
        kind: "fake",
        target: {
          provider: "fake-provider",
          model: "fake-model",
          api: "fake-api",
          reasoning: "fake-reasoning",
        },
        cacheCapability: {
          configuredStrategy: "per-plan-per-request-v1",
          observedIsolation: "isolated",
          namespace: "proof",
        },
        async execute(_request) {
          return { ok: true, billed: "billed", facts: generatedFacts(_request, "complete") };
        },
      },
      now: () => "2026-07-15T00:00:00.000Z",
    });
    assert.equal(proof.status, "completed");
    assert.equal(proof.plannedCallCount, 4);
    assert.equal(proof.upperCost, 0.06);
    assert.equal(proof.resolution.outcome, "complete");
    assert.equal(
      (
        await verifyPersistedGeneratedCompactionProof({
          safeRun: prepared.run,
          targetSelection: providerTarget,
          providerPolicy,
          proofPolicy,
          environment,
        })
      ).outcome,
      "complete",
    );

    const success = {
      ok: true as const,
      output: "private provider output",
      billed: "billed" as const,
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      },
    };
    const confirmation = createProviderReplayConfirmation(plan, providerTarget, providerPolicy);
    const adapter = new FakeReplayAdapter(Array.from({ length: 33 }, () => success));
    const result = await runProviderReplay({
      safeRun: prepared.run,
      replayAccess: prepared.access,
      selection: prepared.selection,
      replayInput: input,
      plan,
      targetSelection: providerTarget,
      providerPolicy,
      confirmation,
      gate: { frozenPlanDigest: plan.planDigest, resolution: proof.resolution },
      adapter,
      now: () => "2026-07-15T00:00:01.000Z",
    });
    assert.equal(result.status, "completed");
    assert.equal(adapter.calls.length, 33);
    const resumed = new FakeReplayAdapter([]);
    const resume = await runProviderReplay({
      safeRun: prepared.run,
      replayAccess: prepared.access,
      selection: prepared.selection,
      replayInput: input,
      plan,
      targetSelection: providerTarget,
      providerPolicy,
      confirmation,
      gate: { frozenPlanDigest: plan.planDigest, resolution: proof.resolution },
      adapter: resumed,
      now: () => "2026-07-15T00:00:02.000Z",
    });
    assert.equal(resume.status, "completed");
    assert.equal(resumed.calls.length, 0);
  });

  it("blocks incomplete generated proof and preserves unknown timeout billing", async () => {
    const prepared = await preparedReplay();
    const proofPolicy = {
      maxRetriesPerPlannedRequest: 1 as const,
      upperCostPerAttempt: { nativeCompaction: 0.01, followingMain: 0.02 },
      priceCardDigest: providerPolicy.priceCardDigest,
      cacheStrategy: "per-plan-per-request-v1" as const,
      confirmationPolicy: "exact-generated-compaction-proof-v1" as const,
    };
    const environmentDigest = digest("f");
    const confirmation = createGeneratedCompactionProofConfirmation(
      providerTarget,
      providerPolicy,
      proofPolicy,
      environmentDigest,
    );
    const proof = await runGeneratedCompactionProof({
      safeRun: prepared.run,
      targetSelection: providerTarget,
      providerPolicy,
      proofPolicy,
      environmentDigest,
      confirmation,
      adapter: {
        kind: "fake",
        target: {
          provider: "fake-provider",
          model: "fake-model",
          api: "fake-api",
          reasoning: "fake-reasoning",
        },
        cacheCapability: {
          configuredStrategy: "per-plan-per-request-v1",
          observedIsolation: "isolated",
          namespace: "proof",
        },
        async execute(_request) {
          return { ok: true, billed: "billed", facts: generatedFacts(_request, "missing") };
        },
      },
      now: () => "2026-07-15T00:00:00.000Z",
    });
    assert.equal(proof.resolution.outcome, "blocking-incomplete");
    const input = { protocolSeed: "blocked", replicateCount: 3, requestBudget: 16 };
    const plan = await buildReplayPlan(prepared.access, prepared.selection, input);
    const adapter = new FakeReplayAdapter([]);
    await assert.rejects(
      () =>
        runProviderReplay({
          safeRun: prepared.run,
          replayAccess: prepared.access,
          selection: prepared.selection,
          replayInput: input,
          plan,
          targetSelection: providerTarget,
          providerPolicy,
          confirmation: createProviderReplayConfirmation(plan, providerTarget, providerPolicy),
          gate: { frozenPlanDigest: plan.planDigest, resolution: proof.resolution },
          adapter,
          now: () => "2026-07-15T00:00:01.000Z",
        }),
      { code: "E_EVAL_INCOMPLETE" },
    );
    assert.equal(adapter.calls.length, 0);
  });
});

describe("T-012B provider replay acceptance", () => {
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  };
  const success = (output = "private provider output"): ProviderAdapterResult => ({
    ok: true,
    output,
    billed: "billed",
    usage,
  });

  it("uses the exact confirmed maximum including all checkpoints, summaries, and one retry each", async () => {
    const eligible = await eligibleOrdinaryReplay();
    const bound = providerReplayUpperBound(eligible.plan, providerPolicy);

    assert.deepEqual(bound, {
      plannedCallCount: 66,
      upperCost: 1.26,
      formula: "replicates * (2 * 5 * 2 * checkpointCost + 1 * 2 * summaryCost)",
    });
    assert.equal(eligible.confirmation.plannedCallCount, 66);
    assert.equal(eligible.confirmation.upperCost, 1.26);
    assert.equal(eligible.confirmation.providerPolicyDigest, providerPolicyDigest(providerPolicy));
  });

  it("refuses without confirmation and never invokes the fake adapter", async () => {
    const eligible = await eligibleOrdinaryReplay();
    const adapter = new FakeReplayAdapter([], replayAdapterTarget(eligible.target));

    const result = await runProviderReplay({
      safeRun: eligible.run,
      replayAccess: eligible.access,
      selection: eligible.selection,
      replayInput: eligible.replayInput,
      plan: eligible.plan,
      targetSelection: eligible.target,
      providerPolicy: eligible.policy,
      gate: eligible.gate,
      adapter,
      now: () => "2026-07-15T00:00:01.000Z",
    });

    assert.equal(result.status, "refused");
    assert.equal(result.attemptedCallCount, 0);
    assert.equal(adapter.calls.length, 0);
  });

  it("rejects a mismatched confirmation before invoking the fake adapter", async () => {
    const eligible = await eligibleOrdinaryReplay();
    const adapter = new FakeReplayAdapter([], replayAdapterTarget(eligible.target));

    await assert.rejects(() => executeEligible(eligible, adapter, digest("f")), {
      code: "E_EVAL_INTEGRITY",
    });
    assert.equal(adapter.calls.length, 0);
  });

  it("stops after one non-retryable failure and records a terminal complete attempt", async () => {
    const eligible = await eligibleOrdinaryReplay();
    const adapter = new FakeReplayAdapter(
      [{ ok: false, failureClass: "invalid-request", billed: "unbilled" }],
      replayAdapterTarget(eligible.target),
    );

    const result = await executeEligible(eligible, adapter);
    const events = await readReplayLedger(eligible.run);

    assert.equal(result.status, "failed");
    assert.equal(result.attemptedCallCount, 1);
    assert.equal(adapter.calls.length, 1);
    assert.equal(events.filter((event) => event.type === "provider-replay-start-v2").length, 1);
    assert.equal(events.filter((event) => event.type === "provider-replay-result-v2").length, 1);
    assert.equal(events.filter((event) => event.type === "provider-replay-usage-v2").length, 1);
  });

  it("links exactly two attempts when one retryable failure succeeds", async () => {
    const eligible = await eligibleOrdinaryReplay();
    const adapter = new FakeReplayAdapter(
      [
        { ok: false, failureClass: "rate-limit", billed: "unknown" },
        ...Array.from({ length: 33 }, () => success()),
      ],
      replayAdapterTarget(eligible.target),
    );

    const result = await executeEligible(eligible, adapter);

    assert.equal(result.status, "completed");
    assert.equal(result.attemptedCallCount, 34);
    assert.equal(adapter.calls.length, 34);
    assert.equal(adapter.calls[1]!.attempt, 2);
    assert.equal(adapter.calls[1]!.requestId, adapter.calls[0]!.requestId);
    assert.equal(
      adapter.calls[1]!.retryOf,
      canonicalDigest({
        domain: "provider-replay-ledger-v2",
        planDigest: eligible.plan.planDigest,
        requestId: adapter.calls[0]!.requestId,
        attempt: 1,
        phase: "start",
      }),
    );
  });

  it("stops after a second retryable failure", async () => {
    const eligible = await eligibleOrdinaryReplay();
    const adapter = new FakeReplayAdapter(
      [
        { ok: false, failureClass: "timeout", billed: "unknown" },
        { ok: false, failureClass: "timeout", billed: "unknown" },
      ],
      replayAdapterTarget(eligible.target),
    );

    const result = await executeEligible(eligible, adapter);

    assert.equal(result.status, "failed");
    assert.equal(result.attemptedCallCount, 2);
    assert.equal(adapter.calls.length, 2);
    assert.equal(adapter.calls[0]!.attempt, 1);
    assert.equal(adapter.calls[1]!.attempt, 2);
  });

  it("uses the same frozen retry and timeout policy for both replay arms", async () => {
    const eligible = await eligibleOrdinaryReplay();
    const adapter = new FakeReplayAdapter(
      Array.from({ length: 33 }, () => success()),
      replayAdapterTarget(eligible.target),
    );

    const result = await executeEligible(eligible, adapter);
    const events = await readReplayLedger(eligible.run);
    const starts = events.filter((event) => event.type === "provider-replay-start-v2");

    assert.equal(result.status, "completed");
    assert.ok(adapter.calls.some((call) => call.arm === "native"));
    assert.ok(adapter.calls.some((call) => call.arm === "selective"));
    for (const call of adapter.calls)
      assert.equal(call.timeoutMs, providerPolicy.timeoutMs[call.kind]);
    for (const event of starts) {
      const data = event.data as Record<string, unknown>;
      assert.equal(data.providerPolicyDigest, providerPolicyDigest(providerPolicy));
      assert.equal(data.timeoutMs, providerPolicy.timeoutMs[data.kind as "summary" | "checkpoint"]);
    }
  });

  it("keeps billed failed usage and cost with its linked retry in the private ledger", async () => {
    const eligible = await eligibleOrdinaryReplay();
    const adapter = new FakeReplayAdapter(
      [
        { ok: false, failureClass: "rate-limit", billed: "billed", usage },
        ...Array.from({ length: 33 }, () => success("secret output")),
      ],
      replayAdapterTarget(eligible.target),
    );

    await executeEligible(eligible, adapter);
    const events = await readReplayLedger(eligible.run);
    const retryStart = events.find(
      (event) =>
        event.type === "provider-replay-start-v2" &&
        (event.data as Record<string, unknown>).attempt === 2,
    );
    const failedUsage = events.find(
      (event) =>
        event.type === "provider-replay-usage-v2" &&
        (event.data as Record<string, unknown>).attempt === 1,
    );

    assert.ok(retryStart);
    assert.ok(failedUsage);
    assert.equal((failedUsage.data as Record<string, unknown>).billedDisposition, "billed");
    assert.deepEqual((failedUsage.data as Record<string, unknown>).usage, usage);
    assert.equal(
      (retryStart.data as Record<string, unknown>).retryOf,
      canonicalDigest({
        domain: "provider-replay-ledger-v2",
        planDigest: eligible.plan.planDigest,
        requestId: (failedUsage.data as Record<string, unknown>).requestId,
        attempt: 1,
        phase: "start",
      }),
    );
  });

  it("rejects frozen-plan mismatch and incomplete accounting before adapter calls", async () => {
    const mismatch = await eligibleOrdinaryReplay();
    const mismatchAdapter = new FakeReplayAdapter([], replayAdapterTarget(mismatch.target));
    await assert.rejects(
      () =>
        executeEligible(mismatch, mismatchAdapter, mismatch.confirmation, {
          ...mismatch.gate,
          frozenPlanDigest: digest("f"),
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
    assert.equal(mismatchAdapter.calls.length, 0);

    const incomplete = await eligibleOrdinaryReplay(providerPolicy, "incomplete");
    const incompleteAdapter = new FakeReplayAdapter([], replayAdapterTarget(incomplete.target));
    await assert.rejects(() => executeEligible(incomplete, incompleteAdapter), {
      code: "E_EVAL_INCOMPLETE",
    });
    assert.equal(incompleteAdapter.calls.length, 0);
  });

  it("normalizes timeout and thrown adapters into complete, content-free failure ledger chains", async () => {
    const fastPolicy = {
      ...providerPolicy,
      timeoutMs: { summary: 5, checkpoint: 5 },
    };
    const timedOut = await eligibleOrdinaryReplay(fastPolicy);
    const timeoutCalls: ProviderReplayRequest[] = [];
    const timeoutAdapter: ProviderReplayAdapter = {
      kind: "fake",
      target: replayAdapterTarget(timedOut.target),
      cacheCapability: {
        configuredStrategy: fastPolicy.cacheStrategy,
        observedIsolation: "isolated",
        namespace: "timeout",
      },
      async execute(request) {
        timeoutCalls.push(request);
        return new Promise<ProviderAdapterResult>((resolve) =>
          request.signal.addEventListener(
            "abort",
            () => resolve({ ok: false, failureClass: "timeout", billed: "unknown" }),
            { once: true },
          ),
        );
      },
    };
    const timeoutResult = await executeEligible(timedOut, timeoutAdapter);
    const timeoutLedger = await readReplayLedger(timedOut.run);
    const timeoutAttempts = timeoutLedger.filter((event) =>
      [
        "provider-replay-start-v2",
        "provider-replay-result-v2",
        "provider-replay-usage-v2",
      ].includes(event.type as string),
    );
    assert.equal(timeoutResult.status, "failed");
    assert.equal(timeoutCalls.length, 2);
    assert.equal(timeoutAttempts.length, 6);
    assert.equal((timeoutAttempts[4]!.data as Record<string, unknown>).failureClass, "timeout");
    assert.equal(
      (timeoutAttempts[5]!.data as Record<string, unknown>).usageCompleteness,
      "missing",
    );

    const thrown = await eligibleOrdinaryReplay();
    const thrownAdapter: ProviderReplayAdapter = {
      kind: "fake",
      target: replayAdapterTarget(thrown.target),
      cacheCapability: {
        configuredStrategy: providerPolicy.cacheStrategy,
        observedIsolation: "isolated",
        namespace: "thrown",
      },
      async execute() {
        throw new Error("adapter secret content must not be persisted");
      },
    };
    const thrownResult = await executeEligible(thrown, thrownAdapter);
    const ledger = await readReplayLedger(thrown.run);

    const attemptEvents = ledger.filter((event) =>
      [
        "provider-replay-start-v2",
        "provider-replay-result-v2",
        "provider-replay-usage-v2",
      ].includes(event.type as string),
    );
    assert.equal(thrownResult.status, "failed");
    assert.equal(thrownResult.attemptedCallCount, 1);
    assert.equal(attemptEvents.length, 3);
    assert.equal((attemptEvents[1]!.data as Record<string, unknown>).failureClass, "unknown");
    assert.equal((attemptEvents[2]!.data as Record<string, unknown>).usageCompleteness, "missing");
    assert.equal(JSON.stringify(ledger).includes("adapter secret content"), false);
    assert.equal(JSON.stringify(ledger).includes("candidate context"), false);
  });

  it("keeps successful output private and absent from the content-free ledger", async () => {
    const eligible = await eligibleOrdinaryReplay();
    const adapter = new FakeReplayAdapter(
      Array.from({ length: 33 }, () => success("PRIVATE_PROVIDER_OUTPUT")),
      replayAdapterTarget(eligible.target),
    );

    await executeEligible(eligible, adapter);
    const raw = new TextDecoder().decode(
      await safeRunReadFile(eligible.run, PROVIDER_REPLAY_LEDGER_PATH),
    );

    assert.equal(raw.includes("PRIVATE_PROVIDER_OUTPUT"), false);
    assert.equal(raw.includes("candidate context"), false);
    assert.equal(raw.includes("secret output"), false);
  });
});
