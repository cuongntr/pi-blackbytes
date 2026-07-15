import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BREAK_EVEN_BY_5_THRESHOLD,
  REDUCTION5_PASS_THRESHOLD,
  REDUCTION5_REVISE_THRESHOLD,
} from "../cost.js";
import {
  DECISION_P95_REVISE_MAX_MS,
  MINIMUM_QUALIFYING_SNAPSHOT_COUNT,
  REQUIRED_SAMPLED_SESSION_COUNT,
  decide,
  validateDecisionInput,
} from "../decision.js";
import { BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS } from "../lifecycle/benchmark.js";
import { RECALL_DELTA_THRESHOLD } from "../scoring.js";

const remedy = { kind: "non-invasive" as const, description: "avoid an extra allocation" };

function passingInput() {
  return {
    quality: {
      recallDelta: RECALL_DELTA_THRESHOLD,
      taskCompletionDelta: 0,
      treatmentOnlySevereEvent: false,
    },
    utility: {
      status: "complete" as const,
      medianReduction5: REDUCTION5_PASS_THRESHOLD,
      breakEvenBy5Rate: BREAK_EVEN_BY_5_THRESHOLD,
    },
    applicability: {
      sampledSessionCount: REQUIRED_SAMPLED_SESSION_COUNT,
      qualifyingSnapshotCount: MINIMUM_QUALIFYING_SNAPSHOT_COUNT,
    },
    feasibility: {
      provenanceFalsePositiveCount: 0,
      lifecycleScenarioMissCount: 0,
      lifecycleFix: null,
      p95Ms: BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS - 0.001,
      performanceOptimization: null,
    },
  };
}

function merge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  return { ...base, ...patch };
}

function tracePass(result: ReturnType<typeof decide>, id: string): boolean {
  const trace = result.trace.find((item) => item.id === id);
  assert.ok(trace, `missing trace step ${id}`);
  return trace.pass;
}

