/** Provider-free capture of actual Pi compaction lifecycle facts. */

import { canonicalDigest, canonicalJson } from "../canonical-json.js";
import type { SafeRun } from "../path-safety.js";
import { safeRunFileExists, safeRunPublishExclusiveFile, safeRunReadFile } from "../path-safety.js";
import { EvidenceStoreError } from "../types.js";

/** @deprecated Probes are exclusively stored as immutable files in `compaction-usage-probes/`. */
export const COMPACTION_USAGE_EVIDENCE_PATH = "compaction-usage.jsonl";
export const COMPACTION_USAGE_PROBE_EVENT_TYPE = "compaction-usage-probe-v3";
const PROBE_MARKER_DIRECTORY = "compaction-usage-probes";
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface PiUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

interface FactBase {
  readonly eventId: string;
  readonly timestamp: string;
}
/** These are facts from Pi hooks; deliberately no caller supplied operation or billing label exists. */
export interface SessionBeforeCompactFact extends FactBase {
  readonly type: "session_before_compact";
  readonly cycleId: string;
  readonly turnId: string;
  readonly isSplitTurn: boolean;
}
export interface SessionCompactFact extends FactBase {
  readonly type: "session_compact";
  readonly cycleId: string;
}
export interface BeforeAgentStartFact extends FactBase {
  readonly type: "before_agent_start";
  readonly turnId: string;
}
export interface BeforeProviderRequestFact extends FactBase {
  readonly type: "before_provider_request";
  readonly requestId: string;
}
/** A content-free copy of actual Pi assistant/provider Usage, if Pi exposed it. */
export interface UsageObservationFact extends FactBase {
  readonly type: "usage_observation" | "message_end";
  readonly requestId: string;
  readonly usage?: unknown;
}
export type PiLifecycleFact =
  | SessionBeforeCompactFact
  | SessionCompactFact
  | BeforeAgentStartFact
  | BeforeProviderRequestFact
  | UsageObservationFact;

export interface CompactionUsageCaptureInput {
  readonly events: readonly PiLifecycleFact[];
}
export type BillingDisposition = "billed" | "unknown";
export type CompactionUsageStatus =
  | "complete"
  | "missing"
  | "merged"
  | "ambiguous"
  | "duplicate"
  | "split-turn"
  | "multi-attempt";
export interface ObservedUsageAttempt {
  readonly attemptId: string;
  /** Derived from session_before_compact/session_compact ordering, never supplied by a caller. */
  readonly operationId: string;
  readonly operation: "native-compaction" | "following-main";
  readonly billing: BillingDisposition;
  readonly usage?: PiUsage;
}
export interface CompactionUsageCapture {
  readonly status: CompactionUsageStatus;
  readonly compactionAttempts: readonly ObservedUsageAttempt[];
  readonly followingMainAttempts: readonly ObservedUsageAttempt[];
  readonly compactionUsage?: PiUsage;
  readonly followingMainUsage?: PiUsage;
  readonly evidenceEventIds: readonly string[];
}
export interface GeneratedCompactionUsageFixture {
  readonly complete: CompactionUsageCaptureInput;
  readonly missing: CompactionUsageCaptureInput;
  readonly merged: CompactionUsageCaptureInput;
  readonly ambiguous: CompactionUsageCaptureInput;
  readonly duplicate: CompactionUsageCaptureInput;
  readonly splitTurn: CompactionUsageCaptureInput;
  readonly multiAttempt: CompactionUsageCaptureInput;
}
export interface HorizonEntry {
  readonly entryId: string;
  readonly type: "message" | "compaction";
  readonly timestamp: string;
}
export interface FiveRequestHorizon {
  readonly horizonId: string;
  readonly closureEntryId: string;
  readonly requestEntryIds: readonly [string, string, string, string, string];
}
export interface CompactionHorizonCounts {
  readonly horizonCount: number;
  readonly horizonsWithCompaction: number;
  readonly compactionEntriesInsideHorizons: number;
}
export interface CompactionUsageProbeArtifact {
  readonly eventId: string;
  readonly timestamp: string;
  readonly type: typeof COMPACTION_USAGE_PROBE_EVENT_TYPE;
  readonly data: {
    readonly probeId: string;
    readonly facts: readonly PiLifecycleFact[];
    readonly capture: CompactionUsageCapture;
  };
}

