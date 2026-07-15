import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  estimateQualificationTokens,
  evaluateContextPressure,
  qualifySession,
  validateQualificationRecord,
} from "../qualification.js";
import type {
  CandidateRangeInput,
  QualificationEntry,
  QualificationInput,
  QualificationMessage,
} from "../qualification.js";

function user(content: unknown): QualificationMessage {
  return { role: "user", content };
}

function assistant(content: unknown, stopReason = "stop"): QualificationMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    provider: "excluded-provider",
    model: "excluded-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  };
}

function visibleText(text: string): readonly QualificationMessage[] {
  return [user("generated request"), assistant([{ type: "text", text }])];
}

function messagesAtEstimate(target: number): readonly QualificationMessage[] {
  let low = 0;
  let high = target * 4 + 16;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const messages = visibleText("x".repeat(midpoint));
    const estimate = estimateQualificationTokens(messages);
    if (estimate === target) return messages;
    if (estimate < target) low = midpoint + 1;
    else high = midpoint - 1;
  }
  throw new Error(`unable to generate estimate ${target}`);
}

interface FixtureOptions {
  readonly messages?: readonly QualificationMessage[];
  readonly prefixEntries?: readonly Omit<QualificationEntry, "parentId">[];
  readonly subsequent?: number;
  readonly compactionInside?: boolean;
  readonly parentStatus?: QualificationInput["parentStatus"];
  readonly candidatePatch?: Partial<CandidateRangeInput>;
}

function fixture(options: FixtureOptions = {}): QualificationInput {
  const messages = options.messages ?? messagesAtEstimate(2_048);
  const entries: QualificationEntry[] = [];
  let parentId: string | undefined;
  const add = (entry: Omit<QualificationEntry, "parentId">) => {
    const next = { ...entry, ...(parentId === undefined ? {} : { parentId }) };
    entries.push(next);
    parentId = entry.id;
  };
  for (const entry of options.prefixEntries ?? []) add(entry);
  const candidateIds: string[] = [];
  messages.forEach((message, index) => {
    const id = `candidate-${index}`;
    add({ id, type: "message", message });
    candidateIds.push(id);
    if (options.compactionInside && index === 0)
      add({ id: "compaction-inside", type: "compaction" });
  });
  add({ id: "closure", type: "message", message: user("generated next goal") });
  for (let index = 0; index < (options.subsequent ?? 5); index += 1) {
    add({
      id: `future-${index}`,
      type: "message",
      message: assistant([{ type: "text", text: "generated future response" }]),
      requestOrigin: "main",
    });
  }
  const candidate: CandidateRangeInput = {
    startEntryId: candidateIds[0],
    endEntryId: candidateIds.at(-1)!,
    entryIds: candidateIds,
    closureEntryId: "closure",
    closureEvidence: ["goal-transition"],
    ...options.candidatePatch,
  };
  return {
    corpusId: "a".repeat(64),
    selectedRank: 1,
    parentStatus: options.parentStatus ?? "parent",
    selectedLeafId: entries.at(-1)!.id,
    entries,
    pressurePoints: [{ contextPercent: 70 }],
    nativeCompactionCount: 0,
    frozenModelRegistry: { contextWindows: new Map() },
    candidate,
  };
}

describe("qualification-only estimator", () => {
  it("hits the exact 2,047/2,048/2,049 boundaries", () => {
    for (const target of [2_047, 2_048, 2_049]) {
      assert.equal(estimateQualificationTokens(messagesAtEstimate(target)), target);
    }
    assert.equal(
      qualifySession(fixture({ messages: messagesAtEstimate(2_047) })).criteria.completedSegment,
      false,
    );
    assert.equal(
      qualifySession(fixture({ messages: messagesAtEstimate(2_048) })).criteria.completedSegment,
      true,
    );
    assert.equal(
      qualifySession(fixture({ messages: messagesAtEstimate(2_049) })).criteria.completedSegment,
      true,
    );
  });

  it("is byte-stable for non-ASCII, code, and model-visible tool payloads", () => {
    const call = "call-1";
    const messages: QualificationMessage[] = [
      user("const café = '☕';\n```ts\nexport const 値 = 1;\n```"),
      assistant(
        [{ type: "toolCall", id: call, name: "generated", arguments: { code: "λ" } }],
        "toolUse",
      ),
      {
        role: "toolResult",
        toolCallId: call,
        toolName: "generated",
        content: [{ type: "text", text: "結果" }],
        isError: false,
      },
    ];
    assert.equal(
      estimateQualificationTokens(messages),
      estimateQualificationTokens(structuredClone(messages)),
    );
  });

  it("excludes provider, model, usage, timestamps, and stop metadata", () => {
    const first = visibleText("same");
    const second = [
      first[0],
      {
        ...first[1],
        provider: "different",
        model: "different",
        stopReason: "different",
        usage: { totalTokens: 999_999, contextPercent: 99 },
      },
    ];
    assert.equal(estimateQualificationTokens(first), estimateQualificationTokens(second));
  });
});

