/** Generated, deterministic lifecycle fixtures for the evaluation-only shadow runner. */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { canonicalDigest, canonicalJson } from "../canonical-json.js";
import {
  type GeneratedCompactionUsageFixture,
  createGeneratedCompactionUsageFixture,
} from "./compaction-usage.js";
import type {
  CandidateRange,
  ContextMessage,
  GroundTruthBoundary,
  ProvenanceGroundTruth,
  SourceProjection,
} from "./provenance.js";

export const LIFECYCLE_SCENARIO_IDS = [
  "reload",
  "native-compaction",
  "branch-fork-tree",
  "steering-follow-up",
  "duplicate-messages",
  "sequential-tool-calls",
] as const;

export type LifecycleScenarioId = (typeof LIFECYCLE_SCENARIO_IDS)[number];

export const CONTEXT_HOOK_LOAD_ORDERS = [
  "shadow-before-transformer",
  "transformer-before-shadow",
] as const;

export type ContextHookLoadOrder = (typeof CONTEXT_HOOK_LOAD_ORDERS)[number];

/** A discriminated, inspectable record of the lifecycle action represented by a fixture. */
export type LifecycleOperation =
  | { readonly kind: "reload"; readonly checkpointId: string }
  | {
      readonly kind: "native-compaction";
      readonly summaryId: string;
      readonly compactedTurnCount: number;
    }
  | {
      readonly kind: "branch-fork-tree";
      readonly selectedBranchId: string;
      readonly topology: readonly {
        readonly branchId: string;
        readonly parentId: string | null;
        readonly selected: boolean;
        readonly state: "root" | "selected" | "abandoned";
      }[];
    }
  | {
      readonly kind: "steering-follow-up";
      readonly steeringTurn: number;
      readonly followUpTurn: number;
    }
  | {
      readonly kind: "duplicate-messages";
      readonly duplicateSourceIndices: readonly [number, number];
    }
  | { readonly kind: "sequential-tool-calls"; readonly toolCallIds: readonly string[] };

export interface LifecycleFixture {
  /** Deterministic, model-visible fixture material; never copied into evidence. */
  readonly modelVisiblePayload: string;
  readonly timestampOrigin: number;
  /** Provider-free usage-attribution fixtures attached only to native compaction. */
  readonly compactionUsage?: GeneratedCompactionUsageFixture;
}

export interface LifecycleScenario {
  readonly id: LifecycleScenarioId;
  readonly operation: LifecycleOperation;
  readonly fixture: LifecycleFixture;
  /** Qualification estimate, never actual or billed tokens. */
  readonly qualificationEstimatedTokens: number;
  readonly sourceProjections: readonly SourceProjection[];
  readonly candidates: readonly CandidateRange[];
  readonly groundTruth: ProvenanceGroundTruth;
  readonly transformerMessage: ContextMessage;
  readonly sourceDigest: string;
}

export interface ScenarioObservation {
  readonly observedMessages: readonly ContextMessage[];
  readonly groundTruth: ProvenanceGroundTruth;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function fixtureClock(origin: number): () => number {
  let timestamp = origin;
  return () => {
    timestamp += 1;
    return timestamp;
  };
}

function visiblePayload(id: LifecycleScenarioId, operation: LifecycleOperation): string {
  const seed = canonicalJson({ id, operation, fixture: "generated-lifecycle-v1" });
  // 12 KiB of actual model-visible UTF-8 content keeps the locked byte/4 estimator qualifying.
  return `${seed}\n${"lifecycle fixture material ".repeat(520)}`;
}

function user(label: string, payload: string, timestamp: () => number): ContextMessage {
  return {
    role: "user",
    content: `${label}: ${payload}`,
    timestamp: timestamp(),
  } as ContextMessage;
}

function assistant(label: string, timestamp: () => number, toolCallId?: string): ContextMessage {
  return {
    role: "assistant",
    content: toolCallId
      ? [{ type: "toolCall", id: toolCallId, name: "generated-tool", arguments: {} }]
      : [{ type: "text", text: `generated ${label} answer` }],
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
    timestamp: timestamp(),
  } as ContextMessage;
}

function toolResult(toolCallId: string, timestamp: () => number): ContextMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "generated-tool",
    content: [{ type: "text", text: `generated result ${toolCallId}` }],
    isError: false,
    timestamp: timestamp(),
  } as ContextMessage;
}

function completeToolTurn(
  label: string,
  payload: string,
  timestamp: () => number,
  toolCalls = 2,
): readonly ContextMessage[] {
  const messages: ContextMessage[] = [user(label, payload, timestamp)];
  for (let call = 1; call <= toolCalls; call += 1) {
    const id = `${label}-call-${call}`;
    messages.push(assistant(label, timestamp, id), toolResult(id, timestamp));
  }
  messages.push(assistant(label, timestamp));
  return messages;
}

/** The locked qualification estimator: ceil(UTF8ByteLength(canonical content) / 4). */
export function estimateCanonicalModelVisibleTokens(canonicalContent: string): number {
  return Math.ceil(Buffer.byteLength(canonicalContent, "utf8") / 4);
}

export function canonicalModelVisiblePayload(
  scenario: Pick<LifecycleScenario, "sourceProjections">,
): string {
  return canonicalJson(scenario.sourceProjections.map((entry) => entry.message));
}