function schema(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}
function integrity(message: string): never {
  throw new EvidenceStoreError("E_EVAL_INTEGRITY", message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...fields].sort());
}
function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) schema(`${name} must be a stable safe ID`);
  return value;
}
function requireDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) schema(`${name} must be a SHA-256 digest`);
  return value;
}
function requireTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value)
    schema(`${name} must be an exact ISO-8601 instant`);
  return value;
}
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
/** Parse Pi Usage as Pi reports it. No invented actual/billed channels are accepted. */
export function parseReportedUsage(value: unknown): PiUsage | undefined {
  // Persisted usage is a closed PiUsage value. Accepting provider-owned extras
  // would turn this content-free ledger into an unbounded raw-output channel.
  if (
    !isRecord(value) ||
    !isRecord(value.cost) ||
    !exactFields(value, ["cacheRead", "cacheWrite", "cost", "input", "output", "totalTokens"]) ||
    !exactFields(value.cost, ["cacheRead", "cacheWrite", "input", "output", "total"])
  )
    return undefined;
  const input = finite(value.input);
  const output = finite(value.output);
  const cacheRead = finite(value.cacheRead);
  const cacheWrite = finite(value.cacheWrite);
  const totalTokens = finite(value.totalTokens);
  const costInput = finite(value.cost.input);
  const costOutput = finite(value.cost.output);
  const costCacheRead = finite(value.cost.cacheRead);
  const costCacheWrite = finite(value.cost.cacheWrite);
  const costTotal = finite(value.cost.total);
  if (
    [
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      costInput,
      costOutput,
      costCacheRead,
      costCacheWrite,
      costTotal,
    ].some((item) => item === undefined)
  )
    return undefined;
  return Object.freeze({
    input: input!,
    output: output!,
    cacheRead: cacheRead!,
    cacheWrite: cacheWrite!,
    totalTokens: totalTokens!,
    cost: Object.freeze({
      input: costInput!,
      output: costOutput!,
      cacheRead: costCacheRead!,
      cacheWrite: costCacheWrite!,
      total: costTotal!,
    }),
  });
}
export const parseReportedUsageChannels = parseReportedUsage;

