import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  type SessionEntry,
  buildSessionContext as sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

import { canonicalDigest } from "../canonical-json.js";
import { createShadowContextHandler } from "../lifecycle/extension.js";
import {
  type ContextMessage,
  type GroundTruthBoundary,
  type ProvenanceGroundTruth,
  type SourceProjection,
  UNIQUE_STRUCTURAL_EXACT_METHOD,
  compareProvenanceEvidence,
  evaluateProvenance,
  serializeProvenanceEvidence,
} from "../lifecycle/provenance.js";
import { COMPLETE_RANGE_PROVENANCE_POLICY } from "../protocol.js";

let clock = 0;
const id = (value: unknown): string => canonicalDigest(value);
const candidateId = (value: unknown): string => canonicalDigest(value);

function user(text: string): ContextMessage {
  clock += 1;
  return { role: "user", content: text, timestamp: clock };
}

function assistant(text: string, toolCallId?: string): ContextMessage {
  clock += 1;
  return {
    role: "assistant",
    content: toolCallId
      ? [{ type: "toolCall", id: toolCallId, name: "generated-tool", arguments: {} }]
      : [{ type: "text", text }],
    api: "generated-api",
    provider: "generated-provider",
    model: "generated-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: toolCallId ? "toolUse" : "stop",
    timestamp: clock,
  } as ContextMessage;
}

function assistantWithToolCalls(toolCallIds: readonly string[]): ContextMessage {
  const message = assistant("", toolCallIds[0]);
  return {
    ...message,
    content: toolCallIds.map((toolCallId) => ({
      type: "toolCall",
      id: toolCallId,
      name: "generated-tool",
      arguments: {},
    })),
    stopReason: "toolUse",
  } as ContextMessage;
}

function toolResult(toolCallId: string, isError = false): ContextMessage {
  clock += 1;
  return {
    role: "toolResult",
    toolCallId,
    toolName: "generated-tool",
    content: [{ type: "text", text: `result-${toolCallId}` }],
    isError,
    timestamp: clock,
  } as ContextMessage;
}

function source(messages: readonly ContextMessage[]): readonly SourceProjection[] {
  return messages.map((message, index) => ({ sourceEntryId: id({ entry: index + 1 }), message }));
}

function boundary(
  projections: readonly SourceProjection[],
  startContextIndex = 0,
  endContextIndex = projections.length - 1,
  requiredSourceEntryIds = projections.map((projection) => projection.sourceEntryId),
): GroundTruthBoundary {
  return {
    startContextIndex,
    endContextIndex,
    startEntryId: projections[startContextIndex].sourceEntryId,
    endEntryId: projections[endContextIndex].sourceEntryId,
    requiredSourceEntryIds,
  };
}

function truth(projections: readonly SourceProjection[], range = true): ProvenanceGroundTruth {
  const complete = boundary(projections);
  return {
    contextOwners: projections.map((projection) => projection.sourceEntryId),
    completeTurns: [complete],
    ranges: range ? [{ candidateId: candidateId("candidate-1"), ...complete }] : [],
  };
}

function candidate(projections: readonly SourceProjection[], estimatedTokens = 2048) {
  return {
    candidateId: candidateId("candidate-1"),
    startEntryId: projections[0].sourceEntryId,
    endEntryId: projections.at(-1)!.sourceEntryId,
    estimatedTokens,
  };
}

function ownershipClaims(projections: readonly SourceProjection[]) {
  return projections.map((projection, contextIndex) => ({
    contextIndex,
    sourceEntryId: projection.sourceEntryId,
    method: UNIQUE_STRUCTURAL_EXACT_METHOD,
  }));
}

function completeToolTurn(isError = false): readonly ContextMessage[] {
  return [
    user(`private full qualification request ${"x".repeat(8_192)}`),
    assistantWithToolCalls(["call-one", "call-two"]),
    toolResult("call-one", isError),
    toolResult("call-two"),
    assistant("", "call-three"),
    toolResult("call-three"),
    assistant("private completed answer"),
  ];
}

