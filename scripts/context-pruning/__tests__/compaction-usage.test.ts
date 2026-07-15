import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalDigest, canonicalJson } from "../canonical-json.js";
import { atomicManifestWrite, corpusKeyDigest, loadOrCreateCorpusKey } from "../evidence-store.js";
import {
  COMPACTION_USAGE_EVIDENCE_PATH,
  captureCompactionUsage,
  countCompactionInFiveRequestHorizons,
  createCompactionUsageProbeArtifact,
  createGeneratedCompactionUsageFixture,
  createPiCompactionUsageRecorder,
  parseReportedUsage,
  persistCompactionUsageProbe,
  registerPiCompactionUsageRecorder,
  resumeCompactionUsageProbe,
  verifyCompactionUsageProbe,
} from "../lifecycle/compaction-usage.js";
import {
  ensurePrivateRunRoot,
  openSafeRun,
  safeRunFileExists,
  safeRunPublishExclusiveFile,
  safeRunReadFile,
  safeRunStat,
} from "../path-safety.js";
import type { RunManifest } from "../types.js";

let root: string;
let sequence = 0;
const id = (value: unknown) => canonicalDigest(value);
async function createRun() {
  const agentDir = join(root, `agent-${++sequence}`);
  const runId = `compaction-${sequence}`;
  const preRun = await ensurePrivateRunRoot(agentDir, runId);
  const key = await loadOrCreateCorpusKey(preRun);
  await atomicManifestWrite(preRun, {
    schemaVersion: 1,
    runId,
    createdAt: "2026-07-15T00:00:00.000Z",
    corpusKeyDigest: corpusKeyDigest(key),
    eventCount: 0,
  } satisfies RunManifest);
  return { agentDir, runId };
}

async function makeSafeRun() {
  const { agentDir, runId } = await createRun();
  return openSafeRun(agentDir, runId);
}