function validateFact(value: unknown): PiLifecycleFact {
  if (!isRecord(value)) schema("Pi lifecycle fact must be an object");
  const eventId = requireDigest(value.eventId, "eventId");
  const timestamp = requireTimestamp(value.timestamp, "timestamp");
  if (value.type === "session_before_compact") {
    if (
      !exactFields(value, ["cycleId", "eventId", "isSplitTurn", "timestamp", "turnId", "type"]) ||
      typeof value.isSplitTurn !== "boolean"
    )
      schema("session_before_compact fact has invalid schema");
    return Object.freeze({
      eventId,
      timestamp,
      type: value.type,
      cycleId: requireId(value.cycleId, "cycleId"),
      turnId: requireId(value.turnId, "turnId"),
      isSplitTurn: value.isSplitTurn,
    });
  }
  if (value.type === "session_compact") {
    if (!exactFields(value, ["cycleId", "eventId", "timestamp", "type"]))
      schema("session_compact fact has invalid schema");
    return Object.freeze({
      eventId,
      timestamp,
      type: value.type,
      cycleId: requireId(value.cycleId, "cycleId"),
    });
  }
  if (value.type === "before_agent_start") {
    if (!exactFields(value, ["eventId", "timestamp", "turnId", "type"]))
      schema("before_agent_start fact has invalid schema");
    return Object.freeze({
      eventId,
      timestamp,
      type: value.type,
      turnId: requireId(value.turnId, "turnId"),
    });
  }
  if (value.type === "before_provider_request") {
    if (!exactFields(value, ["eventId", "requestId", "timestamp", "type"]))
      schema("before_provider_request fact has invalid schema");
    return Object.freeze({
      eventId,
      timestamp,
      type: value.type,
      requestId: requireId(value.requestId, "requestId"),
    });
  }
  if (value.type === "usage_observation" || value.type === "message_end") {
    const fields = [
      "eventId",
      "requestId",
      "timestamp",
      "type",
      ...(Object.hasOwn(value, "usage") ? ["usage"] : []),
    ];
    if (!exactFields(value, fields)) schema(`${value.type} fact has invalid schema`);
    return Object.freeze({
      eventId,
      timestamp,
      type: value.type,
      requestId: requireId(value.requestId, "requestId"),
      ...(Object.hasOwn(value, "usage") ? { usage: value.usage } : {}),
    });
  }
  return schema("Pi lifecycle fact has an unsupported type");
}
function sumUsage(values: readonly PiUsage[]): PiUsage | undefined {
  if (values.length === 0) return undefined;
  const sum = (get: (usage: PiUsage) => number) =>
    values.reduce((total, usage) => total + get(usage), 0);
  return Object.freeze({
    input: sum((u) => u.input),
    output: sum((u) => u.output),
    cacheRead: sum((u) => u.cacheRead),
    cacheWrite: sum((u) => u.cacheWrite),
    totalTokens: sum((u) => u.totalTokens),
    cost: Object.freeze({
      input: sum((u) => u.cost.input),
      output: sum((u) => u.cost.output),
      cacheRead: sum((u) => u.cost.cacheRead),
      cacheWrite: sum((u) => u.cost.cacheWrite),
      total: sum((u) => u.cost.total),
    }),
  });
}

