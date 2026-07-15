import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { actualAttemptCost, scoreUtility, validateActualCostAttempt } from "../cost.js";

const card = {
  priceCardDigest: "a".repeat(64),
  inputPerToken: 1,
  outputPerToken: 2,
  cacheReadPerToken: 0.5,
  cacheWritePerToken: 0.25,
};

function attempts(snapshotId: string, nativePerCheckpoint: number, selectivePerCheckpoint: number) {
  const usage = (total: number) => ({ cost: { total } });
  return [
    {
      snapshotId,
      arm: "selective" as const,
      replicateIndex: 1,
      checkpointIndex: 0,
      kind: "summary" as const,
      usageCompleteness: "complete" as const,
      usage: usage(0),
      priceCardDigest: card.priceCardDigest,
    },
    ...([1, 2, 3, 4, 5] as const).flatMap((checkpointIndex) => [
      {
        snapshotId,
        arm: "native" as const,
        replicateIndex: 1,
        checkpointIndex,
        kind: "checkpoint" as const,
        usageCompleteness: "complete" as const,
        usage: usage(nativePerCheckpoint),
        priceCardDigest: card.priceCardDigest,
      },
      {
        snapshotId,
        arm: "selective" as const,
        replicateIndex: 1,
        checkpointIndex,
        kind: "checkpoint" as const,
        usageCompleteness: "complete" as const,
        usage: usage(selectivePerCheckpoint),
        priceCardDigest: card.priceCardDigest,
      },
    ]),
  ];
}

describe("T-013 actual cost scoring", () => {
  it("prefers provider usage.cost.total and otherwise requires complete actual channels", () => {
    assert.equal(
      actualAttemptCost(
        {
          snapshotId: "s",
          arm: "native",
          replicateIndex: 1,
          checkpointIndex: 1,
          kind: "checkpoint",
          usageCompleteness: "complete",
          usage: { cost: { total: 7 } },
          priceCardDigest: card.priceCardDigest,
        },
        card,
      ),
      7,
    );
    assert.equal(
      actualAttemptCost(
        {
          snapshotId: "s",
          arm: "native",
          replicateIndex: 1,
          checkpointIndex: 1,
          kind: "checkpoint",
          usageCompleteness: "complete",
          usage: { input: 1, output: 1, cacheRead: 2, cacheWrite: 4 },
          priceCardDigest: card.priceCardDigest,
        },
        card,
      ),
      5,
    );
    assert.throws(
      () =>
        validateActualCostAttempt({
          snapshotId: "s",
          arm: "native",
          replicateIndex: 1,
          checkpointIndex: 1,
          kind: "checkpoint",
          usageCompleteness: "complete",
          usage: { estimatedTokens: 3 },
          priceCardDigest: card.priceCardDigest,
        }),
      { code: "E_EVAL_SCHEMA" },
    );
  });

  it("uses only checkpoint five cumulative cost and finds first break-even", () => {
    const report = scoreUtility(attempts("s", 20, 18), card);
    assert.equal(report.status, "complete");
    assert.equal(report.snapshots[0]!.nativeCost5, 100);
    assert.equal(report.snapshots[0]!.selectiveCost5, 90);
    assert.equal(report.snapshots[0]!.reduction5, 0.1);
    assert.equal(report.snapshots[0]!.breakEven, 1);
    assert.equal(report.medianReduction5, 0.1);
  });

  it("covers PRD pass, near-miss, and fail boundaries", () => {
    const pass = scoreUtility(attempts("pass", 20, 18), card);
    const nearMiss = scoreUtility(attempts("near", 20, 19), card);
    const failure = scoreUtility(attempts("fail", 20, 21), card);
    assert.equal(pass.medianReduction5, 0.1);
    assert.equal(nearMiss.medianReduction5, 0.05);
    assert.equal(failure.medianReduction5, -0.05);
    assert.ok(pass.fragileThresholds.includes("reduction5-pass"));
    assert.ok(nearMiss.fragileThresholds.includes("reduction5-revise"));
    assert.equal(failure.snapshots[0]!.breakEven, ">5");
  });

  it("marks utility incomplete when any mandatory actual usage is missing", () => {
    const incomplete = attempts("s", 1, 1).map((attempt, index) =>
      index === 3 ? { ...attempt, usageCompleteness: "missing" as const } : attempt,
    );
    const report = scoreUtility(incomplete, card);
    assert.equal(report.status, "incomplete");
    assert.deepEqual(report.reasons, ["mandatory-actual-usage-missing"]);
  });
});