async function makeIndependentSafeRunHandles() {
  const { agentDir, runId } = await createRun();
  return Promise.all([openSafeRun(agentDir, runId), openSafeRun(agentDir, runId)]);
}
before(() => {
  root = join(tmpdir(), `compaction-usage-${randomBytes(8).toString("hex")}`);
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("actual Pi lifecycle compaction usage reducer", () => {
  it("uses only Pi hook facts and derives all dispositions", () => {
    const fixture = createGeneratedCompactionUsageFixture();
    assert.equal(captureCompactionUsage(fixture.complete).status, "complete");
    assert.equal(captureCompactionUsage(fixture.missing).status, "missing");
    assert.equal(captureCompactionUsage(fixture.merged).status, "merged");
    assert.equal(captureCompactionUsage(fixture.ambiguous).status, "ambiguous");
    assert.equal(captureCompactionUsage(fixture.duplicate).status, "duplicate");
    assert.equal(captureCompactionUsage(fixture.splitTurn).status, "split-turn");
    assert.equal(captureCompactionUsage(fixture.multiAttempt).status, "multi-attempt");
  });

  it("requires actual Pi Usage to mark every attributable attempt billed", () => {
    const fixture = createGeneratedCompactionUsageFixture();
    const complete = captureCompactionUsage(fixture.complete);
    assert.equal(complete.compactionAttempts[0]?.billing, "billed");
    assert.equal(complete.followingMainAttempts[0]?.billing, "billed");
    assert.ok(complete.compactionUsage);
    const missing = captureCompactionUsage(fixture.missing);
    assert.equal(missing.compactionAttempts[0]?.billing, "unknown");
    assert.equal(missing.compactionUsage, undefined);
    const observation = fixture.complete.events.find((event) => event.type === "usage_observation");
    if (observation === undefined || !("usage" in observation))
      throw new Error("fixture lacks usage");
    assert.ok(parseReportedUsage(observation.usage));
    assert.equal(
      parseReportedUsage({ actual: observation.usage, billed: observation.usage }),
      undefined,
    );
  });

  it("adapts the actual Pi hook names without retaining provider payload or message content", () => {
    let tick = 0;
    const handlers = new Map<string, (event: unknown) => void>();
    const recorder = createPiCompactionUsageRecorder({
      recorderId: "hook-adapter",
      now: () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    });
    registerPiCompactionUsageRecorder(
      { on: (name, handler) => handlers.set(name, handler) },
      recorder,
    );
    handlers.get("before_agent_start")!({ prompt: "not persisted" });
    handlers.get("session_before_compact")!({ preparation: { isSplitTurn: false } });
    handlers.get("before_provider_request")!({ payload: { messages: ["not persisted"] } });
    const request = recorder.facts.at(-1)!;
    recorder.observeProviderUsage(
      request.type === "before_provider_request" ? request.requestId : "invalid",
      {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    );
    handlers.get("session_compact")!({});
    handlers.get("before_provider_request")!({ payload: { messages: ["also not persisted"] } });
    handlers.get("message_end")!({
      message: {
        role: "assistant",
        content: "not persisted",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
    assert.equal(captureCompactionUsage({ events: recorder.facts }).status, "complete");
    assert.equal(JSON.stringify(recorder.facts).includes("not persisted"), false);
  });

  it("keeps unresolved compaction requests from receiving following-main message usage", () => {
    let tick = 0;
    const handlers = new Map<string, (event: unknown) => void>();
    const recorder = createPiCompactionUsageRecorder({
      recorderId: "phase-attribution",
      now: () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    });
    registerPiCompactionUsageRecorder(
      { on: (name, handler) => handlers.set(name, handler) },
      recorder,
    );
    const usage = {
      input: 11,
      output: 12,
      cacheRead: 2,
      cacheWrite: 3,
      totalTokens: 28,
      cost: { input: 0.11, output: 0.12, cacheRead: 0.02, cacheWrite: 0.03, total: 0.28 },
    };

    handlers.get("session_before_compact")!({ preparation: { isSplitTurn: false } });
    handlers.get("before_provider_request")!({});
    handlers.get("session_compact")!({});
    handlers.get("before_agent_start")!({});
    handlers.get("before_provider_request")!({});
    handlers.get("message_end")!({ message: { usage } });

    const requests = recorder.facts.filter(
      (fact): fact is Extract<typeof fact, { type: "before_provider_request" }> =>
        fact.type === "before_provider_request",
    );
    const usageFacts = recorder.facts.filter(
      (fact): fact is Extract<typeof fact, { type: "usage_observation" | "message_end" }> =>
        fact.type === "usage_observation" || fact.type === "message_end",
    );
    const capture = captureCompactionUsage({ events: recorder.facts });
    assert.equal(capture.status, "missing");
    assert.equal(capture.compactionAttempts[0]?.attemptId, requests[0]?.requestId);
    assert.equal(capture.compactionAttempts[0]?.billing, "unknown");
    assert.equal(capture.compactionUsage, undefined);
    assert.equal(capture.followingMainAttempts[0]?.attemptId, requests[1]?.requestId);
    assert.equal(capture.followingMainAttempts[0]?.billing, "billed");
    assert.deepEqual(capture.followingMainUsage, usage);
    assert.deepEqual(
      usageFacts.map((fact) => fact.type),
      ["message_end"],
    );
    assert.equal(usageFacts[0]?.requestId, requests[1]?.requestId);
  });

  it("uses preparation.isSplitTurn rather than counting compaction cycles", () => {
    let tick = 0;
    const recorder = createPiCompactionUsageRecorder({
      recorderId: "two-cycles",
      now: () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    });
    recorder.beforeAgentStart();
    for (let cycle = 0; cycle < 2; cycle += 1) {
      recorder.sessionBeforeCompact({ isSplitTurn: false });
      const request = recorder.beforeProviderRequest();
      recorder.observeProviderUsage(request, {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
      recorder.sessionCompact();
    }
    const main = recorder.beforeProviderRequest();
    recorder.messageEnd({
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const capture = captureCompactionUsage({ events: recorder.facts });
    assert.equal(capture.status, "complete");
    assert.equal(capture.compactionAttempts.length, 2);
  });
});

describe("closure-bounded five request horizons", () => {
  it("counts only compactions after closure through checkpoint five", () => {
    const closure = id("closure");
    const requests = [1, 2, 3, 4, 5].map((index) => id(`request-${index}`)) as [
      string,
      string,
      string,
      string,
      string,
    ];
    const entries = [
      { entryId: closure, type: "message" as const, timestamp: "2026-01-01T00:00:01.000Z" },
      { entryId: id("inside"), type: "compaction" as const, timestamp: "2026-01-01T00:00:02.000Z" },
      ...requests.map((entryId, index) => ({
        entryId,
        type: "message" as const,
        timestamp: `2026-01-01T00:00:0${index + 3}.000Z`,
      })),
    ];
    assert.deepEqual(
      countCompactionInFiveRequestHorizons(entries, [
        { horizonId: "frozen-five", closureEntryId: closure, requestEntryIds: requests },
      ]),
      { horizonCount: 1, horizonsWithCompaction: 1, compactionEntriesInsideHorizons: 1 },
    );
  });
});

describe("authoritative marker-only probe persistence", () => {
  it("rederives capture from persisted facts without creating a JSONL view", async () => {
    const safeRun = await makeSafeRun();
    const facts = createGeneratedCompactionUsageFixture().complete.events;
    const first = await resumeCompactionUsageProbe(
      safeRun,
      "generated-probe",
      "2026-07-15T00:00:00.000Z",
      facts,
    );
    const resumed = await resumeCompactionUsageProbe(
      safeRun,
      "generated-probe",
      "2026-07-15T00:00:01.000Z",
      facts,
    );
    assert.deepEqual(resumed, first);
    await verifyCompactionUsageProbe(safeRun, first);
    assert.equal(await safeRunFileExists(safeRun, COMPACTION_USAGE_EVIDENCE_PATH), false);
  });

  it("treats a marker-only interruption as complete", async () => {
    const safeRun = await makeSafeRun();
    const facts = createGeneratedCompactionUsageFixture().complete.events;
    const artifact = createCompactionUsageProbeArtifact(
      "marker-only",
      "2026-07-15T00:00:00.000Z",
      facts,
    );
    assert.equal(
      await safeRunPublishExclusiveFile(
        safeRun,
        "compaction-usage-probes/marker-only.json",
        canonicalJson(artifact),
      ),
      true,
    );
    const resumed = await resumeCompactionUsageProbe(
      safeRun,
      "marker-only",
      "2026-07-15T00:00:01.000Z",
      facts,
    );
    assert.deepEqual(resumed, artifact);
    await verifyCompactionUsageProbe(safeRun, artifact);
    assert.equal(await safeRunFileExists(safeRun, COMPACTION_USAGE_EVIDENCE_PATH), false);
  });

  it("rejects self-asserted capture tampering and conflicting probe facts", async () => {
    const safeRun = await makeSafeRun();
    const facts = createGeneratedCompactionUsageFixture().complete.events;
    const artifact = createCompactionUsageProbeArtifact(
      "tamper-probe",
      "2026-07-15T00:00:00.000Z",
      facts,
    );
    await persistCompactionUsageProbe(safeRun, artifact);
    const forged = JSON.parse(JSON.stringify(artifact));
    forged.data.capture.status = "missing";
    forged.eventId = canonicalDigest({
      domain: forged.type,
      timestamp: forged.timestamp,
      type: forged.type,
      data: forged.data,
    });
    await assert.rejects(() => persistCompactionUsageProbe(safeRun, forged), {
      code: "E_EVAL_INTEGRITY",
    });
    await assert.rejects(
      () =>
        resumeCompactionUsageProbe(
          safeRun,
          "tamper-probe",
          "2026-07-15T00:00:01.000Z",
          createGeneratedCompactionUsageFixture().multiAttempt.events,
        ),
      { code: "E_EVAL_INTEGRITY" },
    );
  });

  it("adopts one cross-handle winner for same facts with different timestamps", async () => {
    const [firstHandle, secondHandle] = await makeIndependentSafeRunHandles();
    const facts = createGeneratedCompactionUsageFixture().complete.events;
    const [first, second] = await Promise.all([
      resumeCompactionUsageProbe(
        firstHandle,
        "concurrent-probe",
        "2026-07-15T00:00:00.000Z",
        facts,
      ),
      resumeCompactionUsageProbe(
        secondHandle,
        "concurrent-probe",
        "2026-07-15T00:00:01.000Z",
        facts,
      ),
    ]);
    assert.deepEqual(first, second);
    assert.ok(
      first.timestamp === "2026-07-15T00:00:00.000Z" ||
        first.timestamp === "2026-07-15T00:00:01.000Z",
    );
    await verifyCompactionUsageProbe(firstHandle, first);
    await verifyCompactionUsageProbe(secondHandle, second);
    const markerPath = "compaction-usage-probes/concurrent-probe.json";
    assert.deepEqual(
      JSON.parse((await safeRunReadFile(firstHandle, markerPath)).toString("utf8")),
      first,
    );
    assert.equal((await safeRunStat(firstHandle, markerPath)).mode & 0o777, 0o600);
    assert.equal(await safeRunFileExists(firstHandle, COMPACTION_USAGE_EVIDENCE_PATH), false);
  });

  it("rejects a concurrent independent-handle publication with conflicting facts", async () => {
    const [firstHandle, secondHandle] = await makeIndependentSafeRunHandles();
    const results = await Promise.allSettled([
      resumeCompactionUsageProbe(
        firstHandle,
        "conflicting-probe",
        "2026-07-15T00:00:00.000Z",
        createGeneratedCompactionUsageFixture().complete.events,
      ),
      resumeCompactionUsageProbe(
        secondHandle,
        "conflicting-probe",
        "2026-07-15T00:00:01.000Z",
        createGeneratedCompactionUsageFixture().multiAttempt.events,
      ),
    ]);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<ReturnType<typeof createCompactionUsageProbeArtifact>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0]?.reason as { code?: string }).code, "E_EVAL_INTEGRITY");
    await verifyCompactionUsageProbe(firstHandle, fulfilled[0]!.value);
  });
});