/** Pure state reducer: ordering of actual Pi hooks is the only attribution authority. */
export function captureCompactionUsage(input: CompactionUsageCaptureInput): CompactionUsageCapture {
  if (!Array.isArray(input.events)) schema("Lifecycle facts must be an array");
  const facts = input.events.map(validateFact);
  const byId = new Map<string, string>();
  let duplicate = false;
  let ambiguous = false;
  let priorTimestamp: string | undefined;
  const unique: PiLifecycleFact[] = [];
  for (const fact of facts) {
    if (priorTimestamp !== undefined && fact.timestamp < priorTimestamp) ambiguous = true;
    priorTimestamp = fact.timestamp;
    const previous = byId.get(fact.eventId);
    const canonical = canonicalJson(fact);
    if (previous === undefined) {
      byId.set(fact.eventId, canonical);
      unique.push(fact);
    } else if (previous === canonical) duplicate = true;
    else ambiguous = true;
  }
  type Attempt = {
    readonly requestId: string;
    readonly operation: "native-compaction" | "following-main";
    readonly operationId: string;
    reports: UsageObservationFact[];
  };
  const attempts = new Map<string, Attempt>();
  const cycles = new Map<
    string,
    { turnId: string; isSplitTurn: boolean; ended: boolean; compactionRequests: number }
  >();
  let activeCycle: string | undefined;
  let activeTurn: string | undefined;
  let mainReady = false;
  let observedCycle = false;
  for (const fact of unique) {
    if (fact.type === "before_agent_start") {
      if (activeCycle !== undefined) ambiguous = true;
      activeTurn = fact.turnId;
      mainReady = true;
    } else if (fact.type === "session_before_compact") {
      if (activeCycle !== undefined || (activeTurn !== undefined && activeTurn !== fact.turnId))
        ambiguous = true;
      if (cycles.has(fact.cycleId)) ambiguous = true;
      cycles.set(fact.cycleId, {
        turnId: fact.turnId,
        isSplitTurn: fact.isSplitTurn,
        ended: false,
        compactionRequests: 0,
      });
      activeCycle = fact.cycleId;
      activeTurn = fact.turnId;
      mainReady = false;
      observedCycle = true;
    } else if (fact.type === "session_compact") {
      const cycle = cycles.get(fact.cycleId);
      if (activeCycle !== fact.cycleId || cycle === undefined || cycle.ended) ambiguous = true;
      else {
        cycle.ended = true;
        activeCycle = undefined;
        mainReady = true;
      }
    } else if (fact.type === "before_provider_request") {
      if (attempts.has(fact.requestId)) {
        ambiguous = true;
        continue;
      }
      if (activeCycle !== undefined) {
        const cycle = cycles.get(activeCycle)!;
        cycle.compactionRequests += 1;
        attempts.set(fact.requestId, {
          requestId: fact.requestId,
          operation: "native-compaction",
          operationId: activeCycle,
          reports: [],
        });
      } else if (mainReady && activeTurn !== undefined) {
        attempts.set(fact.requestId, {
          requestId: fact.requestId,
          operation: "following-main",
          operationId: activeTurn,
          reports: [],
        });
      } else ambiguous = true;
    } else {
      const attempt = attempts.get(fact.requestId);
      if (attempt === undefined) ambiguous = true;
      else attempt.reports.push(fact);
    }
  }
  if (activeCycle !== undefined) ambiguous = true;
  const merged = [...cycles.values()].some(
    (cycle) => cycle.ended && cycle.compactionRequests === 0,
  );
  const observed: ObservedUsageAttempt[] = [];
  let missing = false;
  for (const attempt of attempts.values()) {
    let usage: PiUsage | undefined;
    if (attempt.reports.length === 0) missing = true;
    else if (attempt.reports.length > 1) duplicate = true;
    else if (attempt.reports[0]!.usage === undefined) missing = true;
    else {
      usage = parseReportedUsage(attempt.reports[0]!.usage);
      if (usage === undefined) ambiguous = true;
    }
    observed.push(
      Object.freeze({
        attemptId: attempt.requestId,
        operationId: attempt.operationId,
        operation: attempt.operation,
        billing: usage === undefined ? "unknown" : "billed",
        ...(usage === undefined ? {} : { usage }),
      }),
    );
  }
  const compactions = observed.filter((item) => item.operation === "native-compaction");
  const mains = observed.filter((item) => item.operation === "following-main");
  if (!observedCycle || compactions.length === 0 || mains.length === 0) ambiguous ||= !merged;
  const completeUsage = (items: readonly ObservedUsageAttempt[]) =>
    items.length > 0 &&
    items.every((item) => item.billing === "billed" && item.usage !== undefined);
  const compactionUsage = completeUsage(compactions)
    ? sumUsage(compactions.map((item) => item.usage!))
    : undefined;
  const followingMainUsage = completeUsage(mains)
    ? sumUsage(mains.map((item) => item.usage!))
    : undefined;
  const multiAttempt = [...cycles.entries()].some(
    ([cycleId, cycle]) =>
      cycle.compactionRequests > 1 &&
      compactions.filter((item) => item.operationId === cycleId).length > 1,
  );
  const splitTurn = [...cycles.values()].some((cycle) => cycle.isSplitTurn);
  const status: CompactionUsageStatus = ambiguous
    ? "ambiguous"
    : merged
      ? "merged"
      : missing
        ? "missing"
        : duplicate
          ? "duplicate"
          : splitTurn
            ? "split-turn"
            : multiAttempt
              ? "multi-attempt"
              : "complete";
  return Object.freeze({
    status,
    compactionAttempts: Object.freeze(compactions),
    followingMainAttempts: Object.freeze(mains),
    ...(compactionUsage === undefined ? {} : { compactionUsage }),
    ...(followingMainUsage === undefined ? {} : { followingMainUsage }),
    evidenceEventIds: Object.freeze(unique.map((fact) => fact.eventId)),
  });
}