describe("frozen context pressure", () => {
  const registry = { contextWindows: new Map([["p", new Map([["m", 100]])]]) };

  it("uses recorded percent at the exact 70% boundary", () => {
    assert.equal(evaluateContextPressure([{ contextPercent: 69.999 }], registry, 0).pass, false);
    assert.equal(evaluateContextPressure([{ contextPercent: 70 }], registry, 0).pass, true);
  });

  it("falls back to exact frozen windows and never guesses missing windows", () => {
    assert.deepEqual(
      evaluateContextPressure([{ totalTokens: 70, provider: "p", model: "m" }], registry, 0),
      {
        pass: true,
        maxRatio: 0.7,
      },
    );
    assert.equal(
      evaluateContextPressure(
        [{ input: 20, output: 20, cacheRead: 20, cacheWrite: 10, provider: "p", model: "m" }],
        registry,
        0,
      ).pass,
      true,
    );
    assert.deepEqual(
      evaluateContextPressure([{ totalTokens: 99, provider: "missing", model: "m" }], registry, 0),
      {
        pass: false,
      },
    );
  });

  it("accepts an observed native compaction without estimating pressure", () => {
    assert.deepEqual(evaluateContextPressure([], registry, 1), { pass: true });
  });
});

describe("complete range qualification", () => {
  it("qualifies a parent, pressured, complete range with five later main requests", () => {
    const result = qualifySession(fixture());
    assert.equal(result.qualifies, true);
    assert.deepEqual(result.criteria, {
      parent: true,
      pressure: true,
      completedSegment: true,
      fiveSubsequentRequests: true,
    });
    assert.deepEqual(result.reasonCodes, []);
    assert.equal(result.candidate?.estimatedTokens, 2_048);
    assert.deepEqual(result.candidate?.subsequentRequestIds, [
      "future-0",
      "future-1",
      "future-2",
      "future-3",
      "future-4",
    ]);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("generated request"), false);
    assert.equal(serialized.includes("generated next goal"), false);
    assert.equal(serialized.includes("excluded-provider"), false);
  });

  it("rejects non-parent sessions and fewer than five future requests", () => {
    const result = qualifySession(fixture({ parentStatus: "fork", subsequent: 4 }));
    assert.equal(result.qualifies, false);
    assert.equal(result.criteria.parent, false);
    assert.equal(result.criteria.fiveSubsequentRequests, false);
    assert.ok(result.reasonCodes.includes("not-eligible-parent"));
    assert.ok(result.reasonCodes.includes("fewer-than-five-subsequent-requests"));
  });

  it("rejects partial turns and unmatched tool calls", () => {
    const partial = qualifySession(fixture({ messages: [user("x")] }));
    assert.equal(partial.criteria.completedSegment, false);
    assert.ok(partial.reasonCodes.includes("incomplete-turn"));

    const unmatched = qualifySession(
      fixture({
        messages: [
          user("x".repeat(9_000)),
          assistant(
            [{ type: "toolCall", id: "missing", name: "generated", arguments: {} }],
            "toolUse",
          ),
        ],
      }),
    );
    assert.equal(unmatched.criteria.completedSegment, false);
    assert.ok(unmatched.reasonCodes.includes("unmatched-tool-call"));
  });

  it("reason-codes a tool result missing its linkage ID instead of throwing", () => {
    const result = qualifySession(
      fixture({
        messages: [
          user("x".repeat(9_000)),
          { role: "toolResult", content: [{ type: "text", text: "orphan" }], isError: false },
        ],
      }),
    );
    assert.equal(result.criteria.completedSegment, false);
    assert.ok(result.reasonCodes.includes("unmatched-tool-call"));
  });

  it("rejects cross-compaction and non-contiguous candidate ranges", () => {
    const compacted = qualifySession(fixture({ compactionInside: true }));
    assert.equal(compacted.criteria.completedSegment, false);
    assert.ok(compacted.reasonCodes.includes("candidate-cross-compaction"));

    const noncontiguous = qualifySession(
      fixture({ candidatePatch: { entryIds: ["candidate-0"] } }),
    );
    assert.equal(noncontiguous.criteria.completedSegment, false);
    assert.ok(noncontiguous.reasonCodes.includes("candidate-not-contiguous"));
  });

  it("rejects cross-branch endpoints and closure at or before the range end", () => {
    const crossBranch = qualifySession(
      fixture({ candidatePatch: { startEntryId: "abandoned-entry" } }),
    );
    assert.ok(crossBranch.reasonCodes.includes("candidate-cross-branch"));

    const badClosure = qualifySession(
      fixture({ candidatePatch: { closureEntryId: "candidate-1" } }),
    );
    assert.ok(badClosure.reasonCodes.includes("closure-not-after-range"));
  });

  it("requires objective successful tool evidence for verification-passed", () => {
    const result = qualifySession(
      fixture({ candidatePatch: { closureEvidence: ["verification-passed"] } }),
    );
    assert.equal(result.criteria.completedSegment, false);
    assert.ok(result.reasonCodes.includes("invalid-objective-verification"));
  });

  it("does not accept objective verification evidence from before the candidate range", () => {
    const result = qualifySession(
      fixture({
        prefixEntries: [
          { id: "prior-user", type: "message", message: user("prior") },
          {
            id: "prior-result",
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "prior-call",
              content: [{ type: "text", text: "prior success" }],
              isError: false,
            },
          },
        ],
        candidatePatch: {
          closureEvidence: ["verification-passed"],
          objectiveVerificationEntryId: "prior-result",
        },
      }),
    );
    assert.equal(result.criteria.completedSegment, false);
    assert.ok(result.reasonCodes.includes("invalid-objective-verification"));
  });

  it("accepts complete matched tools and in-range objective verification", () => {
    const call = "verified-call";
    const result = qualifySession(
      fixture({
        messages: [
          user("x".repeat(9_000)),
          assistant(
            [{ type: "toolCall", id: call, name: "generated", arguments: { check: true } }],
            "toolUse",
          ),
          {
            role: "toolResult",
            toolCallId: call,
            toolName: "generated",
            content: [{ type: "text", text: "passed" }],
            isError: false,
          },
        ],
        candidatePatch: {
          closureEvidence: ["verification-passed"],
          objectiveVerificationEntryId: "candidate-2",
        },
      }),
    );
    assert.equal(result.qualifies, true);
  });

  it("excludes ambiguous closure and is stable across input entry ordering", () => {
    const ambiguous = qualifySession(fixture({ candidatePatch: { closureEvidence: [] } }));
    assert.equal(ambiguous.criteria.completedSegment, false);
    assert.ok(ambiguous.reasonCodes.includes("closure-evidence-invalid"));

    const input = fixture();
    const reordered = qualifySession({ ...input, entries: [...input.entries].reverse() });
    assert.deepEqual(reordered, qualifySession(input));
  });

  it("counts only explicit main-agent provider requests", () => {
    const input = fixture();
    const entries = input.entries.map((entry) =>
      entry.id === "future-4" ? { ...entry, requestOrigin: "compaction" as const } : entry,
    );
    const result = qualifySession({ ...input, entries });
    assert.equal(result.criteria.fiveSubsequentRequests, false);
  });
});

describe("qualification result privacy schema", () => {
  it("accepts generated records and rejects any content-bearing extra field", () => {
    const result = qualifySession(fixture());
    assert.deepEqual(validateQualificationRecord(result), result);
    assert.throws(() => validateQualificationRecord({ ...result, content: "SECRET_CANARY" }), {
      code: "E_EVAL_SCHEMA",
    });
    assert.throws(
      () =>
        validateQualificationRecord({
          ...result,
          candidate: { ...result.candidate, toolPayload: "SECRET_CANARY" },
        }),
      { code: "E_EVAL_SCHEMA" },
    );
  });
});
