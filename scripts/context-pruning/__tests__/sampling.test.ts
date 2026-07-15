/** Hermetic deterministic sampling and underflow tests. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalDigest } from "../canonical-json.js";
import { SAMPLING_LOCK_STAGE } from "../protocol.js";
import type { SamplingProtocolLock } from "../protocol.js";
import {
  SAMPLE_SIZE,
  buildEligibleFrame,
  inventoryDigest,
  sampleInventory,
  sampleManifestDigest,
  selectionKey,
} from "../sampling.js";
import { SCHEMA_VERSION } from "../types.js";
import type { InventoryRecord, SampleManifest, SamplingResult } from "../types.js";

const DIGEST = "a".repeat(64);
const END = "2030-01-01T00:00:00.000Z";

function lock(maxInventoryRefreshes = 1, seed = "sampling-seed"): SamplingProtocolLock {
  return {
    stage: SAMPLING_LOCK_STAGE,
    schemaVersion: SCHEMA_VERSION,
    runId: "opaque-run-id",
    protocolSeed: seed,
    longSessionMinRequests: 20,
    collectionWindowEndsAt: END,
    maxInventoryRefreshes,
    modelRegistryDigest: DIGEST,
    estimatorPolicyDigest: "b".repeat(64),
  };
}

function pseudonym(value: string): string {
  return canonicalDigest(value);
}

function record(index: number, patch: Partial<InventoryRecord> = {}): InventoryRecord {
  const corpusId = pseudonym(`corpus-${String(index).padStart(3, "0")}`);
  return {
    schemaVersion: SCHEMA_VERSION,
    corpusId,
    repositoryId: pseudonym(`repository-${index % 3}`),
    lineageRootId: pseudonym(`lineage-${corpusId}`),
    sourceDigest: pseudonym(`source-${corpusId}`),
    bytes: 1,
    mtimeMs: 1,
    parentStatus: "parent",
    parseStatus: "valid",
    entryCounts: {
      session: 1,
      message: 20,
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
    roleCounts: { user: 0, assistant: 20, toolResult: 0, unknown: 0 },
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
    selectedLeafId: pseudonym(`leaf-${corpusId}`),
    selectedLeafLineIndex: 21,
    finalBranchEntryCount: 20,
    finalBranchRequestCount: 20,
    abandonedEntryCount: 0,
    lineageStatus: "root",
    lineageDisposition: "unique",
    usageCompleteness: 1,
    compactionCount: 0,
    exclusionReasons: [],
    ...patch,
  };
}

function records(count: number): InventoryRecord[] {
  return Array.from({ length: count }, (_, index) => record(index));
}

function frozen(result: SamplingResult) {
  assert.equal(result.status, "frozen");
  if (result.status !== "frozen") throw new Error("expected frozen result");
  return result.manifest;
}

function incomplete(result: SamplingResult, status: "underflow-pending" | "underflow-hard-stop") {
  assert.equal(result.status, status);
  assert.equal(result.code, "E_EVAL_INCOMPLETE");
  assert.equal(Object.hasOwn(result, "manifest"), false);
  assert.equal(Object.hasOwn(result, "entries"), false);
}

describe("deterministic first-40 sampling", () => {
  it("freezes exactly 40 entries for frames of 40 and 41 without replacement", () => {
    for (const count of [40, 41]) {
      const manifest = frozen(
        sampleInventory({
          samplingLock: lock(),
          inventoryRecords: records(count),
          attemptIndex: 0,
          now: END,
        }),
      );
      assert.equal(manifest.frameSize, count);
      assert.equal(manifest.entries.length, SAMPLE_SIZE);
      assert.equal(new Set(manifest.entries.map((entry) => entry.corpusId)).size, SAMPLE_SIZE);
      assert.equal(Object.isFrozen(manifest), true);
      assert.equal(Object.isFrozen(manifest.entries), true);
      assert.equal(Object.isFrozen(manifest.repositoryConcentration.frame), true);
      assert.equal(Object.isFrozen(manifest.repositoryConcentration), true);
    }
  });

  it("returns no partial sample while pending, then freezes a permitted refresh", () => {
    const pending = sampleInventory({
      samplingLock: lock(1),
      inventoryRecords: records(39),
      attemptIndex: 0,
      now: "2029-12-31T23:59:59.999Z",
    });
    incomplete(pending, "underflow-pending");
    if (pending.status === "frozen") throw new Error("expected underflow result");
    assert.equal(pending.frameSize, 39);

    const refreshed = frozen(
      sampleInventory({
        samplingLock: lock(1),
        inventoryRecords: records(40),
        attemptIndex: 1,
        now: "2029-12-31T23:59:59.999Z",
      }),
    );
    assert.equal(refreshed.attemptIndex, 1);
    assert.equal(refreshed.entries.length, 40);
    const sameInventoryAtAttemptZero = frozen(
      sampleInventory({
        samplingLock: lock(1),
        inventoryRecords: records(40),
        attemptIndex: 0,
        now: "2029-12-31T23:59:59.999Z",
      }),
    );
    assert.deepEqual(refreshed.entries, sameInventoryAtAttemptZero.entries);
    assert.equal(refreshed.samplingLockDigest, sameInventoryAtAttemptZero.samplingLockDigest);
  });

  it("hard-stops at the time boundary or refresh limit and rejects invalid attempts", () => {
    incomplete(
      sampleInventory({
        samplingLock: lock(1),
        inventoryRecords: records(39),
        attemptIndex: 0,
        now: END,
      }),
      "underflow-hard-stop",
    );
    incomplete(
      sampleInventory({
        samplingLock: lock(1),
        inventoryRecords: records(39),
        attemptIndex: 0,
        now: "2029-01-01T00:00:00.000Z",
      }),
      "underflow-pending",
    );
    incomplete(
      sampleInventory({
        samplingLock: lock(1),
        inventoryRecords: records(39),
        attemptIndex: 1,
        now: "2029-01-01T00:00:00.000Z",
      }),
      "underflow-hard-stop",
    );
    incomplete(
      sampleInventory({
        samplingLock: lock(0),
        inventoryRecords: records(39),
        attemptIndex: 0,
        now: "2029-01-01T00:00:00.000Z",
      }),
      "underflow-hard-stop",
    );
    for (const attemptIndex of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2]) {
      assert.throws(
        () =>
          sampleInventory({
            samplingLock: lock(1),
            inventoryRecords: records(40),
            attemptIndex,
            now: END,
          }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "E_EVAL_SCHEMA",
      );
    }
  });

  it("is byte-deterministic across repeated runs and input permutations", () => {
    const input = records(41);
    const first = frozen(
      sampleInventory({ samplingLock: lock(), inventoryRecords: input, attemptIndex: 0, now: END }),
    );
    const second = frozen(
      sampleInventory({
        samplingLock: lock(),
        inventoryRecords: [...input].reverse(),
        attemptIndex: 0,
        now: END,
      }),
    );
    assert.equal(canonicalDigest(first), canonicalDigest(second));
    assert.equal(sampleManifestDigest(first), sampleManifestDigest(second));
    assert.equal(inventoryDigest(input), inventoryDigest([...input].reverse()));
    assert.equal(canonicalDigest(lock()), canonicalDigest(lock()));
  });

  it("accepts an identical prior manifest and rejects a redraw for its frozen identity", () => {
    const inventoryRecords = records(40);
    const initial = frozen(
      sampleInventory({ samplingLock: lock(), inventoryRecords, attemptIndex: 0, now: END }),
    );
    const repeated = frozen(
      sampleInventory({
        samplingLock: lock(),
        inventoryRecords,
        attemptIndex: 0,
        now: END,
        priorManifest: initial,
      }),
    );
    assert.equal(canonicalDigest(initial), canonicalDigest(repeated));
    assert.throws(
      () =>
        sampleInventory({
          samplingLock: lock(),
          inventoryRecords,
          attemptIndex: 0,
          now: END,
          priorManifest: {
            ...initial,
            entries: [...initial.entries]
              .reverse()
              .map((entry, index) => ({ ...entry, rank: index + 1 })),
          },
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "E_EVAL_INTEGRITY",
    );
  });

  it("makes a frozen sample immutable for the entire run, including underflow paths", () => {
    const initial = frozen(
      sampleInventory({
        samplingLock: lock(2),
        inventoryRecords: records(40),
        attemptIndex: 0,
        now: END,
      }),
    );
    const changedRequests = [
      { samplingLock: lock(2), inventoryRecords: records(41), attemptIndex: 0 },
      { samplingLock: lock(2), inventoryRecords: records(41), attemptIndex: 1 },
      { samplingLock: lock(2, "changed-seed"), inventoryRecords: records(40), attemptIndex: 0 },
      { samplingLock: lock(2), inventoryRecords: records(39), attemptIndex: 0 },
    ];
    for (const changed of changedRequests) {
      assert.throws(
        () =>
          sampleInventory({
            ...changed,
            now: "2029-01-01T00:00:00.000Z",
            priorManifest: initial,
          }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "E_EVAL_INTEGRITY",
      );
    }

    const distinctRun = frozen(
      sampleInventory({
        samplingLock: { ...lock(2), runId: "distinct-run" },
        inventoryRecords: records(40),
        attemptIndex: 0,
        now: END,
        priorManifest: initial,
      }),
    );
    assert.equal(distinctRun.runId, "distinct-run");
  });

  it("rejects missing, coercible, and nested-extra inventory data without leaking values", () => {
    const canary = "private/source/path-content-local-id";
    const missingReason = { ...record(0) } as Record<string, unknown>;
    delete missingReason.exclusionReasons;
    const malformed = [
      missingReason as unknown as InventoryRecord,
      { ...record(1), finalBranchRequestCount: "20" } as unknown as InventoryRecord,
      { ...record(2), selectedLeafId: null } as unknown as InventoryRecord,
      {
        ...record(3),
        usageTotals: { ...record(3).usageTotals, content: canary },
      } as unknown as InventoryRecord,
      {
        ...record(4),
        entryCounts: { ...record(4).entryCounts, localPath: canary },
      } as unknown as InventoryRecord,
    ];
    for (const inventoryRecord of malformed) {
      let error: unknown;
      try {
        buildEligibleFrame([inventoryRecord], 20);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof Error);
      assert.equal("code" in error && error.code, "E_EVAL_SCHEMA");
      assert.equal(error.message.includes(canary), false);
    }

    const initial = frozen(
      sampleInventory({
        samplingLock: lock(),
        inventoryRecords: records(40),
        attemptIndex: 0,
        now: END,
      }),
    );
    const contentBearingPrior = { ...initial, content: canary } as unknown as SampleManifest;
    assert.throws(
      () =>
        sampleInventory({
          samplingLock: lock(),
          inventoryRecords: records(40),
          attemptIndex: 0,
          now: END,
          priorManifest: contentBearingPrior,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "E_EVAL_SCHEMA" &&
        !error.message.includes(canary),
    );
  });

  it("changes selection keys when the seed, inventory digest, or corpusId changes", () => {
    const corpusA = pseudonym("corpus-a");
    const corpusB = pseudonym("corpus-b");
    assert.notEqual(selectionKey("a", DIGEST, corpusA), selectionKey("b", DIGEST, corpusA));
    assert.notEqual(selectionKey("a", DIGEST, corpusA), selectionKey("a", "c".repeat(64), corpusA));
    assert.notEqual(selectionKey("a", DIGEST, corpusA), selectionKey("a", DIGEST, corpusB));
    const input = records(41);
    const first = frozen(
      sampleInventory({
        samplingLock: lock(1, "a"),
        inventoryRecords: input,
        attemptIndex: 0,
        now: END,
      }),
    );
    const second = frozen(
      sampleInventory({
        samplingLock: lock(1, "b"),
        inventoryRecords: input,
        attemptIndex: 0,
        now: END,
      }),
    );
    assert.notEqual(canonicalDigest(first.entries), canonicalDigest(second.entries));
  });

  it("fails closed on duplicate corpus IDs or ambiguous unique lineage roots", () => {
    const duplicateCorpus = records(40);
    duplicateCorpus[1] = record(1, { corpusId: duplicateCorpus[0]?.corpusId });
    const ambiguousRoot = records(40);
    ambiguousRoot[1] = record(1, { lineageRootId: ambiguousRoot[0]?.lineageRootId });
    for (const inventoryRecords of [duplicateCorpus, ambiguousRoot]) {
      assert.throws(
        () =>
          sampleInventory({ samplingLock: lock(), inventoryRecords, attemptIndex: 0, now: END }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "E_EVAL_INTEGRITY",
      );
    }
  });

  it("allows only one inventory-designated duplicate lineage representative", () => {
    const primary = record(0);
    const duplicate = record(1, {
      lineageRootId: primary.lineageRootId,
      lineageDisposition: "duplicate-lineage",
      exclusionReasons: ["duplicate-lineage"],
    });
    assert.equal(buildEligibleFrame([primary, duplicate], 20).length, 1);
  });

  it("uses final-branch requests and fixed structural exclusions, not cost or outcome-like metadata", () => {
    const usableWithIncompleteCost = record(0, {
      parseStatus: "partial",
      exclusionReasons: ["incomplete-usage", "unknown-entry-type"],
      requestCount: 999,
      finalBranchRequestCount: 20,
      maxContextRatio: 1.5,
      compactionCount: 99,
      usageCompleteness: 0,
    });
    const insufficientFinalBranch = record(1, { requestCount: 999, finalBranchRequestCount: 19 });
    assert.equal(
      buildEligibleFrame([usableWithIncompleteCost, insufficientFinalBranch], 20).length,
      1,
    );

    const structuralReasons = [
      "canonical-path-unavailable",
      "duplicate-header",
      "duplicate-structural-id",
      "invalid-header",
      "invalid-line-index",
      "invalid-source-metadata",
      "invalid-structural-id",
      "lineage-cycle",
      "malformed-jsonl",
      "missing-header",
      "missing-parent",
      "no-terminal-leaf",
      "source-integrity-failed",
      "structural-cycle",
      "unreadable-source",
      "unresolved-parent-session",
    ];
    for (const [index, reason] of structuralReasons.entries()) {
      assert.equal(
        buildEligibleFrame([record(index, { exclusionReasons: [reason] })], 20).length,
        0,
        reason,
      );
    }
  });

  it("reports independent 10/15/20/25 sensitivity and deterministic repository concentration", () => {
    const thresholds = [9, 10, 14, 15, 19, 20, 24, 25];
    const input = thresholds.map((finalBranchRequestCount, index) =>
      record(index + 40, {
        finalBranchRequestCount,
        repositoryId: pseudonym(index < 6 ? "repository-a" : "repository-b"),
      }),
    );
    const result = frozen(
      sampleInventory({
        samplingLock: lock(),
        inventoryRecords: [...records(40), ...input],
        attemptIndex: 0,
        now: END,
      }),
    );
    assert.deepEqual(
      result.sensitivity.map((summary) => summary.requestThreshold),
      [10, 15, 20, 25],
    );
    assert.deepEqual(
      result.sensitivity.map((summary) => summary.frameSize),
      [47, 45, 43, 1],
    );
    const concentration = result.repositoryConcentration.frame;
    assert.equal(
      concentration.reduce((sum, value) => sum + value.count, 0),
      result.frameSize,
    );
    assert.ok(
      concentration.every(
        (value, index) => index === 0 || concentration[index - 1]!.count >= value.count,
      ),
    );
    assert.equal(
      result.repositoryConcentration.sample.reduce((sum, value) => sum + value.count, 0),
      40,
    );

    const alteredPressure = input.map((value) => ({
      ...value,
      maxContextRatio: 9,
      compactionCount: 999,
      usageCompleteness: 0,
    }));
    assert.deepEqual(
      buildEligibleFrame([...records(40), ...input], 20).map((value) => value.corpusId),
      buildEligibleFrame([...records(40), ...alteredPressure], 20).map((value) => value.corpusId),
    );
  });

  it("does not serialize source paths, content, or local identifiers", () => {
    const canary = "private/source/path-content-local-id";
    const input = records(40);
    Object.assign(input[0] as object, { sourcePath: canary, content: canary, localId: canary });
    let error: unknown;
    try {
      sampleInventory({ samplingLock: lock(), inventoryRecords: input, attemptIndex: 0, now: END });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.equal(JSON.stringify(error).includes(canary), false);
    assert.equal(error.message.includes(canary), false);
  });
});