describe("conservative lifecycle provenance", () => {
  it("claims a full >=2048 complete range with ownership endpoint atoms", () => {
    const projections = source(completeToolTurn());
    const result = evaluateProvenance({
      sourceProjections: projections,
      observedMessages: projections.map((projection) => projection.message),
      candidates: [candidate(projections)],
      groundTruth: truth(projections),
    });

    assert.equal(result.comparison.pass, true);
    assert.equal(result.evidence.ownershipClaims.length, projections.length);
    assert.deepEqual(result.evidence.completeTurnClaims, [
      {
        start: ownershipClaims(projections)[0],
        end: ownershipClaims(projections).at(-1),
      },
    ]);
    assert.deepEqual(result.evidence.completeRangeClaims, [
      {
        candidateId: candidateId("candidate-1"),
        start: ownershipClaims(projections)[0],
        end: ownershipClaims(projections).at(-1),
      },
    ]);
    assert.equal(Object.isFrozen(result.evidence), true);
    assert.equal(Object.isFrozen(result.evidence.completeTurnClaims[0].start), true);
    assert.equal(result.comparison.turnCoverage.coverage, 1);
  });

  it("validates qualifying ranges as ordered partitions of multiple complete turns", () => {
    const projections = source([
      ...completeToolTurn(),
      user("private second qualification request"),
      assistant("private second completed answer"),
    ]);
    const firstTurn = boundary(
      projections,
      0,
      6,
      projections.slice(0, 7).map((item) => item.sourceEntryId),
    );
    const secondTurn = boundary(
      projections,
      7,
      8,
      projections.slice(7).map((item) => item.sourceEntryId),
    );
    const wholeRange = boundary(projections);
    const groundTruth: ProvenanceGroundTruth = {
      contextOwners: projections.map((item) => item.sourceEntryId),
      completeTurns: [firstTurn, secondTurn],
      ranges: [{ candidateId: candidateId("candidate-1"), ...wholeRange }],
    };
    const result = evaluateProvenance({
      sourceProjections: projections,
      observedMessages: projections.map((item) => item.message),
      candidates: [candidate(projections)],
      groundTruth,
    });

    assert.equal(result.comparison.pass, true);
    assert.equal(result.evidence.completeTurnClaims.length, 2);
    assert.equal(result.evidence.completeRangeClaims.length, 1);
    assert.equal(result.comparison.turnCoverage.coverage, 1);

    const omittedSourceIndex = 2;
    const partialOwners = projections
      .filter((_, index) => index !== omittedSourceIndex)
      .map((item) => item.sourceEntryId);
    const partialFirstTurn = { ...firstTurn, endContextIndex: 5 };
    const partialSecondTurn = {
      ...secondTurn,
      startContextIndex: 6,
      endContextIndex: 7,
    };
    const partialRange = { ...wholeRange, endContextIndex: 7 };
    const partial = evaluateProvenance({
      sourceProjections: projections,
      observedMessages: projections
        .filter((_, index) => index !== omittedSourceIndex)
        .map((item) => item.message),
      candidates: [candidate(projections)],
      groundTruth: {
        contextOwners: partialOwners,
        completeTurns: [partialFirstTurn, partialSecondTurn],
        ranges: [{ candidateId: candidateId("candidate-1"), ...partialRange }],
      },
    });

    assert.equal(partial.evidence.completeTurnClaims.length, 1);
    assert.equal(partial.evidence.completeRangeClaims.length, 0);
    assert.equal(partial.comparison.fullyCoveredQualifyingCandidateCount, 0);
    assert.equal(partial.comparison.pass, false);
  });

  it("fails partial, dangling, and below-minimum ranges without inference", () => {
    const projections = source(completeToolTurn());
    const observed = projections
      .filter((_, index) => index !== 2)
      .map((projection) => projection.message);
    const partialOwners = projections
      .filter((_, index) => index !== 2)
      .map((projection) => projection.sourceEntryId);
    const partialBoundary = {
      ...boundary(projections),
      endContextIndex: partialOwners.length - 1,
      endEntryId: projections.at(-1)!.sourceEntryId,
    };
    const partialTruth: ProvenanceGroundTruth = {
      ...truth(projections),
      contextOwners: partialOwners,
      completeTurns: [partialBoundary],
      ranges: [{ candidateId: candidateId("candidate-1"), ...partialBoundary }],
    };
    const partial = evaluateProvenance({
      sourceProjections: projections,
      observedMessages: observed,
      candidates: [candidate(projections)],
      groundTruth: partialTruth,
    });
    assert.equal(partial.evidence.completeRangeClaims.length, 0);
    assert.equal(partial.comparison.pass, false);

    const dangling = source([user("request"), assistant("", "dangling-call")]);
    const danglingResult = evaluateProvenance({
      sourceProjections: dangling,
      observedMessages: dangling.map((item) => item.message),
      candidates: [candidate(dangling)],
      groundTruth: truth(dangling),
    });
    assert.equal(danglingResult.evidence.completeTurnClaims.length, 0);
    assert.equal(danglingResult.comparison.pass, false);

    const belowMinimum = evaluateProvenance({
      sourceProjections: projections,
      observedMessages: projections.map((item) => item.message),
      candidates: [candidate(projections, 2047)],
      groundTruth: truth(projections),
    });
    assert.equal(belowMinimum.comparison.qualifyingCandidateCount, 0);
  });

  it("requires exact complete turns for turn coverage and qualifying range success", () => {
    const projections = source(completeToolTurn());
    const allOwners = ownershipClaims(projections);
    const range = {
      candidateId: candidateId("candidate-1"),
      start: allOwners[0],
      end: allOwners.at(-1)!,
    };
    const comparison = compareProvenanceEvidence(
      { ownershipClaims: allOwners, completeTurnClaims: [], completeRangeClaims: [range] },
      truth(projections),
      [candidate(projections)],
      projections.map((item) => item.sourceEntryId),
    );
    assert.equal(comparison.fullyCoveredQualifyingCandidateCount, 0);
    assert.equal(comparison.turnCoverage.coverage, 0);
    assert.equal(comparison.pass, false);
  });

  it("cannot pass a forged boundary spanning a transformer-created insertion", () => {
    const projections = source([user("request"), assistant("answer")]);
    const owners = [
      ownershipClaims(projections)[0],
      { ...ownershipClaims(projections)[1], contextIndex: 2 },
    ];
    const complete = {
      startContextIndex: 0,
      endContextIndex: 2,
      startEntryId: projections[0].sourceEntryId,
      endEntryId: projections[1].sourceEntryId,
      requiredSourceEntryIds: projections.map((item) => item.sourceEntryId),
    };
    const comparison = compareProvenanceEvidence(
      {
        ownershipClaims: owners,
        completeTurnClaims: [{ start: owners[0], end: owners[1] }],
        completeRangeClaims: [
          { candidateId: candidateId("candidate-1"), start: owners[0], end: owners[1] },
        ],
      },
      {
        contextOwners: [projections[0].sourceEntryId, null, projections[1].sourceEntryId],
        completeTurns: [complete],
        ranges: [{ candidateId: candidateId("candidate-1"), ...complete }],
      },
      [candidate(projections)],
      projections.map((item) => item.sourceEntryId),
    );
    assert.equal(comparison.ownershipFalsePositives, 0);
    assert.equal(comparison.boundaryFalsePositives, 0);
    assert.equal(comparison.turnCoverage.coverage, 0);
    assert.equal(comparison.fullyCoveredQualifyingCandidateCount, 0);
    assert.equal(comparison.pass, false);
  });

  it("counts wrong endpoint context indices and unknown valid IDs as false positives", () => {
    const projections = source(completeToolTurn());
    const owners = ownershipClaims(projections);
    const comparison = compareProvenanceEvidence(
      {
        ownershipClaims: [{ ...owners[0], sourceEntryId: id("unknown-owner") }],
        completeTurnClaims: [
          { start: { ...owners[0], contextIndex: 1 }, end: { ...owners.at(-1)! } },
          { start: { ...owners[0], sourceEntryId: id("unknown-boundary") }, end: owners.at(-1)! },
        ],
        completeRangeClaims: [
          { candidateId: candidateId("unknown-candidate"), start: owners[0], end: owners.at(-1)! },
        ],
      },
      truth(projections),
      [candidate(projections)],
      projections.map((item) => item.sourceEntryId),
    );
    assert.equal(comparison.ownershipFalsePositives, 1);
    assert.equal(comparison.boundaryFalsePositives, 3);
    assert.equal(comparison.pass, false);
  });

  it("counts duplicate source/context claims as false positives and never lets them become correct", () => {
    const projections = source(completeToolTurn());
    const owners = ownershipClaims(projections);
    const comparison = compareProvenanceEvidence(
      {
        ownershipClaims: [
          owners[0],
          owners[0],
          { ...owners[1], sourceEntryId: owners[0].sourceEntryId },
        ],
        completeTurnClaims: [],
        completeRangeClaims: [],
      },
      truth(projections),
      [candidate(projections)],
      projections.map((item) => item.sourceEntryId),
    );
    assert.equal(comparison.ownershipFalsePositives, 2);
    assert.equal(comparison.messageCoverage.correct, 1);
  });

  it("suppresses duplicate source/context buckets and leaves transformer-created messages unowned", () => {
    const duplicate = user("identical private content");
    const duplicateSource = source([duplicate, structuredClone(duplicate), assistant("answer")]);
    const duplicateSourceResult = evaluateProvenance({
      sourceProjections: duplicateSource,
      observedMessages: duplicateSource.map((item) => item.message),
      candidates: [],
      groundTruth: {
        contextOwners: [null, null, duplicateSource[2].sourceEntryId],
        completeTurns: [],
        ranges: [],
      },
    });
    assert.deepEqual(
      duplicateSourceResult.evidence.ownershipClaims.map((claim) => claim.sourceEntryId),
      [duplicateSource[2].sourceEntryId],
    );

    const projections = source([user("request"), assistant("answer")]);
    const transformer = user("transformer-created unique private content");
    const transformerResult = evaluateProvenance({
      sourceProjections: projections,
      observedMessages: [...projections.map((item) => item.message), transformer],
      candidates: [],
      groundTruth: {
        contextOwners: [...projections.map((item) => item.sourceEntryId), null],
        completeTurns: [],
        ranges: [],
      },
    });
    assert.equal(transformerResult.evidence.ownershipClaims.length, 2);
  });

  it("fails an indistinguishable one-for-one identical replacement scenario", () => {
    const projections = source([user("request"), assistant("answer")]);
    const replacement = projections.map((item) => structuredClone(item.message));
    const result = evaluateProvenance({
      sourceProjections: projections,
      observedMessages: replacement,
      candidates: [],
      groundTruth: { contextOwners: [null, null], completeTurns: [], ranges: [] },
    });
    assert.equal(result.evidence.ownershipClaims.length, 2);
    assert.equal(result.comparison.ownershipFalsePositives, 2);
    assert.equal(result.comparison.pass, false);
  });

  it("treats matched error tool results as structurally complete", () => {
    const projections = source(completeToolTurn(true));
    const result = evaluateProvenance({
      sourceProjections: projections,
      observedMessages: projections.map((item) => item.message),
      candidates: [candidate(projections)],
      groundTruth: truth(projections),
    });
    assert.equal(result.evidence.completeTurnClaims.length, 1);
    assert.equal(result.comparison.pass, true);
  });

  it("rejects out-of-order tool batches and tool-use stops without calls", () => {
    const outOfOrder = source([
      user("request"),
      assistant("", "late-result"),
      assistant("premature next response"),
      toolResult("late-result"),
    ]);
    const toolUseWithoutCalls = source([
      user("request"),
      { ...assistant("empty tool use"), stopReason: "toolUse" } as ContextMessage,
    ]);
    for (const projections of [outOfOrder, toolUseWithoutCalls]) {
      const result = evaluateProvenance({
        sourceProjections: projections,
        observedMessages: projections.map((item) => item.message),
        candidates: [],
        groundTruth: {
          contextOwners: projections.map((item) => item.sourceEntryId),
          completeTurns: [],
          ranges: [],
        },
      });
      assert.equal(result.evidence.completeTurnClaims.length, 0);
    }
  });

  it("rejects raw/path IDs without serializing them and validates ground-truth ownership/boundaries", () => {
    const canary = "/private/path/PATH-CANARY";
    assert.throws(
      () =>
        evaluateProvenance({
          sourceProjections: [{ sourceEntryId: canary, message: user("TRANSCRIPT-CANARY") }],
          observedMessages: [],
          candidates: [],
          groundTruth: { contextOwners: [], completeTurns: [], ranges: [] },
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "E_EVAL_SCHEMA" &&
        !error.message.includes(canary),
    );
    const projections = source([user("request"), assistant("answer")]);
    assert.throws(
      () =>
        evaluateProvenance({
          sourceProjections: projections,
          observedMessages: projections.map((item) => item.message),
          candidates: [{ ...candidate(projections), candidateId: canary }],
          groundTruth: {
            contextOwners: projections.map((item) => item.sourceEntryId),
            completeTurns: [],
            ranges: [],
          },
        }),
      { code: "E_EVAL_SCHEMA" },
    );
    assert.throws(
      () =>
        evaluateProvenance({
          sourceProjections: projections,
          observedMessages: projections.map((item) => item.message),
          candidates: [],
          groundTruth: {
            contextOwners: [projections[0].sourceEntryId],
            completeTurns: [],
            ranges: [],
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
    assert.throws(
      () =>
        evaluateProvenance({
          sourceProjections: projections,
          observedMessages: projections.map((item) => item.message),
          candidates: [],
          groundTruth: {
            contextOwners: [projections[0].sourceEntryId, projections[0].sourceEntryId],
            completeTurns: [],
            ranges: [],
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
    const invalidBoundary = { ...boundary(projections), startContextIndex: 1 };
    assert.throws(
      () =>
        evaluateProvenance({
          sourceProjections: projections,
          observedMessages: projections.map((item) => item.message),
          candidates: [],
          groundTruth: {
            contextOwners: projections.map((item) => item.sourceEntryId),
            completeTurns: [invalidBoundary],
            ranges: [],
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
    const serialized = serializeProvenanceEvidence({
      ownershipClaims: ownershipClaims(projections),
      completeTurnClaims: [],
      completeRangeClaims: [],
    });
    assert.equal(serialized.includes(canary), false);
    assert.equal(serialized.includes("content"), false);
  });

  it("cannot pass with zero claims against positive complete-range ground truth", () => {
    const projections = source(completeToolTurn());
    const comparison = compareProvenanceEvidence(
      { ownershipClaims: [], completeTurnClaims: [], completeRangeClaims: [] },
      truth(projections),
      [candidate(projections)],
      projections.map((item) => item.sourceEntryId),
    );
    assert.equal(comparison.messageCoverage.correct, 0);
    assert.equal(comparison.turnCoverage.correct, 0);
    assert.equal(comparison.fullyCoveredQualifyingCandidateCount, 0);
    assert.equal(comparison.pass, false);
  });

  it("reports zero coverage when no owners or complete turns are expected", () => {
    const projections = source([user("request")]);
    const comparison = compareProvenanceEvidence(
      { ownershipClaims: [], completeTurnClaims: [], completeRangeClaims: [] },
      { contextOwners: [null], completeTurns: [], ranges: [] },
      [],
      projections.map((item) => item.sourceEntryId),
    );
    assert.equal(comparison.messageCoverage.coverage, 0);
    assert.equal(comparison.turnCoverage.coverage, 0);
  });

  it("uses deterministic permutations of unique and duplicate source/context buckets", () => {
    for (const sourceDuplicate of [false, true]) {
      for (const contextDuplicate of [false, true]) {
        const first = user("bucket-a");
        const second = sourceDuplicate ? structuredClone(first) : user("bucket-b");
        const projections = source([first, second, assistant("answer")]);
        const observed = contextDuplicate
          ? [
              projections[0].message,
              structuredClone(projections[0].message),
              projections[2].message,
            ]
          : projections.map((item) => item.message);
        const sourceCounts = projections.map(
          (projection) =>
            projections.filter(
              (item) => JSON.stringify(item.message) === JSON.stringify(projection.message),
            ).length,
        );
        const contextCounts = observed.map(
          (message) =>
            observed.filter((item) => JSON.stringify(item) === JSON.stringify(message)).length,
        );
        const owners = observed.map((message) => {
          const sourceIndex = projections.findIndex(
            (item) => JSON.stringify(item.message) === JSON.stringify(message),
          );
          return sourceIndex >= 0 &&
            sourceCounts[sourceIndex] === 1 &&
            contextCounts[observed.indexOf(message)] === 1
            ? projections[sourceIndex].sourceEntryId
            : null;
        });
        const result = evaluateProvenance({
          sourceProjections: projections,
          observedMessages: observed,
          candidates: [],
          groundTruth: { contextOwners: owners, completeTurns: [], ranges: [] },
        });
        assert.equal(
          result.evidence.ownershipClaims.length,
          owners.filter((owner) => owner !== null).length,
        );
      }
    }
  });

  it("returns exact context references through the content-free shadow wrapper", () => {
    const projections = source([user("request"), assistant("answer")]);
    const groundTruth = {
      contextOwners: projections.map((item) => item.sourceEntryId),
      completeTurns: [boundary(projections)],
      ranges: [],
    };
    let observed: readonly ContextMessage[] | undefined;
    let sunk: ReturnType<typeof evaluateProvenance> | undefined;
    const handler = createShadowContextHandler(
      (messages) => {
        observed = messages;
        return evaluateProvenance({
          sourceProjections: projections,
          observedMessages: messages,
          candidates: [],
          groundTruth,
        });
      },
      (value) => {
        sunk = value;
      },
    );
    const messages = projections.map((item) => item.message);
    const result = handler({ type: "context", messages });
    assert.equal(result.messages, messages);
    assert.equal(observed, messages);
    assert.equal(sunk?.comparison.pass, false);
    assert.equal(sunk?.evidence.ownershipClaims.length, 2);
    assert.equal(result.messages[0], messages[0]);
  });

  it("projects copied SessionEntry structures and leaves production imports unchanged", () => {
    const messages = completeToolTurn();
    const entries: SessionEntry[] = messages.map((message, index) => ({
      type: "message",
      id: `copy-${index + 1}`,
      parentId: index === 0 ? null : `copy-${index}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    }));
    const copiedEntries = structuredClone(entries);
    const projected = sessionEntryToContextMessages(copiedEntries).messages;
    const projections = copiedEntries.map((entry, index) => {
      if (entry.type !== "message") throw new Error("generated fixture error");
      return { sourceEntryId: id({ copy: index + 1 }), message: entry.message };
    });
    const result = evaluateProvenance({
      sourceProjections: projections,
      observedMessages: projected,
      candidates: [candidate(projections)],
      groundTruth: truth(projections),
    });
    assert.equal(result.comparison.pass, true);
    assert.equal(readFileSync("src/index.ts", "utf8").includes("context-pruning/lifecycle"), false);
  });
});