function makeScenario(
  id: LifecycleScenarioId,
  operation: LifecycleOperation,
  buildMessages: (payload: string, timestamp: () => number) => readonly ContextMessage[],
  rangeStart = 0,
): LifecycleScenario {
  const timestampOrigin = 1_700_000_000_000 + LIFECYCLE_SCENARIO_IDS.indexOf(id) * 1_000;
  const fixture = {
    modelVisiblePayload: visiblePayload(id, operation),
    timestampOrigin,
    ...(id === "native-compaction"
      ? { compactionUsage: createGeneratedCompactionUsageFixture() }
      : {}),
  };
  const timestamp = fixtureClock(timestampOrigin);
  const messages = buildMessages(fixture.modelVisiblePayload, timestamp);
  const sourceProjections = messages.map((message, index) => ({
    sourceEntryId: canonicalDigest({ scenario: id, sourceEntry: index }),
    message,
  }));
  const rangeEntries = sourceProjections.slice(rangeStart);
  const boundary: GroundTruthBoundary = {
    startContextIndex: rangeStart,
    endContextIndex: sourceProjections.length - 1,
    startEntryId: rangeEntries[0].sourceEntryId,
    endEntryId: rangeEntries.at(-1)!.sourceEntryId,
    requiredSourceEntryIds: rangeEntries.map((entry) => entry.sourceEntryId),
  };
  const completeTurns: readonly GroundTruthBoundary[] =
    id === "steering-follow-up"
      ? [
          {
            startContextIndex: 0,
            endContextIndex: 5,
            startEntryId: sourceProjections[0].sourceEntryId,
            endEntryId: sourceProjections[5].sourceEntryId,
            requiredSourceEntryIds: sourceProjections
              .slice(0, 6)
              .map((entry) => entry.sourceEntryId),
          },
          {
            startContextIndex: 6,
            endContextIndex: 11,
            startEntryId: sourceProjections[6].sourceEntryId,
            endEntryId: sourceProjections[11].sourceEntryId,
            requiredSourceEntryIds: sourceProjections.slice(6).map((entry) => entry.sourceEntryId),
          },
        ]
      : [boundary];
  const candidateId = canonicalDigest({ scenario: id, candidate: "complete-turn" });
  const estimate = estimateCanonicalModelVisibleTokens(
    canonicalJson(rangeEntries.map((entry) => entry.message)),
  );
  return deepFreeze({
    id,
    operation,
    fixture,
    qualificationEstimatedTokens: estimate,
    sourceProjections,
    sourceDigest: canonicalDigest({ domain: "generated-lifecycle-source-v1", sourceProjections }),
    candidates: [
      {
        candidateId,
        startEntryId: boundary.startEntryId,
        endEntryId: boundary.endEntryId,
        estimatedTokens: estimate,
      },
    ],
    groundTruth: {
      contextOwners: sourceProjections.map((entry, index) =>
        id === "duplicate-messages" && index < rangeStart ? null : entry.sourceEntryId,
      ),
      completeTurns,
      ranges: [{ candidateId, ...boundary }],
    },
    transformerMessage: user(`${id}-synthetic-transformer`, "transformer-only", timestamp),
  });
}

/** Return generated-only scenarios; no source session or repository fixture is read. */
export function createGeneratedLifecycleScenarios(): readonly LifecycleScenario[] {
  return deepFreeze([
    makeScenario(
      "reload",
      { kind: "reload", checkpointId: "reload-checkpoint" },
      (payload, clock) => completeToolTurn("reload", payload, clock),
    ),
    makeScenario(
      "native-compaction",
      { kind: "native-compaction", summaryId: "native-summary", compactedTurnCount: 3 },
      (payload, clock) => completeToolTurn("native-compaction", payload, clock),
    ),
    makeScenario(
      "branch-fork-tree",
      {
        kind: "branch-fork-tree",
        selectedBranchId: "selected-leaf",
        topology: [
          { branchId: "root", parentId: null, selected: true, state: "root" },
          { branchId: "abandoned-leaf", parentId: "root", selected: false, state: "abandoned" },
          { branchId: "selected-leaf", parentId: "root", selected: true, state: "selected" },
        ],
      },
      (payload, clock) => completeToolTurn("selected-branch", payload, clock),
    ),
    makeScenario(
      "steering-follow-up",
      { kind: "steering-follow-up", steeringTurn: 0, followUpTurn: 1 },
      (payload, clock) => [
        ...completeToolTurn("steering", payload, clock),
        ...completeToolTurn("follow-up", payload, clock),
      ],
    ),
    makeScenario(
      "duplicate-messages",
      { kind: "duplicate-messages", duplicateSourceIndices: [0, 1] },
      (payload, clock) => {
        const duplicate = user("duplicate", payload, clock);
        return [
          duplicate,
          structuredClone(duplicate),
          ...completeToolTurn("unique", payload, clock),
        ];
      },
      2,
    ),
    makeScenario(
      "sequential-tool-calls",
      {
        kind: "sequential-tool-calls",
        toolCallIds: [
          "sequential-tool-calls-call-1",
          "sequential-tool-calls-call-2",
          "sequential-tool-calls-call-3",
        ],
      },
      (payload, clock) => completeToolTurn("sequential-tool-calls", payload, clock, 3),
    ),
  ]);
}

/** Model the two context-hook orders without mutating a source projection. */
export function observeScenario(
  scenario: LifecycleScenario,
  loadOrder: ContextHookLoadOrder,
): ScenarioObservation {
  const copiedMessages = structuredClone(scenario.sourceProjections.map((entry) => entry.message));
  if (loadOrder === "shadow-before-transformer") {
    return { observedMessages: copiedMessages, groundTruth: scenario.groundTruth };
  }
  return {
    observedMessages: [...copiedMessages, structuredClone(scenario.transformerMessage)],
    groundTruth: {
      ...scenario.groundTruth,
      contextOwners: [...scenario.groundTruth.contextOwners, null],
    },
  };
}

/** A type-only assertion that scenario observations are valid Pi context message arrays. */
export function asContextMessages(messages: readonly ContextMessage[]): ContextEvent["messages"] {
  return messages as ContextEvent["messages"];
}