export interface PiLifecycleRecorderOptions {
  readonly recorderId: string;
  readonly now: () => string;
}
/** Adapter for Pi's real hooks. It records no prompt, payload, messages, or provider label. */
type PendingProviderRequest = {
  readonly requestId: string;
  readonly phase: "native-compaction" | "following-main";
};

export class PiCompactionUsageRecorder {
  readonly #facts: PiLifecycleFact[] = [];
  #pendingRequests: PendingProviderRequest[] = [];
  #sequence = 0;
  #turn = 0;
  #cycle = 0;
  #request = 0;
  #activeCycleId: string | undefined;
  constructor(private readonly options: PiLifecycleRecorderOptions) {
    requireId(options.recorderId, "recorderId");
  }
  get facts(): readonly PiLifecycleFact[] {
    return Object.freeze([...this.#facts]);
  }
  #emit<T extends Omit<PiLifecycleFact, "eventId" | "timestamp">>(fact: T): void {
    this.#sequence += 1;
    this.#facts.push(
      Object.freeze({
        ...fact,
        timestamp: requireTimestamp(this.options.now(), "recorder timestamp"),
        eventId: canonicalDigest({
          domain: "pi-compaction-hook-fact-v3",
          recorderId: this.options.recorderId,
          sequence: this.#sequence,
        }),
      }) as unknown as PiLifecycleFact,
    );
  }
  beforeAgentStart(): string {
    const turnId = `${this.options.recorderId}-turn-${++this.#turn}`;
    this.#emit({ type: "before_agent_start", turnId });
    return turnId;
  }
  sessionBeforeCompact(preparation: { readonly isSplitTurn: boolean }): string {
    const turnId = `${this.options.recorderId}-turn-${this.#turn || 1}`;
    const cycleId = `${this.options.recorderId}-cycle-${++this.#cycle}`;
    this.#activeCycleId = cycleId;
    this.#emit({
      type: "session_before_compact",
      cycleId,
      turnId,
      isSplitTurn: preparation.isSplitTurn,
    });
    return cycleId;
  }
  sessionCompact(): void {
    if (this.#activeCycleId !== undefined) {
      this.#emit({ type: "session_compact", cycleId: this.#activeCycleId });
      // A compaction request has no message_end to attribute. Preserve its request fact
      // for the reducer, but discard unresolved recorder state without inventing usage.
      this.#pendingRequests = this.#pendingRequests.filter(
        (request) => request.phase !== "native-compaction",
      );
    }
    this.#activeCycleId = undefined;
  }
  beforeProviderRequest(): string {
    const requestId = `${this.options.recorderId}-request-${++this.#request}`;
    this.#pendingRequests.push({
      requestId,
      phase: this.#activeCycleId === undefined ? "following-main" : "native-compaction",
    });
    this.#emit({ type: "before_provider_request", requestId });
    return requestId;
  }
  observeProviderUsage(requestId: string, usage: unknown): void {
    requireId(requestId, "requestId");
    const pending = this.#pendingRequests.findIndex((request) => request.requestId === requestId);
    if (pending >= 0) this.#pendingRequests.splice(pending, 1);
    this.#emit({ type: "usage_observation", requestId, ...(usage === undefined ? {} : { usage }) });
  }
  messageEnd(message: unknown): void {
    const pending = this.#pendingRequests.findIndex(
      (request) => request.phase === "following-main",
    );
    if (pending < 0) return;
    const [request] = this.#pendingRequests.splice(pending, 1);
    const usage = isRecord(message) ? message.usage : undefined;
    this.#emit({
      type: "message_end",
      requestId: request!.requestId,
      ...(usage === undefined ? {} : { usage }),
    });
  }
}
/** Minimal structural Pi extension adapter; callers register its methods on the matching Pi events. */
export function createPiCompactionUsageRecorder(
  options: PiLifecycleRecorderOptions,
): PiCompactionUsageRecorder {
  return new PiCompactionUsageRecorder(options);
}

