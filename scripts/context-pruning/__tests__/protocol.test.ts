import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalDigest } from "../canonical-json.js";
import {
  COMPLETE_RANGE_PROVENANCE_POLICY,
  EVALUATION_LOCK_STAGE,
  INDEPENDENT_AGGREGATE_SUPPRESSION_POLICY,
  LOCK_STAGES,
  PROVIDER_REQUEST_POLICY,
  QUALIFICATION_ESTIMATOR_POLICY,
  SAMPLING_LOCK_STAGE,
  SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY,
  TARGET_SELECTION_STAGE,
  assertEvaluationLockPredecessors,
  assertLockImmutable,
  assertTargetSelectionPredecessor,
  deriveBootstrapSeed,
  drawBootstrapResample,
  uint32BigEndian,
  validateEvaluationProtocolLock,
  validateSamplingProtocolLock,
  validateTargetSelectionRecord,
} from "../protocol.js";
import { SCHEMA_VERSION } from "../types.js";

const DIGEST = "0".repeat(64);
const OTHER_DIGEST = "1".repeat(64);

function samplingLock(runId = "run-a") {
  return {
    stage: SAMPLING_LOCK_STAGE,
    schemaVersion: SCHEMA_VERSION,
    runId,
    protocolSeed: "seed",
    longSessionMinRequests: 20,
    collectionWindowEndsAt: "2030-01-01T00:00:00.000Z",
    maxInventoryRefreshes: 0,
    modelRegistryDigest: DIGEST,
    estimatorPolicyDigest: OTHER_DIGEST,
  };
}

function targetSelection(lock = samplingLock()) {
  return {
    stage: TARGET_SELECTION_STAGE,
    schemaVersion: SCHEMA_VERSION,
    runId: lock.runId,
    provider: "provider",
    model: "model",
    api: "api",
    reasoning: "reasoning-setting",
    samplingLockDigest: canonicalDigest(lock),
    inventoryDigest: "2".repeat(64),
    sampleDigest: "3".repeat(64),
    providerPolicyDigest: "4".repeat(64),
  };
}

function evaluationLock(lock = samplingLock(), target = targetSelection(lock)) {
  return {
    stage: EVALUATION_LOCK_STAGE,
    schemaVersion: SCHEMA_VERSION,
    runId: lock.runId,
    samplingLockDigest: canonicalDigest(lock),
    targetSelectionDigest: canonicalDigest(target),
    inventoryDigest: target.inventoryDigest,
    sampleDigest: target.sampleDigest,
    estimatorPolicyDigest: lock.estimatorPolicyDigest,
    providerPolicyDigest: target.providerPolicyDigest,
    rubricDigest: "5".repeat(64),
    pricingDigest: "6".repeat(64),
    goldDigest: "7".repeat(64),
    fixtureDigest: "8".repeat(64),
    bootstrapDigest: "9".repeat(64),
    reportPolicyDigest: "a".repeat(64),
  };
}

function schemaFailure(action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof Error && "code" in error && error.code === "E_EVAL_SCHEMA",
  );
}

describe("protocol lock validation", () => {
  it("accepts complete stage-owned records and binds their predecessors", () => {
    const sampling = validateSamplingProtocolLock(samplingLock());
    const target = validateTargetSelectionRecord(targetSelection(sampling), sampling);
    const evaluation = validateEvaluationProtocolLock(evaluationLock(sampling, target), {
      samplingLock: sampling,
      targetSelection: target,
    });

    assert.equal(sampling.stage, SAMPLING_LOCK_STAGE);
    assert.equal(target.stage, TARGET_SELECTION_STAGE);
    assert.equal(evaluation.stage, EVALUATION_LOCK_STAGE);
  });

  it("rejects missing and unknown fields, bad stages, boundaries, timestamps, and digests", () => {
    const missing = samplingLock() as Record<string, unknown>;
    delete missing.protocolSeed;
    schemaFailure(() => validateSamplingProtocolLock(missing));

    schemaFailure(() => validateSamplingProtocolLock({ ...samplingLock(), unexpected: true }));
    schemaFailure(() =>
      validateSamplingProtocolLock({ ...samplingLock(), stage: TARGET_SELECTION_STAGE }),
    );
    schemaFailure(() =>
      validateSamplingProtocolLock({ ...samplingLock(), longSessionMinRequests: 19 }),
    );
    schemaFailure(() =>
      validateSamplingProtocolLock({ ...samplingLock(), maxInventoryRefreshes: -1 }),
    );
    schemaFailure(() =>
      validateSamplingProtocolLock({ ...samplingLock(), maxInventoryRefreshes: 0.5 }),
    );
    schemaFailure(() =>
      validateSamplingProtocolLock({ ...samplingLock(), collectionWindowEndsAt: "2030-01-01" }),
    );
    schemaFailure(() =>
      validateSamplingProtocolLock({
        ...samplingLock(),
        collectionWindowEndsAt: "2030-02-30T00:00:00.000Z",
      }),
    );
    schemaFailure(() =>
      validateSamplingProtocolLock({
        ...samplingLock(),
        modelRegistryDigest: "a".repeat(64).toUpperCase(),
      }),
    );
    schemaFailure(() =>
      validateSamplingProtocolLock({ ...samplingLock(), schemaVersion: SCHEMA_VERSION + 1 }),
    );

    const target = targetSelection();
    schemaFailure(() => validateTargetSelectionRecord({ ...target, reasoning: "" }));
    schemaFailure(() => validateTargetSelectionRecord({ ...target, extra: "field" }));
    schemaFailure(() => validateTargetSelectionRecord({ ...target, stage: EVALUATION_LOCK_STAGE }));

    const evaluation = evaluationLock();
    const incomplete = evaluation as Record<string, unknown>;
    delete incomplete.rubricDigest;
    schemaFailure(() => validateEvaluationProtocolLock(incomplete));
  });

  it("rejects target and evaluation predecessor mismatches before downstream use", () => {
    const sampling = validateSamplingProtocolLock(samplingLock());
    const target = validateTargetSelectionRecord(targetSelection(sampling));
    assert.throws(() =>
      assertTargetSelectionPredecessor(target, { ...sampling, runId: "other-run" }),
    );
    assert.throws(() =>
      assertTargetSelectionPredecessor({ ...target, samplingLockDigest: DIGEST }, sampling),
    );

    const evaluation = validateEvaluationProtocolLock(evaluationLock(sampling, target));
    assert.throws(() =>
      assertEvaluationLockPredecessors(
        { ...evaluation, providerPolicyDigest: DIGEST },
        { samplingLock: sampling, targetSelection: target },
      ),
    );
    assert.throws(() =>
      assertEvaluationLockPredecessors(
        { ...evaluation, sampleDigest: DIGEST },
        { samplingLock: sampling, targetSelection: target },
      ),
    );
  });

  it("rejects same-run mutation and cross-stage misuse while allowing a changed run ID", () => {
    const persisted = samplingLock();
    assert.throws(() =>
      assertLockImmutable(persisted, { ...persisted, protocolSeed: "other-seed" }),
    );
    schemaFailure(() => assertLockImmutable(persisted, targetSelection(persisted)));
    assert.doesNotThrow(() =>
      assertLockImmutable(persisted, { ...persisted, runId: "run-b", protocolSeed: "other-seed" }),
    );
  });
});

