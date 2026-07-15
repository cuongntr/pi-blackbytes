import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FRAGILE_THRESHOLD_DISTANCE,
  bootstrapSnapshotClusters,
  scoreAtomicFact,
  scoreBlindedCheckpoint,
  scoreQuality,
  validateBlindedCheckpointInput,
} from "../scoring.js";

const DIGEST = "0".repeat(64);

function checkpoint(
  snapshotId: string,
  arm: "native" | "selective",
  judgment: "correct" | "partial" | "omitted" = "correct",
  taskCompletion?: boolean,
) {
  return {
    snapshotId,
    arm,
    replicateIndex: 1,
    checkpointIndex: 1,
    facts: [{ factId: "fact", judgment }],
    ...(taskCompletion === undefined ? {} : { taskCompletion }),
  };
}

describe("T-013 blinded quality scoring", () => {
  it("scores atomic facts exactly and records contradictions", () => {
    assert.deepEqual(scoreAtomicFact({ factId: "a", judgment: "correct" }), {
      factId: "a",
      score: 1,
      contradiction: false,
    });
    assert.equal(scoreAtomicFact({ factId: "a", judgment: "partial" }).score, 0.5);
    assert.equal(scoreAtomicFact({ factId: "a", judgment: "omitted" }).score, 0);
    assert.deepEqual(scoreAtomicFact({ factId: "a", judgment: "incorrect" }), {
      factId: "a",
      score: 0,
      contradiction: true,
    });
  });

  it("accepts only blinded scorer inputs", () => {
    assert.throws(
      () =>
        validateBlindedCheckpointInput({
          ...checkpoint("snapshot", "native"),
          cost: 1,
          summary: "unblinding metadata",
          runOrder: 1,
        }),
      { code: "E_EVAL_SCHEMA" },
    );
    const score = scoreBlindedCheckpoint({
      snapshotId: "snapshot",
      replicateIndex: 1,
      checkpointIndex: 1,
      facts: [{ factId: "f", judgment: "correct" }],
    });
    assert.equal(Object.hasOwn(score, "arm"), false);
  });

  it("uses equal snapshot weighting and conditional T-012C task scoring", () => {
    const report = scoreQuality(
      [
        checkpoint("one", "native", "omitted"),
        checkpoint("one", "native", "omitted"),
        checkpoint("one", "selective", "correct"),
        checkpoint("two", "native", "correct"),
        checkpoint("two", "selective", "correct"),
      ],
      "test-seed",
      DIGEST,
      false,
    );
    assert.equal(report.recallDelta, 0.5);
    assert.equal(report.taskCompletionStatus, "unavailable");
    assert.equal(report.taskCompletionDelta, undefined);

    const conditional = scoreQuality(
      [
        checkpoint("one", "native", "correct", false),
        checkpoint("one", "selective", "correct", true),
      ],
      "test-seed",
      DIGEST,
      true,
    );
    assert.equal(conditional.taskCompletionDelta, 1);
    assert.ok(conditional.fragileThresholds.length >= 0);
  });

  it("uses the frozen seed, counter stream, 10k resamples, and nearest ranks", () => {
    const clusters = [
      { snapshotId: "a", arm: "native", replicate: 1, value: 0 },
      { snapshotId: "a", arm: "selective", replicate: 1, value: 0 },
      { snapshotId: "b", arm: "native", replicate: 1, value: 1 },
      { snapshotId: "b", arm: "selective", replicate: 1, value: 1 },
      { snapshotId: "c", arm: "native", replicate: 1, value: 2 },
      { snapshotId: "c", arm: "selective", replicate: 1, value: 2 },
    ];
    const result = bootstrapSnapshotClusters(
      clusters,
      "test-seed",
      DIGEST.toUpperCase(),
      (resample) => {
        const arms = new Map<string, number>();
        for (const record of resample)
          arms.set(record.snapshotId, (arms.get(record.snapshotId) ?? 0) + 1);
        for (const count of arms.values())
          assert.equal(count % 2, 0, "complete arm clusters survive");
        return resample.reduce((sum, record) => sum + record.value, 0) / resample.length;
      },
    );
    assert.equal(
      result.bootstrapSeed,
      "5d4900fcf8455dfd03be5ce5fd8fc60491968844779b94db3b4409203af4f7f7",
    );
    assert.deepEqual(result.flattenedIndices.slice(0, 12), [0, 0, 1, 2, 2, 2, 0, 2, 1, 1, 0, 0]);
    assert.equal(result.values.length, 10_000);
    const ordered = [...result.values].sort((left, right) => left - right);
    assert.equal(result.lower, ordered[249]);
    assert.equal(result.upper, ordered[9749]);
  });

  it("flags fixed thresholds within two percentage points as fragile", () => {
    const facts = Array.from({ length: 10 }, (_, index) => ({
      factId: `f-${index}`,
      judgment: index === 9 ? ("omitted" as const) : ("correct" as const),
    }));
    const report = scoreQuality(
      [
        {
          ...checkpoint("one", "native", "correct"),
          facts: facts.map((fact) => ({ ...fact, judgment: "correct" as const })),
        },
        { ...checkpoint("one", "selective", "correct"), facts },
        checkpoint("two", "native", "correct"),
        checkpoint("two", "selective", "correct"),
      ],
      "seed",
      DIGEST,
      false,
    );
    assert.ok(FRAGILE_THRESHOLD_DISTANCE === 0.02);
    assert.ok(report.fragileThresholds.includes("recall-delta"));
  });
});