/** The subset of Pi's extension host used by this provider-free instrumentation. */
export interface PiLifecycleHookHost {
  on(
    event:
      | "before_agent_start"
      | "session_before_compact"
      | "session_compact"
      | "before_provider_request"
      | "message_end",
    handler: (event: unknown) => void,
  ): void;
}

/**
 * Wire the recorder to Pi's actual lifecycle hooks. Payload and message content are
 * never retained: only preparation.isSplitTurn and message.usage are observed.
 */
export function registerPiCompactionUsageRecorder(
  pi: PiLifecycleHookHost,
  recorder: PiCompactionUsageRecorder,
): void {
  pi.on("before_agent_start", () => recorder.beforeAgentStart());
  pi.on("session_before_compact", (event) => {
    if (
      !isRecord(event) ||
      !isRecord(event.preparation) ||
      typeof event.preparation.isSplitTurn !== "boolean"
    ) {
      return;
    }
    recorder.sessionBeforeCompact({ isSplitTurn: event.preparation.isSplitTurn });
  });
  pi.on("session_compact", () => recorder.sessionCompact());
  pi.on("before_provider_request", () => recorder.beforeProviderRequest());
  pi.on("message_end", (event) => recorder.messageEnd(isRecord(event) ? event.message : undefined));
}

function generatedUsage(seed: number): PiUsage {
  return Object.freeze({
    input: seed,
    output: seed + 1,
    cacheRead: 2,
    cacheWrite: 3,
    totalTokens: seed + 9,
    cost: Object.freeze({
      input: 0.01 * seed,
      output: 0.02,
      cacheRead: 0.003,
      cacheWrite: 0.004,
      total: 0.01 * seed + 0.027,
    }),
  });
}
function fixtureFacts(name: string, split = false, multi = false): CompactionUsageCaptureInput {
  let tick = 0;
  const recorder = createPiCompactionUsageRecorder({
    recorderId: name,
    now: () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  });
  recorder.beforeAgentStart();
  recorder.sessionBeforeCompact({ isSplitTurn: split });
  const first = recorder.beforeProviderRequest();
  if (multi) {
    const second = recorder.beforeProviderRequest();
    recorder.observeProviderUsage(second, generatedUsage(30));
  }
  recorder.observeProviderUsage(first, generatedUsage(10));
  recorder.sessionCompact();
  const main = recorder.beforeProviderRequest();
  recorder.messageEnd({ usage: generatedUsage(20) });
  return { events: recorder.facts };
}
/** Generated real-hook sequences, not synthetic operation labels. */
export function createGeneratedCompactionUsageFixture(): GeneratedCompactionUsageFixture {
  const complete = fixtureFacts("complete");
  const missing = fixtureFacts("missing");
  const mergedRecorder = createPiCompactionUsageRecorder({
    recorderId: "merged",
    now: () => "2026-01-01T00:00:00.000Z",
  });
  mergedRecorder.beforeAgentStart();
  mergedRecorder.sessionBeforeCompact({ isSplitTurn: false });
  mergedRecorder.sessionCompact();
  mergedRecorder.beforeProviderRequest();
  const ambiguous = fixtureFacts("ambiguous");
  const duplicate = fixtureFacts("duplicate");
  return Object.freeze({
    complete,
    missing: Object.freeze({
      events: missing.events.filter(
        (fact) => !(fact.type === "usage_observation" && fact.requestId === "missing-request-1"),
      ),
    }),
    merged: Object.freeze({ events: mergedRecorder.facts }),
    ambiguous: Object.freeze({
      events: [
        ...ambiguous.events,
        Object.freeze({
          eventId: canonicalDigest("ambiguous-conflict"),
          timestamp: "2026-01-01T00:00:59.000Z",
          type: "usage_observation" as const,
          requestId: "stray-request",
          usage: generatedUsage(99),
        }),
      ],
    }),
    duplicate: Object.freeze({
      events: [
        ...duplicate.events,
        (() => {
          const fact = duplicate.events.find((item) => item.type === "usage_observation")!;
          if (fact.type !== "usage_observation")
            throw new Error("fixture usage observation missing");
          return Object.freeze({
            ...fact,
            eventId: canonicalDigest("duplicate-observation"),
            timestamp: "2026-01-01T00:01:00.000Z",
          });
        })(),
      ],
    }),
    splitTurn: fixtureFacts("split", true),
    multiAttempt: fixtureFacts("multi", false, true),
  });
}