describe("frozen protocol constants", () => {
  it("exports every frozen formula and boundary", () => {
    assert.deepEqual(LOCK_STAGES, {
      sampling: SAMPLING_LOCK_STAGE,
      targetSelection: TARGET_SELECTION_STAGE,
      evaluation: EVALUATION_LOCK_STAGE,
    });
    assert.equal(
      QUALIFICATION_ESTIMATOR_POLICY.formula,
      "ceil(UTF8 bytes of canonical model-visible candidate content / 4)",
    );
    assert.equal(QUALIFICATION_ESTIMATOR_POLICY.bytesPerEstimatedToken, 4);
    assert.equal(QUALIFICATION_ESTIMATOR_POLICY.rounding, "ceil");
    assert.equal(SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.domain, "snapshot-cluster-bootstrap-v1");
    assert.equal(SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.resamples, 10_000);
    assert.equal(SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.lowerPercentile, 0.025);
    assert.equal(SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.upperPercentile, 0.975);
    assert.equal(SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.lowerNearestRank, 250);
    assert.equal(SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.upperNearestRank, 9_750);
    assert.equal(SNAPSHOT_CLUSTER_BOOTSTRAP_POLICY.drawDomain, "draw-v1");
    assert.equal(INDEPENDENT_AGGREGATE_SUPPRESSION_POLICY.suppressWhenIndependentNLessThan, 5);
    assert.equal(PROVIDER_REQUEST_POLICY.maxRetries, 1);
    assert.equal(PROVIDER_REQUEST_POLICY.retryableErrorClasses, "bound by providerPolicyDigest");
    assert.equal(PROVIDER_REQUEST_POLICY.timeoutValues, "bound by providerPolicyDigest");
    assert.equal(PROVIDER_REQUEST_POLICY.confirmationPolicy, "bound by providerPolicyDigest");
    assert.equal(
      COMPLETE_RANGE_PROVENANCE_POLICY.requiredCompleteQualifyingRangesPerApplicableScenario,
      1,
    );
    assert.equal(COMPLETE_RANGE_PROVENANCE_POLICY.falsePositiveOwnershipOrBoundaryClaimsAllowed, 0);
    assert.equal(COMPLETE_RANGE_PROVENANCE_POLICY.qualificationEstimatedTokenMinimum, 2_048);
  });

  it("derives the specified bootstrap seed and flattened golden resamples", () => {
    const seed = deriveBootstrapSeed("test-seed", DIGEST);
    assert.equal(seed, "5d4900fcf8455dfd03be5ce5fd8fc60491968844779b94db3b4409203af4f7f7");
    assert.deepEqual(
      [0, 1, 2, 3].flatMap((resample) => drawBootstrapResample(seed, 3, resample)),
      [0, 0, 1, 2, 2, 2, 0, 2, 1, 1, 0, 0],
    );
  });

  it("rejects invalid bootstrap draw boundaries and uses uint32 big-endian counters", () => {
    assert.deepEqual([...uint32BigEndian(0x01020304)], [1, 2, 3, 4]);
    schemaFailure(() => uint32BigEndian(-1));
    schemaFailure(() => uint32BigEndian(0x1_0000_0000));
    schemaFailure(() => drawBootstrapResample(DIGEST, 0, 0));
    schemaFailure(() => deriveBootstrapSeed("", DIGEST));
    schemaFailure(() => deriveBootstrapSeed("seed", "a".repeat(64).toUpperCase()));
  });
});