describe("T-014 mechanical decision partition", () => {
  it("returns GO only when all four gates pass and emits a stable complete trace", () => {
    const input = passingInput();
    const first = decide(input);
    const second = decide(input);
    assert.equal(first.outcome, "GO");
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.gates.map((gate) => gate.pass),
      [true, true, true, true],
    );
    assert.deepEqual(
      first.trace.map((item) => item.id),
      [
        "G001.recall",
        "G001.completion",
        "G001.severe-event",
        "G002.actual-usage",
        "G002.median-reduction",
        "G002.break-even-by-5",
        "G003.sample-count",
        "G003.qualifying-snapshots",
        "G004.provenance",
        "G004.lifecycle-scenarios",
        "G004.p95",
        "REVISE.utility",
        "REVISE.performance",
        "REVISE.lifecycle",
        "REVISE.provider-data",
        "REVISE.exactly-one-deviation",
        "OUTCOME",
      ],
    );
  });

  it("covers every inclusive and exclusive threshold endpoint", () => {
    const cost = passingInput();
    assert.equal(
      decide(merge(cost, { utility: { ...cost.utility, medianReduction5: 0.1 - 1e-9 } })).outcome,
      "REVISE",
    );
    assert.equal(
      decide(
        merge(cost, {
          utility: { ...cost.utility, medianReduction5: REDUCTION5_REVISE_THRESHOLD },
        }),
      ).outcome,
      "REVISE",
    );
    assert.equal(
      decide(
        merge(cost, {
          utility: { ...cost.utility, medianReduction5: REDUCTION5_REVISE_THRESHOLD - 1e-9 },
        }),
      ).outcome,
      "NO-GO",
    );
    assert.equal(
      decide(
        merge(cost, { utility: { ...cost.utility, medianReduction5: REDUCTION5_PASS_THRESHOLD } }),
      ).outcome,
      "GO",
    );
    assert.equal(
      decide(
        merge(cost, {
          utility: { ...cost.utility, breakEvenBy5Rate: BREAK_EVEN_BY_5_THRESHOLD - 1e-9 },
        }),
      ).outcome,
      "NO-GO",
    );
    assert.equal(
      decide(
        merge(cost, { utility: { ...cost.utility, breakEvenBy5Rate: BREAK_EVEN_BY_5_THRESHOLD } }),
      ).outcome,
      "GO",
    );

    const performance = passingInput();
    assert.equal(
      decide(
        merge(performance, {
          feasibility: {
            ...performance.feasibility,
            p95Ms: BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS,
            performanceOptimization: remedy,
          },
        }),
      ).outcome,
      "REVISE",
    );
    assert.equal(
      decide(
        merge(performance, {
          feasibility: {
            ...performance.feasibility,
            p95Ms: DECISION_P95_REVISE_MAX_MS,
            performanceOptimization: remedy,
          },
        }),
      ).outcome,
      "REVISE",
    );
    assert.equal(
      decide(
        merge(performance, {
          feasibility: {
            ...performance.feasibility,
            p95Ms: DECISION_P95_REVISE_MAX_MS + 1e-9,
            performanceOptimization: remedy,
          },
        }),
      ).outcome,
      "NO-GO",
    );
    assert.equal(
      decide(
        merge(performance, {
          feasibility: {
            ...performance.feasibility,
            p95Ms: BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS - 1e-9,
          },
        }),
      ).outcome,
      "GO",
    );

    const applicability = passingInput();
    assert.equal(
      decide(
        merge(applicability, {
          applicability: {
            ...applicability.applicability,
            qualifyingSnapshotCount: MINIMUM_QUALIFYING_SNAPSHOT_COUNT - 1,
          },
        }),
      ).outcome,
      "NO-GO",
    );
    assert.equal(
      decide(
        merge(applicability, {
          applicability: {
            ...applicability.applicability,
            sampledSessionCount: REQUIRED_SAMPLED_SESSION_COUNT - 1,
            qualifyingSnapshotCount: MINIMUM_QUALIFYING_SNAPSHOT_COUNT - 1,
          },
        }),
      ).outcome,
      "NO-GO",
    );
    assert.equal(
      decide(
        merge(applicability, {
          quality: { ...applicability.quality, recallDelta: RECALL_DELTA_THRESHOLD - 1e-9 },
        }),
      ).outcome,
      "NO-GO",
    );
  });

  it("permits each and only each single REVISE deviation", () => {
    const base = passingInput();
    const variants = [
      merge(base, { utility: { ...base.utility, medianReduction5: REDUCTION5_REVISE_THRESHOLD } }),
      merge(base, {
        feasibility: {
          ...base.feasibility,
          p95Ms: BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS,
          performanceOptimization: remedy,
        },
      }),
      merge(base, {
        feasibility: { ...base.feasibility, lifecycleScenarioMissCount: 1, lifecycleFix: remedy },
      }),
      merge(base, {
        utility: {
          status: "missing" as const,
          collectionExtension: {
            status: "permitted" as const,
            description: "collect provider usage",
          },
        },
      }),
    ];
    for (const variant of variants) assert.equal(decide(variant).outcome, "REVISE");

    const combined = merge(base, {
      utility: { ...base.utility, medianReduction5: REDUCTION5_REVISE_THRESHOLD },
      feasibility: {
        ...base.feasibility,
        p95Ms: BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS,
        performanceOptimization: remedy,
      },
    });
    assert.equal(decide(combined).outcome, "NO-GO");
    assert.equal(tracePass(decide(combined), "REVISE.exactly-one-deviation"), false);
  });

  it("makes every listed hard-stop NO-GO", () => {
    const base = passingInput();
    const cases = [
      merge(base, { quality: { ...base.quality, taskCompletionDelta: -1e-9 } }),
      merge(base, { quality: { ...base.quality, treatmentOnlySevereEvent: true } }),
      merge(base, { feasibility: { ...base.feasibility, provenanceFalsePositiveCount: 1 } }),
      merge(base, {
        feasibility: { ...base.feasibility, lifecycleScenarioMissCount: 2, lifecycleFix: remedy },
      }),
      merge(base, {
        utility: { ...base.utility, medianReduction5: REDUCTION5_REVISE_THRESHOLD - 1e-9 },
      }),
      merge(base, { utility: { ...base.utility, medianReduction5: -0.01 } }),
      merge(base, {
        utility: { ...base.utility, breakEvenBy5Rate: BREAK_EVEN_BY_5_THRESHOLD - 1e-9 },
      }),
      merge(base, {
        feasibility: {
          ...base.feasibility,
          p95Ms: DECISION_P95_REVISE_MAX_MS + 1e-9,
          performanceOptimization: remedy,
        },
      }),
      merge(base, {
        utility: {
          status: "missing" as const,
          collectionExtension: { status: "exhausted" as const, description: "usage still absent" },
        },
      }),
      merge(base, { applicability: { sampledSessionCount: 0, qualifyingSnapshotCount: 0 } }),
    ];
    for (const input of cases) assert.equal(decide(input).outcome, "NO-GO");
  });

  it("partitions all 2^4 gate combinations crossed with all deviation variants", () => {
    const deviations = ["none", "utility", "performance", "lifecycle", "provider"] as const;
    for (let mask = 0; mask < 16; mask += 1) {
      for (const deviation of deviations) {
        const base = passingInput();
        const qualityPass = (mask & 1) !== 0;
        const utilityPass = (mask & 2) !== 0;
        const applicabilityPass = (mask & 4) !== 0;
        const feasibilityPass = (mask & 8) !== 0;
        let input = merge(base, {
          quality: {
            ...base.quality,
            recallDelta: qualityPass ? 0 : RECALL_DELTA_THRESHOLD - 0.01,
          },
          utility: {
            ...base.utility,
            medianReduction5: utilityPass ? REDUCTION5_PASS_THRESHOLD : 0,
          },
          applicability: {
            ...base.applicability,
            qualifyingSnapshotCount: applicabilityPass
              ? MINIMUM_QUALIFYING_SNAPSHOT_COUNT
              : MINIMUM_QUALIFYING_SNAPSHOT_COUNT - 1,
          },
          feasibility: {
            ...base.feasibility,
            p95Ms: feasibilityPass ? 0 : DECISION_P95_REVISE_MAX_MS + 1,
          },
        });
        if (deviation === "utility")
          input = merge(input, {
            utility: { ...base.utility, medianReduction5: REDUCTION5_REVISE_THRESHOLD },
          });
        if (deviation === "performance")
          input = merge(input, {
            feasibility: {
              ...base.feasibility,
              p95Ms: BENCHMARK_ABSOLUTE_P95_THRESHOLD_MS,
              performanceOptimization: remedy,
            },
          });
        if (deviation === "lifecycle")
          input = merge(input, {
            feasibility: {
              ...base.feasibility,
              lifecycleScenarioMissCount: 1,
              lifecycleFix: remedy,
            },
          });
        if (deviation === "provider")
          input = merge(input, {
            utility: {
              status: "missing" as const,
              collectionExtension: { status: "permitted" as const, description: "collect usage" },
            },
          });
        const result = decide(input);
        assert.ok(["GO", "REVISE", "NO-GO"].includes(result.outcome));
        assert.equal(result.trace.length, 17);
        const candidates = result.trace.filter(
          (item) => item.id.startsWith("REVISE.") && item.id !== "REVISE.exactly-one-deviation",
        );
        const candidateCount = candidates.filter((item) => item.pass).length;
        const expected = result.gates.every((gate) => gate.pass)
          ? "GO"
          : result.gates[0]!.pass && result.gates[2]!.pass && candidateCount === 1
            ? "REVISE"
            : "NO-GO";
        assert.equal(result.outcome, expected);
      }
    }
  });

  it("rejects malformed, missing, non-finite, and outcome override input", () => {
    const base = passingInput();
    const invalid = [
      null,
      {},
      { ...base, outcome: "GO" },
      { ...base, override: "REVISE" },
      { ...base, quality: { ...base.quality, recallDelta: Number.NaN } },
      { ...base, quality: { ...base.quality, taskCompletionDelta: Number.POSITIVE_INFINITY } },
      { ...base, utility: { ...base.utility, breakEvenBy5Rate: 1.01 } },
      { ...base, feasibility: { ...base.feasibility, p95Ms: -1 } },
      {
        ...base,
        feasibility: {
          ...base.feasibility,
          lifecycleFix: { kind: "invasive", description: "rewrite it" },
        },
      },
      { ...base, applicability: { sampledSessionCount: 41, qualifyingSnapshotCount: 10 } },
      {
        ...base,
        utility: {
          status: "missing",
          collectionExtension: { status: "permitted", description: "" },
        },
      },
    ];
    for (const value of invalid) {
      assert.throws(() => validateDecisionInput(value), { code: "E_EVAL_SCHEMA" });
      assert.throws(() => decide(value), { code: "E_EVAL_SCHEMA" });
    }
  });
});