/** Count compactions strictly after closure through checkpoint five, inclusive. */
export function countCompactionInFiveRequestHorizons(
  entries: readonly HorizonEntry[],
  horizons: readonly FiveRequestHorizon[],
): CompactionHorizonCounts {
  const positions = new Map<string, number>();
  let prior: string | undefined;
  for (const [index, entry] of entries.entries()) {
    requireDigest(entry.entryId, "entryId");
    requireTimestamp(entry.timestamp, "timestamp");
    if (entry.type !== "message" && entry.type !== "compaction")
      schema("Horizon entry type is invalid");
    if (positions.has(entry.entryId)) integrity("Horizon entry IDs must be unique");
    if (prior !== undefined && entry.timestamp < prior)
      integrity("Horizon entries must be timestamp ordered");
    prior = entry.timestamp;
    positions.set(entry.entryId, index);
  }
  const ids = new Set<string>();
  let horizonsWithCompaction = 0;
  let compactionEntriesInsideHorizons = 0;
  for (const horizon of horizons) {
    requireId(horizon.horizonId, "horizonId");
    if (ids.has(horizon.horizonId)) schema("Horizon ID is duplicated");
    ids.add(horizon.horizonId);
    requireDigest(horizon.closureEntryId, "closureEntryId");
    if (!Array.isArray(horizon.requestEntryIds) || horizon.requestEntryIds.length !== 5)
      schema("A compaction horizon must contain exactly five request entry IDs");
    const closure = positions.get(horizon.closureEntryId);
    const requests = horizon.requestEntryIds.map((id) => {
      requireDigest(id, "requestEntryId");
      const position = positions.get(id);
      if (position === undefined || entries[position]?.type !== "message")
        integrity("Horizon request ID does not identify a message entry");
      return position;
    });
    if (
      closure === undefined ||
      new Set(requests).size !== 5 ||
      closure >= requests[0]! ||
      requests.some((value, index) => index > 0 && value <= requests[index - 1]!)
    )
      integrity("Horizon must satisfy closure < request1 < ... < request5");
    const count = entries
      .slice(closure + 1, requests[4]! + 1)
      .filter((entry) => entry.type === "compaction").length;
    compactionEntriesInsideHorizons += count;
    if (count > 0) horizonsWithCompaction += 1;
  }
  return Object.freeze({
    horizonCount: horizons.length,
    horizonsWithCompaction,
    compactionEntriesInsideHorizons,
  });
}

