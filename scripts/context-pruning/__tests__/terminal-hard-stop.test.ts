/** Hermetic public-CLI terminal hard-stop coverage: no corpus, provider, or Pi process access. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalDigest, canonicalJson } from "../canonical-json.js";
import {
  atomicManifestWrite,
  corpusKeyDigest,
  hmacDigest,
  loadOrCreateCorpusKey,
} from "../evidence-store.js";
import { loadVerifiedT017AggregateSummary } from "../formal-run.js";
import { createGeneratedCompactionUsageFixture } from "../lifecycle/compaction-usage.js";
import {
  ensurePrivateDir,
  ensurePrivateRunRoot,
  openSafeRun,
  safeRunPath,
  safeRunReadFile,
  safeRunReaddir,
  safeRunWriteFile,
} from "../path-safety.js";
import {
  createGeneratedCompactionProofConfirmation,
  prepareT009BPrivateInputs,
  providerPolicyDigest,
  runGeneratedCompactionProof,
  t009bEnvironmentDigest,
} from "../provider-runner.js";
import { inventoryDigest, sampleInventory, sampleManifestDigest } from "../sampling.js";
import type { RunManifest } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "cli.ts");
const roots: string[] = [];
const digest = (character: string): string => character.repeat(64);

const policy = {
  maxRetriesPerPlannedRequest: 1 as const,
  retryableErrorClasses: ["timeout", "rate-limit"] as const,
  timeoutMs: { summary: 1_000, checkpoint: 2_000 },
  upperCostPerAttempt: { summary: 0.01, checkpoint: 0.02 },
  priceCardDigest: digest("8"),
  cacheStrategy: "per-plan-per-request-v1" as const,
  confirmationPolicy: "exact-plan-target-call-count-upper-cost-v2" as const,
};

function runCli(args: readonly string[], env?: Readonly<Record<string, string>>) {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: resolve(__dirname, "..", "..", ".."),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error: unknown) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

function hardStopBase(prepared: Awaited<ReturnType<typeof preparedHardStop>>): readonly string[] {
  return ["--run-id", prepared.runId, "--pi-agent-dir", prepared.agent];
}

function recordFullTerminalChain(prepared: Awaited<ReturnType<typeof preparedHardStop>>): void {
  const base = hardStopBase(prepared);
  for (const [stage, extra] of [
    ["qualify", ["--ranks", "1-20"]],
    ["qualify", ["--ranks", "21-40"]],
    ["adjudicate", []],
    ["freeze", []],
    ["lifecycle", []],
    ["replay", []],
  ] as const) {
    const result = runCli([
      stage,
      ...base,
      ...extra,
      "--not-applicable",
      prepared.resolutionDigest,
    ]);
    assert.equal(result.status, 0, result.stderr);
  }
}

async function preparedHardStop() {
  const root = await mkdtemp(join(tmpdir(), "terminal-hard-stop-"));
  roots.push(root);
  const agent = join(root, "agent");
  const runId = "hard-stop";
  const preRun = await ensurePrivateRunRoot(agent, runId);
  const key = await loadOrCreateCorpusKey(preRun);
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId,
    createdAt: "2026-07-16T00:00:00.000Z",
    corpusKeyDigest: corpusKeyDigest(key),
    eventCount: 0,
  };
  await atomicManifestWrite(preRun, manifest);
  const safeRun = await openSafeRun(agent, runId);
  const samplingLock = {
    stage: "sampling-lock" as const,
    schemaVersion: 1 as const,
    runId,
    protocolSeed: "test-seed",
    longSessionMinRequests: 20 as const,
    collectionWindowEndsAt: "2026-12-31T00:00:00.000Z",
    maxInventoryRefreshes: 0,
    modelRegistryDigest: digest("a"),
    estimatorPolicyDigest: digest("b"),
  };
  const records = Array.from({ length: 50 }, (_, index) =>
    Object.freeze({
      schemaVersion: 1 as const,
      corpusId: (index + 1).toString(16).padStart(64, "0"),
      repositoryId: digest("e"),
      lineageRootId: (index + 101).toString(16).padStart(64, "0"),
      sourceDigest: (index + 201).toString(16).padStart(64, "0"),
      bytes: 1,
      mtimeMs: 1,
      parentStatus: "parent" as const,
      parseStatus: "valid" as const,
      entryCounts: {
        session: 1,
        message: 1,
        thinking_level_change: 0,
        model_change: 0,
        compaction: 0,
        branch_summary: 0,
        custom: 0,
        label: 0,
        session_info: 0,
        custom_message: 0,
        unknown: 0,
        malformed: 0,
      },
      roleCounts: { user: 0, assistant: 0, toolResult: 0, unknown: 0 },
      usageTotals: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      requestCount: 20,
      branchCount: 1,
      selectedLeafId: (index + 301).toString(16).padStart(64, "0"),
      selectedLeafLineIndex: 1,
      finalBranchEntryCount: 1,
      finalBranchRequestCount: 20,
      abandonedEntryCount: 0,
      lineageStatus: "root" as const,
      lineageDisposition: "unique" as const,
      usageCompleteness: 1,
      compactionCount: 0,
      exclusionReasons:
        index === 0
          ? ["malformed-jsonl"]
          : index <= 4
            ? ["missing-parent"]
            : index <= 9
              ? ["unresolved-parent-session"]
              : [],
    }),
  );
  const inventory = {
    schemaVersion: 1 as const,
    runId,
    attemptIndex: 0,
    samplingLockDigest: canonicalDigest(samplingLock),
    inventoryDigest: inventoryDigest(records),
    sourceCount: records.length,
    eligibleFrameSize: 40,
    records,
  };
  const sampled = sampleInventory({
    samplingLock,
    inventoryRecords: records,
    attemptIndex: 0,
    now: samplingLock.collectionWindowEndsAt,
  });
  assert.equal(sampled.status, "frozen");
  if (sampled.status !== "frozen") throw new Error("fixture must freeze its sample");
  await ensurePrivateDir(safeRun, "inventory");
  await safeRunWriteFile(safeRun, "inventory/attempt-0.json", canonicalJson(inventory));
  await safeRunWriteFile(safeRun, "sample.json", canonicalJson(sampled.manifest));
  const target = {
    stage: "target-selection" as const,
    schemaVersion: 1 as const,
    runId,
    provider: "fake-provider",
    model: "fake-model",
    api: "fake-api",
    reasoning: "fake-reasoning",
    samplingLockDigest: canonicalDigest(samplingLock),
    inventoryDigest: inventory.inventoryDigest,
    sampleDigest: sampleManifestDigest(sampled.manifest),
    providerPolicyDigest: providerPolicyDigest(policy),
  };
  const proofPolicy = {
    maxRetriesPerPlannedRequest: 1 as const,
    upperCostPerAttempt: { nativeCompaction: 0.01, followingMain: 0.02 },
    priceCardDigest: policy.priceCardDigest,
    cacheStrategy: policy.cacheStrategy,
    confirmationPolicy: "exact-generated-compaction-proof-v1" as const,
  };
  const environment = {
    schemaVersion: 1 as const,
    type: "t009b-generated-compaction-environment-v1" as const,
    runnerVersion: "test",
    platform: "generated",
  };
  await safeRunWriteFile(safeRun, "sampling.lock.json", canonicalJson(samplingLock));
  await safeRunWriteFile(safeRun, "target-selection.json", canonicalJson(target));
  const targetAnchorUnsigned = { schemaVersion: 1, targetSelectionDigest: canonicalDigest(target) };
  await ensurePrivateDir(safeRun, "private");
  await safeRunWriteFile(
    safeRun,
    "private/target-selection.anchor.json",
    canonicalJson({
      ...targetAnchorUnsigned,
      authenticationTag: hmacDigest(
        key,
        Buffer.from(
          `pi-blackbytes:context-pruning:target-anchor:v1\0${canonicalJson(targetAnchorUnsigned)}`,
          "utf8",
        ),
      ),
    }),
  );
  await prepareT009BPrivateInputs({
    safeRun,
    targetSelection: target,
    providerPolicy: policy,
    proofPolicy,
    environment,
  });
  let providerCalls = 0;
  const environmentDigest = t009bEnvironmentDigest(environment);
  const confirmation = createGeneratedCompactionProofConfirmation(
    target,
    policy,
    proofPolicy,
    environmentDigest,
  );
  const fixture = createGeneratedCompactionUsageFixture().missing.events;
  const proof = await runGeneratedCompactionProof({
    safeRun,
    targetSelection: target,
    providerPolicy: policy,
    proofPolicy,
    environmentDigest,
    confirmation,
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
        namespace: "test",
      },
      async execute(request) {
        providerCalls += 1;
        const native = request.operation === "native-compaction";
        return {
          ok: true as const,
          billed: "unbilled" as const,
          facts: fixture
            .filter((fact) =>
              native
                ? fact.type !== "before_provider_request" &&
                  fact.type !== "usage_observation" &&
                  fact.type !== "message_end"
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
            ),
        };
      },
    },
    now: () => "2026-07-16T00:00:00.000Z",
  });
  assert.equal(proof.resolution.outcome, "blocking-incomplete");
  return {
    root,
    agent,
    runId,
    resolutionDigest: proof.resolution.resolutionDigest,
    providerCalls: () => providerCalls,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("terminal hard-stop public CLI", () => {
  it("records all authenticated stages then emits and verifies the only NO-GO without further adapter calls", async () => {
    const prepared = await preparedHardStop();
    const base = ["--run-id", prepared.runId, "--pi-agent-dir", prepared.agent];
    const before = prepared.providerCalls();
    const stages = [
      ["qualify", ["--ranks", "1-20"]],
      ["qualify", ["--ranks", "21-40"]],
      ["adjudicate", []],
      ["freeze", []],
      ["lifecycle", []],
      ["replay", []],
    ] as const;
    for (const [index, [stage, extra]] of stages.entries()) {
      const result = runCli([
        stage,
        ...base,
        ...extra,
        "--not-applicable",
        prepared.resolutionDigest,
      ]);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "not-applicable");
      if (stage === "qualify") assert.equal(output.ranks, extra[1]);
      const progress = runCli(["verify", ...base]);
      assert.equal(progress.status, 0, progress.stderr);
      const progressOutput = JSON.parse(progress.stdout);
      assert.equal(progressOutput.terminal, "hard-stop-in-progress");
      assert.equal(progressOutput.verifiedDispositions, index + 1);
    }
    const safeRun = await openSafeRun(prepared.agent, prepared.runId);
    const dispositions = await safeRunReaddir(safeRun, "terminal-hard-stop");
    assert.deepEqual(dispositions.map((entry) => entry.name).sort(), [
      "adjudication.json",
      "freeze.json",
      "lifecycle.json",
      "qualification-1-20.json",
      "qualification-21-40.json",
      "replay.json",
    ]);
    const decision = runCli(["decide", ...base]);
    assert.equal(decision.status, 0, decision.stderr);
    assert.equal(JSON.parse(decision.stdout).decision, "NO-GO");
    const persistedDecision = JSON.parse(
      (await safeRunReadFile(safeRun, "terminal-hard-stop/decision.json")).toString("utf8"),
    ) as { decisionTrace: readonly { id: string; status: string; threshold: string }[] };
    assert.deepEqual(
      persistedDecision.decisionTrace.map(({ id, status, threshold }) => ({
        id,
        status,
        threshold,
      })),
      [
        { id: "G001.recall", status: "unavailable", threshold: ">= -0.05" },
        { id: "G001.completion", status: "unavailable", threshold: ">= 0" },
        { id: "G001.severe-event", status: "unavailable", threshold: "must be false" },
        { id: "G002.actual-usage", status: "blocked", threshold: "complete attributable usage" },
        { id: "G002.median-reduction", status: "unavailable", threshold: ">= 0.1" },
        { id: "G002.break-even-by-5", status: "unavailable", threshold: ">= 0.5" },
        { id: "G003.sample-count", status: "blocked", threshold: "= 40" },
        { id: "G003.qualifying-snapshots", status: "blocked", threshold: ">= 10" },
        { id: "G004.provenance", status: "unavailable", threshold: "= 0 false positives" },
        { id: "G004.lifecycle-scenarios", status: "unavailable", threshold: "= 0 misses" },
        { id: "G004.p95", status: "unavailable", threshold: "< 25ms" },
        {
          id: "REVISE.utility",
          status: "unavailable",
          threshold: "[0.05, 0.1) with break-even >= 0.5",
        },
        {
          id: "REVISE.performance",
          status: "unavailable",
          threshold: "[25ms, 50ms] with non-invasive optimization",
        },
        {
          id: "REVISE.lifecycle",
          status: "unavailable",
          threshold: "one non-provenance miss with non-invasive fix",
        },
        {
          id: "REVISE.provider-data",
          status: "blocked",
          threshold: "one permitted collection extension",
        },
        {
          id: "REVISE.exactly-one-deviation",
          status: "blocked",
          threshold: "exactly one permitted deviation",
        },
        { id: "OUTCOME", status: "terminal", threshold: "any blocked required gate => NO-GO" },
      ],
    );
    const report = runCli(["report", ...base]);
    assert.equal(report.status, 0, report.stderr);
    const candidate = JSON.parse(report.stdout);
    assert.equal(candidate.outcome, "NO-GO");
    assert.equal(
      candidate.aggregates.every((item: { status: string }) => item.status === "suppressed"),
      true,
    );
    assert.deepEqual(candidate.corpusSummary, {
      sourceCount: 50,
      eligibleFrameSize: 40,
      sampleSize: 40,
      sensitivity: { atLeast10: 40, atLeast15: 40, atLeast20: 40, atLeast25: 0 },
      exclusionReasons: { malformedJsonl: null, missingParent: null, unresolvedParentSession: 5 },
      repositoryConcentration: {
        frame: { repositoryCount: 1, dominantCount: 40, dominantShare: 1 },
        sample: { repositoryCount: 1, dominantCount: 40, dominantShare: 1 },
      },
    });
    const candidateText = JSON.stringify(candidate);
    assert.equal(candidateText.includes(prepared.runId), false);
    assert.equal(candidateText.includes(digest("e")), false);
    assert.doesNotMatch(
      candidateText,
      /repositoryId|corpusId|sessionId|entryId|sourcePath|content|prompt|output/,
    );
    const supplementText = (
      await safeRunReadFile(safeRun, "terminal-hard-stop/report-supplement-v1.json")
    ).toString("utf8");
    assert.equal(supplementText.includes(digest("e")), false);
    assert.doesNotMatch(supplementText, /repositoryId|corpusId|sessionId|entryId|sourcePath/);
    const supplement = JSON.parse(supplementText) as {
      gateEvidence: { sampleCount: { actual: number; required: number; status: string } };
    };
    assert.deepEqual(supplement.gateEvidence.sampleCount, {
      actual: 40,
      required: 40,
      status: "passed",
    });
    const primaryReport = await safeRunReadFile(
      safeRun,
      "terminal-hard-stop/report.aggregate.json",
    );
    assert.equal(runCli(["report", ...base]).status, 0);
    assert.deepEqual(
      await safeRunReadFile(safeRun, "terminal-hard-stop/report.aggregate.json"),
      primaryReport,
    );
    const verify = runCli(["verify", ...base]);
    assert.equal(verify.status, 0, verify.stderr);
    assert.deepEqual(JSON.parse(verify.stdout), {
      report: "verified",
      status: "verified",
      terminal: "NO-GO",
    });
    assert.equal(prepared.providerCalls(), before);
  });

  it("fails closed for wrong digest, duplicate disposition, and unsupported content/provider options", async () => {
    const prepared = await preparedHardStop();
    const base = ["--run-id", prepared.runId, "--pi-agent-dir", prepared.agent];
    for (const args of [
      ["qualify", ...base, "--ranks", "1-20", "--not-applicable", digest("0")],
      [
        "qualify",
        ...base,
        "--ranks",
        "1-20",
        "--not-applicable",
        prepared.resolutionDigest,
        "--input",
        "content.json",
      ],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 1);
      assert.ok(["E_EVAL_CONFIG", "E_EVAL_INTEGRITY"].includes(JSON.parse(result.stderr).code));
    }
    const first = runCli([
      "qualify",
      ...base,
      "--ranks",
      "1-20",
      "--not-applicable",
      prepared.resolutionDigest,
    ]);
    assert.equal(first.status, 0, first.stderr);
    const duplicate = runCli([
      "qualify",
      ...base,
      "--ranks",
      "1-20",
      "--not-applicable",
      prepared.resolutionDigest,
    ]);
    assert.equal(duplicate.status, 1);
    assert.equal(JSON.parse(duplicate.stderr).code, "E_EVAL_INTEGRITY");
  });

  it("rejects ordinary input before the child can consume its canary after T-009B blocks", async () => {
    const prepared = await preparedHardStop();
    const canary = join(prepared.root, "ordinary-mode-canary.json");
    await writeFile(canary, "not-json-and-must-not-be-read", "utf8");
    const result = runCli(["freeze", ...hardStopBase(prepared), "--input", canary]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "E_EVAL_INCOMPLETE");
  });

  it("selects terminal verify immediately after T-009B blocks, before any disposition exists", async () => {
    const prepared = await preparedHardStop();
    const result = runCli(["verify", ...hardStopBase(prepared)]);
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr) as { code: string; message: string };
    assert.equal(error.code, "E_EVAL_INCOMPLETE");
    assert.match(error.message, /T-018 qualification disposition is missing/);
  });

  it("returns a structured error for an invalid run during pre-import hard-stop detection", async () => {
    const prepared = await preparedHardStop();
    const result = runCli([
      "lifecycle",
      "--run-id",
      "missing-run",
      "--pi-agent-dir",
      prepared.agent,
      "--scenario",
      "compaction-accounting",
      "--dry-run",
    ]);
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr) as { code: string; message: string };
    assert.match(error.code, /^E_EVAL_/);
    assert.equal(error.message.includes(prepared.agent), false);
  });

  it("rejects default-directory T-009B confirmation before importing its adapter", async () => {
    const prepared = await preparedHardStop();
    const marker = join(prepared.root, "adapter-imported");
    const adapter = join(prepared.root, "adapter-canary.mjs");
    await writeFile(
      adapter,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "imported");\nexport const GeneratedCompactionProofAdapter = { kind: "external", async execute() { throw new Error("must not execute"); } };\n`,
      "utf8",
    );
    const result = runCli(
      [
        "lifecycle",
        "--run-id",
        prepared.runId,
        "--scenario",
        "compaction-accounting",
        "--confirm",
        digest("0"),
        "--adapter-module",
        adapter,
      ],
      { PI_AGENT_DIR: prepared.agent },
    );
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "E_EVAL_INCOMPLETE");
    await assert.rejects(access(marker));
  });

  it("refuses a cross-run copied HMAC disposition and a mutated closed-schema tag", async () => {
    const first = await preparedHardStop();
    const second = await preparedHardStop();
    const firstBase = hardStopBase(first);
    const secondBase = hardStopBase(second);
    const copied = runCli([
      "qualify",
      ...firstBase,
      "--ranks",
      "1-20",
      "--not-applicable",
      first.resolutionDigest,
    ]);
    assert.equal(copied.status, 0, copied.stderr);
    const firstRun = await openSafeRun(first.agent, first.runId);
    const secondRun = await openSafeRun(second.agent, second.runId);
    await ensurePrivateDir(secondRun, "terminal-hard-stop");
    await safeRunWriteFile(
      secondRun,
      "terminal-hard-stop/qualification-1-20.json",
      (await safeRunReadFile(firstRun, "terminal-hard-stop/qualification-1-20.json")).toString(
        "utf8",
      ),
    );
    for (const [stage, extra] of [
      ["qualify", ["--ranks", "21-40"]],
      ["adjudicate", []],
      ["freeze", []],
      ["lifecycle", []],
      ["replay", []],
    ] as const) {
      const result = runCli([
        stage,
        ...secondBase,
        ...extra,
        "--not-applicable",
        second.resolutionDigest,
      ]);
      assert.equal(result.status, 0, result.stderr);
    }
    const copiedDecision = runCli(["decide", ...secondBase]);
    assert.equal(copiedDecision.status, 1);
    assert.equal(JSON.parse(copiedDecision.stderr).code, "E_EVAL_INTEGRITY");

    for (const [stage, extra] of [
      ["qualify", ["--ranks", "21-40"]],
      ["adjudicate", []],
      ["freeze", []],
      ["lifecycle", []],
      ["replay", []],
    ] as const) {
      const result = runCli([
        stage,
        ...firstBase,
        ...extra,
        "--not-applicable",
        first.resolutionDigest,
      ]);
      assert.equal(result.status, 0, result.stderr);
    }
    const original = JSON.parse(
      (await safeRunReadFile(firstRun, "terminal-hard-stop/qualification-1-20.json")).toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    await safeRunWriteFile(
      firstRun,
      "terminal-hard-stop/qualification-1-20.json",
      canonicalJson({ ...original, authenticationTag: digest("0") }),
    );
    const mutatedDecision = runCli(["decide", ...firstBase]);
    assert.equal(mutatedDecision.status, 1);
    assert.equal(JSON.parse(mutatedDecision.stderr).code, "E_EVAL_INTEGRITY");
    await safeRunWriteFile(
      firstRun,
      "terminal-hard-stop/qualification-1-20.json",
      canonicalJson({ ...original, unexpected: "schema-mutation" }),
    );
    const schemaMutation = runCli(["decide", ...firstBase]);
    assert.equal(schemaMutation.status, 1);
    assert.equal(JSON.parse(schemaMutation.stderr).code, "E_EVAL_INTEGRITY");
  });

  it("rejects an unauthenticated target before producing a safe aggregate summary", async () => {
    const prepared = await preparedHardStop();
    const safeRun = await openSafeRun(prepared.agent, prepared.runId);
    const path = "private/target-selection.anchor.json";
    const anchor = JSON.parse((await safeRunReadFile(safeRun, path)).toString("utf8")) as Record<
      string,
      unknown
    >;
    await safeRunWriteFile(
      safeRun,
      path,
      canonicalJson({ ...anchor, authenticationTag: digest("0") }),
    );
    await assert.rejects(
      loadVerifiedT017AggregateSummary(safeRun),
      /Target selection anchor authentication failed/,
    );
  });

  it("rejects premature report files before decision and local-report publication", async () => {
    const beforeDecision = await preparedHardStop();
    recordFullTerminalChain(beforeDecision);
    const beforeDecisionRun = await openSafeRun(beforeDecision.agent, beforeDecision.runId);
    await safeRunWriteFile(beforeDecisionRun, "terminal-hard-stop/report.local.json", "{}");
    const prematureLocal = runCli(["verify", ...hardStopBase(beforeDecision)]);
    assert.equal(prematureLocal.status, 1);
    assert.equal(JSON.parse(prematureLocal.stderr).code, "E_EVAL_INTEGRITY");

    const beforeLocal = await preparedHardStop();
    recordFullTerminalChain(beforeLocal);
    assert.equal(runCli(["decide", ...hardStopBase(beforeLocal)]).status, 0);
    const beforeLocalRun = await openSafeRun(beforeLocal.agent, beforeLocal.runId);
    await safeRunWriteFile(beforeLocalRun, "terminal-hard-stop/report.aggregate.json", "{}");
    const prematureAggregate = runCli(["verify", ...hardStopBase(beforeLocal)]);
    assert.equal(prematureAggregate.status, 1);
    assert.equal(JSON.parse(prematureAggregate.stderr).code, "E_EVAL_INTEGRITY");
  });

  it("upgrades legacy primary reports append-only, resumes publication, and rejects drift", async () => {
    const prepared = await preparedHardStop();
    const base = hardStopBase(prepared);
    recordFullTerminalChain(prepared);
    assert.equal(runCli(["decide", ...base]).status, 0);
    assert.equal(runCli(["report", ...base]).status, 0);
    const safeRun = await openSafeRun(prepared.agent, prepared.runId);
    const primaryPaths = [
      "terminal-hard-stop/decision.json",
      "terminal-hard-stop/report.local.json",
      "terminal-hard-stop/report.aggregate.json",
    ] as const;
    const primaryBytes = await Promise.all(
      primaryPaths.map((path) => safeRunReadFile(safeRun, path)),
    );

    await unlink(safeRunPath(safeRun, "terminal-hard-stop/report.aggregate.json"));
    const partial = runCli(["verify", ...base]);
    assert.equal(partial.status, 0, partial.stderr);
    assert.equal(JSON.parse(partial.stdout).nextStage, "report");
    assert.equal(runCli(["report", ...base]).status, 0);

    await unlink(safeRunPath(safeRun, "terminal-hard-stop/report-supplement-v1.json"));
    const legacyFiles = (await safeRunReaddir(safeRun, "terminal-hard-stop"))
      .map((entry) => entry.name)
      .sort();
    const missingSupplement = runCli(["verify", ...base]);
    assert.equal(missingSupplement.status, 0, missingSupplement.stderr);
    assert.equal(JSON.parse(missingSupplement.stdout).nextStage, "report");
    assert.equal(runCli(["report", ...base]).status, 0);
    assert.deepEqual(
      await Promise.all(primaryPaths.map((path) => safeRunReadFile(safeRun, path))),
      primaryBytes,
    );
    assert.deepEqual(
      (await safeRunReaddir(safeRun, "terminal-hard-stop"))
        .map((entry) => entry.name)
        .filter((name) => name !== "report-supplement-v1.json")
        .sort(),
      legacyFiles,
    );

    await safeRunWriteFile(safeRun, "terminal-hard-stop/report-supplement-v1.json", "{}");
    const conflict = runCli(["report", ...base]);
    assert.equal(conflict.status, 1);
    assert.equal(JSON.parse(conflict.stderr).code, "E_EVAL_INTEGRITY");
  });
});