export function createCompactionUsageProbeArtifact(
  probeId: string,
  timestamp: string,
  facts: readonly PiLifecycleFact[],
): CompactionUsageProbeArtifact {
  requireId(probeId, "probeId");
  requireTimestamp(timestamp, "timestamp");
  const authoritativeFacts = Object.freeze(facts.map(validateFact));
  const data = Object.freeze({
    probeId,
    facts: authoritativeFacts,
    capture: captureCompactionUsage({ events: authoritativeFacts }),
  });
  return Object.freeze({
    eventId: canonicalDigest({
      domain: COMPACTION_USAGE_PROBE_EVENT_TYPE,
      timestamp,
      type: COMPACTION_USAGE_PROBE_EVENT_TYPE,
      data,
    }),
    timestamp,
    type: COMPACTION_USAGE_PROBE_EVENT_TYPE,
    data,
  });
}
function validateProbeArtifact(value: unknown): CompactionUsageProbeArtifact {
  if (
    !isRecord(value) ||
    !exactFields(value, ["data", "eventId", "timestamp", "type"]) ||
    value.type !== COMPACTION_USAGE_PROBE_EVENT_TYPE ||
    !isRecord(value.data) ||
    !exactFields(value.data, ["capture", "facts", "probeId"]) ||
    !Array.isArray(value.data.facts)
  )
    integrity("Persisted compaction probe has an invalid schema");
  const artifact = createCompactionUsageProbeArtifact(
    requireId(value.data.probeId, "probeId"),
    requireTimestamp(value.timestamp, "timestamp"),
    value.data.facts.map(validateFact),
  );
  if (
    requireDigest(value.eventId, "eventId") !== artifact.eventId ||
    canonicalJson(value) !== canonicalJson(artifact)
  )
    integrity("Persisted compaction probe failed authoritative derivation");
  return artifact;
}
function markerPath(probeId: string): string {
  requireId(probeId, "probeId");
  return `${PROBE_MARKER_DIRECTORY}/${probeId}.json`;
}
async function readMarker(
  safeRun: SafeRun,
  probeId: string,
): Promise<CompactionUsageProbeArtifact | undefined> {
  const path = markerPath(probeId);
  if (!(await safeRunFileExists(safeRun, path))) return undefined;
  const text = (await safeRunReadFile(safeRun, path)).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return integrity("Compaction probe marker is malformed");
  }
  if (canonicalJson(parsed) !== text) integrity("Compaction probe marker is not canonical");
  return validateProbeArtifact(parsed);
}
function authoritativeProbeData(artifact: CompactionUsageProbeArtifact): string {
  return canonicalJson({ facts: artifact.data.facts, capture: artifact.data.capture });
}

/**
 * Publish exactly one immutable marker for a probe across all processes.
 *
 * A caller that loses publication adopts the already-published artifact when its
 * facts (and therefore its re-derived capture) agree. Its requested timestamp is
 * intentionally not compared: the winner's immutable timestamp is authoritative.
 */
export async function persistCompactionUsageProbe(
  safeRun: SafeRun,
  artifactValue: CompactionUsageProbeArtifact,
): Promise<CompactionUsageProbeArtifact> {
  const requested = validateProbeArtifact(artifactValue);
  const published = await safeRunPublishExclusiveFile(
    safeRun,
    markerPath(requested.data.probeId),
    canonicalJson(requested),
  );
  const authoritative = published ? requested : await readMarker(safeRun, requested.data.probeId);
  if (authoritative === undefined)
    integrity("Compaction usage probe marker disappeared after exclusive publication");
  if (authoritativeProbeData(authoritative) !== authoritativeProbeData(requested))
    integrity("probeId cannot be reused with different authoritative facts");
  await verifyCompactionUsageProbe(safeRun, authoritative);
  return authoritative;
}

export async function resumeCompactionUsageProbe(
  safeRun: SafeRun,
  probeId: string,
  timestamp: string,
  facts: readonly PiLifecycleFact[],
): Promise<CompactionUsageProbeArtifact> {
  return persistCompactionUsageProbe(
    safeRun,
    createCompactionUsageProbeArtifact(probeId, timestamp, facts),
  );
}

/** Parse canonical facts, re-run reducer, and verify the immutable marker. */
export async function verifyCompactionUsageProbe(
  safeRun: SafeRun,
  artifactValue: CompactionUsageProbeArtifact,
): Promise<void> {
  const artifact = validateProbeArtifact(artifactValue);
  const marker = await readMarker(safeRun, artifact.data.probeId);
  if (marker === undefined || canonicalJson(marker) !== canonicalJson(artifact))
    integrity("Compaction usage authoritative marker is missing or changed");
}
