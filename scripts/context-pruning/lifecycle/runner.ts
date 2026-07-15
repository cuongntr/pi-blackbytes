/**
 * Evaluation-only, parameterized lifecycle matrix runner.
 *
 * Hermetic tests inject generated scenarios and process adapters. T-021 alone
 * supplies copied-session scenarios and an owner-approved real Pi executor.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { canonicalDigest, canonicalJson, sha256 } from "../canonical-json.js";
import { appendEvent } from "../evidence-store.js";
import type { SafeRun } from "../path-safety.js";
import { COMPLETE_RANGE_PROVENANCE_POLICY } from "../protocol.js";
import { EvidenceStoreError } from "../types.js";
import { createShadowContextHandler } from "./extension.js";
import { evaluateProvenance } from "./provenance.js";
import type { ContextMessage, ProvenanceEvaluation } from "./provenance.js";
import {
  CONTEXT_HOOK_LOAD_ORDERS,
  LIFECYCLE_SCENARIO_IDS,
  asContextMessages,
  createGeneratedLifecycleScenarios,
  estimateCanonicalModelVisibleTokens,
  observeScenario,
} from "./scenarios.js";
import type { ContextHookLoadOrder, LifecycleScenario } from "./scenarios.js";

export const CANONICAL_PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_074_VERSION = "0.74.0";
export const LIFECYCLE_EVIDENCE_PATH = "lifecycle.jsonl";
export const LIFECYCLE_EVENT_TYPE = "lifecycle-result-v1";

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_ENV_VALUE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

/** Trusted protocol values, separate from machine-local installation paths. */
export interface PiInstallationPin {
  readonly id: string;
  readonly version: string;
  readonly packageIntegrityDigest: string;
  readonly binaryDigest: string;
}

/** Machine-local locations. Expected identity is supplied only by PiInstallationPin. */
export interface PinnedPiInstallation {
  readonly id: string;
  readonly packageManifestPath: string;
  readonly binaryPath: string;
}

export interface LifecycleMatrixMetadata {
  readonly protocolPins: readonly [PiInstallationPin, PiInstallationPin];
  readonly installations: readonly [PinnedPiInstallation, PinnedPiInstallation];
}

export interface ValidatedPiInstallation {
  readonly id: string;
  readonly packageName: typeof CANONICAL_PI_PACKAGE;
  readonly version: string;
  readonly packageIntegrityDigest: string;
  readonly binaryDigest: string;
  /** Private execution capability; never persisted in lifecycle evidence. */
  readonly binaryPath: string;
}

export interface InstallationReader {
  readonly readFile: (path: string) => Promise<Uint8Array>;
}

export type PiVersionProbe = (binaryPath: string) => Promise<string>;

export interface LifecycleChildEnvironment {
  readonly isolationId: string;
  readonly piVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly architecture: string;
}

export interface LifecycleExecutionRequest {
  readonly installation: ValidatedPiInstallation;
  readonly scenario: LifecycleScenario;
  readonly loadOrder: ContextHookLoadOrder;
  readonly cellId: string;
}

export interface LifecycleExecutionResult {
  readonly observedMessages: readonly ContextMessage[];
  /** T-021 supplies a keyed digest of the disposable copy; generated fixtures use SHA-256. */
  readonly copyDigest: string;
  readonly childEnvironment: LifecycleChildEnvironment;
}

/** The sole seam for one fresh, disposable Pi child per matrix cell. */
export type IsolatedLifecycleExecutor = (
  request: LifecycleExecutionRequest,
) => Promise<LifecycleExecutionResult>;

export interface LifecycleResult {
  readonly matrixAttemptId: string;
  readonly installationId: string;
  readonly piVersion: string;
  readonly scenarioId: LifecycleScenario["id"];
  readonly loadOrder: ContextHookLoadOrder;
  readonly pass: boolean;
  readonly claims: ProvenanceEvaluation["evidence"];
  readonly coverage: ProvenanceEvaluation["comparison"];
  readonly sourceDigest: string;
  readonly copyDigest: string;
  readonly environmentDigest: string;
}

export interface LifecycleRunRequest extends LifecycleMatrixMetadata {
  readonly safeRun: SafeRun;
  readonly matrixAttemptId: string;
  readonly eventTimestamp: string;
  readonly executeIsolatedScenario: IsolatedLifecycleExecutor;
  readonly scenarios?: readonly LifecycleScenario[];
  readonly reader?: InstallationReader;
  readonly probeVersion?: PiVersionProbe;
}

function integrity(message: string): never {
  throw new EvidenceStoreError("E_EVAL_INTEGRITY", message);
}

function schema(message: string): never {
  throw new EvidenceStoreError("E_EVAL_SCHEMA", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  );
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function assertPinShape(pin: PiInstallationPin): void {
  if (
    !SAFE_ID.test(pin.id) ||
    !SAFE_ENV_VALUE.test(pin.version) ||
    !DIGEST.test(pin.packageIntegrityDigest) ||
    !DIGEST.test(pin.binaryDigest)
  ) {
    schema("Pinned Pi protocol metadata is incomplete or invalid");
  }
}

function assertInstallationShape(installation: PinnedPiInstallation): void {
  if (
    !SAFE_ID.test(installation.id) ||
    typeof installation.packageManifestPath !== "string" ||
    !isAbsolute(installation.packageManifestPath) ||
    typeof installation.binaryPath !== "string" ||
    !isAbsolute(installation.binaryPath)
  ) {
    schema("Pinned Pi installation paths are incomplete or invalid");
  }
}

function assertProtocolMatrix(metadata: LifecycleMatrixMetadata): void {
  if (metadata.protocolPins.length !== 2 || metadata.installations.length !== 2) {
    schema("Lifecycle matrix requires exactly two protocol pins and two installations");
  }
  for (const pin of metadata.protocolPins) assertPinShape(pin);
  for (const installation of metadata.installations) assertInstallationShape(installation);
  const pinIds = metadata.protocolPins.map((pin) => pin.id);
  const installationIds = metadata.installations.map((installation) => installation.id);
  if (new Set(pinIds).size !== 2 || new Set(installationIds).size !== 2) {
    integrity("Lifecycle matrix installation IDs must be distinct");
  }
  if ([...pinIds].sort().join("\u0000") !== [...installationIds].sort().join("\u0000")) {
    integrity("Every local Pi installation must match exactly one protocol pin");
  }
  const legacy = metadata.protocolPins.filter((pin) => pin.version === PI_074_VERSION);
  const current = metadata.protocolPins.filter((pin) => pin.version !== PI_074_VERSION);
  if (legacy.length !== 1 || current.length !== 1) {
    integrity("Lifecycle matrix requires exact Pi 0.74.0 plus one distinct pinned current version");
  }
}

function parsePin(value: unknown): PiInstallationPin {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["binaryDigest", "id", "packageIntegrityDigest", "version"])
  ) {
    schema("Pinned Pi protocol records must use the exact schema");
  }
  const pin: PiInstallationPin = {
    id: value.id as string,
    version: value.version as string,
    packageIntegrityDigest: value.packageIntegrityDigest as string,
    binaryDigest: value.binaryDigest as string,
  };
  assertPinShape(pin);
  return Object.freeze(pin);
}

function parseInstallation(value: unknown): PinnedPiInstallation {
  if (!isRecord(value) || !hasExactFields(value, ["binaryPath", "id", "packageManifestPath"])) {
    schema("Pinned Pi installation records must use the exact schema");
  }
  const installation: PinnedPiInstallation = {
    id: value.id as string,
    packageManifestPath: value.packageManifestPath as string,
    binaryPath: value.binaryPath as string,
  };
  assertInstallationShape(installation);
  return Object.freeze(installation);
}

/** Parse opt-in metadata while keeping trusted pins distinct from local paths. */
export function parseLifecycleMatrixMetadata(value: unknown): LifecycleMatrixMetadata {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["installations", "protocolPins"]) ||
    !Array.isArray(value.protocolPins) ||
    !Array.isArray(value.installations) ||
    value.protocolPins.length !== 2 ||
    value.installations.length !== 2
  ) {
    schema("Lifecycle metadata must contain exactly protocolPins and installations pairs");
  }
  const metadata: LifecycleMatrixMetadata = {
    protocolPins: [parsePin(value.protocolPins[0]), parsePin(value.protocolPins[1])],
    installations: [
      parseInstallation(value.installations[0]),
      parseInstallation(value.installations[1]),
    ],
  };
  assertProtocolMatrix(metadata);
  return deepFreeze(metadata);
}

/** Opt-in helper. It is never called by standard hermetic tests. */
export function probePiBinaryVersion(binaryPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      ["--version"],
      { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          reject(new EvidenceStoreError("E_EVAL_INTEGRITY", "Pinned Pi version probe failed"));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** Validate package bytes, canonical identity, binary bytes, and executed version. */
export async function validatePinnedPiInstallation(
  installation: PinnedPiInstallation,
  pin: PiInstallationPin,
  reader: InstallationReader = { readFile },
  probeVersion: PiVersionProbe = probePiBinaryVersion,
): Promise<ValidatedPiInstallation> {
  assertInstallationShape(installation);
  assertPinShape(pin);
  if (installation.id !== pin.id) integrity("Pi installation does not match its protocol pin");
  let packageBytes: Uint8Array;
  let binaryBytes: Uint8Array;
  try {
    [packageBytes, binaryBytes] = await Promise.all([
      reader.readFile(installation.packageManifestPath),
      reader.readFile(installation.binaryPath),
    ]);
  } catch {
    integrity("Pinned Pi package metadata or binary cannot be read");
  }
  if (
    sha256Bytes(packageBytes!) !== pin.packageIntegrityDigest ||
    sha256Bytes(binaryBytes!) !== pin.binaryDigest
  ) {
    integrity("Pinned Pi package or binary digest does not match the protocol pin");
  }
  let packageManifest: unknown;
  try {
    packageManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageBytes!));
  } catch {
    integrity("Pinned Pi package manifest is not valid UTF-8 JSON");
  }
  if (
    !isRecord(packageManifest) ||
    packageManifest.name !== CANONICAL_PI_PACKAGE ||
    packageManifest.version !== pin.version
  ) {
    integrity("Pinned Pi package identity or version does not match the protocol pin");
  }
  let reportedVersion: string;
  try {
    reportedVersion = (await probeVersion(installation.binaryPath)).trim();
  } catch {
    integrity("Pinned Pi binary version cannot be probed");
  }
  if (reportedVersion! !== pin.version) {
    integrity("Pinned Pi binary reported a version different from the protocol pin");
  }
  return Object.freeze({
    id: installation.id,
    packageName: CANONICAL_PI_PACKAGE,
    version: pin.version,
    packageIntegrityDigest: pin.packageIntegrityDigest,
    binaryDigest: pin.binaryDigest,
    binaryPath: installation.binaryPath,
  });
}

function validateAttempt(matrixAttemptId: string, eventTimestamp: string): void {
  if (!SAFE_ID.test(matrixAttemptId)) schema("Lifecycle matrixAttemptId is invalid");
  const parsed = new Date(eventTimestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== eventTimestamp) {
    schema("Lifecycle eventTimestamp must be an exact ISO-8601 instant");
  }
}

function scenarioContractDigest(scenario: LifecycleScenario): string {
  return canonicalDigest({ domain: "lifecycle-scenario-contract-v1", scenario });
}

function validateScenarioSet(scenarios: readonly LifecycleScenario[]): void {
  const ids = scenarios.map((scenario) => scenario.id);
  if (
    ids.length !== LIFECYCLE_SCENARIO_IDS.length ||
    new Set(ids).size !== ids.length ||
    [...ids].sort().join("\u0000") !== [...LIFECYCLE_SCENARIO_IDS].sort().join("\u0000")
  ) {
    schema("Lifecycle runner requires every declared scenario exactly once");
  }
  for (const scenario of scenarios) {
    if (!DIGEST.test(scenario.sourceDigest) || scenario.candidates.length === 0) {
      schema("Lifecycle scenario has no valid source digest or candidate range");
    }
    const sourceIds = scenario.sourceProjections.map((item) => item.sourceEntryId);
    const qualifying = scenario.candidates.filter((candidate) => {
      const start = sourceIds.indexOf(candidate.startEntryId);
      const end = sourceIds.indexOf(candidate.endEntryId);
      if (start < 0 || end < start) return false;
      const calculated = estimateCanonicalModelVisibleTokens(
        canonicalJson(scenario.sourceProjections.slice(start, end + 1).map((item) => item.message)),
      );
      return (
        candidate.estimatedTokens === calculated &&
        calculated >= COMPLETE_RANGE_PROVENANCE_POLICY.qualificationEstimatedTokenMinimum
      );
    });
    if (
      qualifying.length === 0 ||
      !qualifying.some(
        (candidate) => candidate.estimatedTokens === scenario.qualificationEstimatedTokens,
      )
    ) {
      integrity("Lifecycle scenario does not contain a correctly estimated qualifying range");
    }
    scenarioContractDigest(scenario);
  }
}

function validateChildEnvironment(
  child: LifecycleChildEnvironment,
  installation: ValidatedPiInstallation,
  seenIsolationIds: Set<string>,
): void {
  if (
    !SAFE_ID.test(child.isolationId) ||
    !SAFE_ENV_VALUE.test(child.piVersion) ||
    !SAFE_ENV_VALUE.test(child.nodeVersion) ||
    !SAFE_ENV_VALUE.test(child.platform) ||
    !SAFE_ENV_VALUE.test(child.architecture)
  ) {
    integrity("Lifecycle child returned incomplete environment metadata");
  }
  if (child.piVersion !== installation.version) {
    integrity("Lifecycle child Pi version differs from the validated installation");
  }
  if (seenIsolationIds.has(child.isolationId)) {
    integrity("Lifecycle executor reused an isolation identity across matrix cells");
  }
  seenIsolationIds.add(child.isolationId);
}

/** Derive a content-free identity from child-reported environment and trusted pins. */
export function lifecycleEnvironmentDigest(
  installation: ValidatedPiInstallation,
  child: LifecycleChildEnvironment,
): string {
  return canonicalDigest({
    architecture: child.architecture,
    binaryDigest: installation.binaryDigest,
    installationId: installation.id,
    nodeVersion: child.nodeVersion,
    packageIntegrityDigest: installation.packageIntegrityDigest,
    packageName: installation.packageName,
    piVersion: child.piVersion,
    platform: child.platform,
  });
}

function resultEvent(result: LifecycleResult, eventTimestamp: string, cellId: string) {
  return {
    eventId: canonicalDigest({
      cellId,
      matrixAttemptId: result.matrixAttemptId,
      type: LIFECYCLE_EVENT_TYPE,
    }),
    timestamp: eventTimestamp,
    type: LIFECYCLE_EVENT_TYPE,
    data: {
      claims: result.claims,
      copyDigest: result.copyDigest,
      coverage: result.coverage,
      environmentDigest: result.environmentDigest,
      installationId: result.installationId,
      loadOrder: result.loadOrder,
      matrixAttemptId: result.matrixAttemptId,
      pass: result.pass,
      piVersion: result.piVersion,
      scenarioId: result.scenarioId,
      sourceDigest: result.sourceDigest,
    },
  };
}

/** Run the complete parameterized matrix and persist only content-free evidence. */
export async function runLifecycleMatrix(
  request: LifecycleRunRequest,
): Promise<readonly LifecycleResult[]> {
  validateAttempt(request.matrixAttemptId, request.eventTimestamp);
  assertProtocolMatrix(request);
  const reader = request.reader ?? { readFile };
  const probeVersion = request.probeVersion ?? probePiBinaryVersion;
  const pinById = new Map(request.protocolPins.map((pin) => [pin.id, pin]));
  // Validate both installations, including executing --version, before any scenario executor runs.
  const installations = await Promise.all(
    request.installations.map((installation) =>
      validatePinnedPiInstallation(
        installation,
        pinById.get(installation.id)!,
        reader,
        probeVersion,
      ),
    ),
  );
  const scenarios = request.scenarios ?? createGeneratedLifecycleScenarios();
  validateScenarioSet(scenarios);

  const results: LifecycleResult[] = [];
  const seenIsolationIds = new Set<string>();
  for (const installation of installations) {
    for (const scenario of scenarios) {
      const originalContractDigest = scenarioContractDigest(scenario);
      for (const loadOrder of CONTEXT_HOOK_LOAD_ORDERS) {
        const cellId = canonicalDigest({
          installationId: installation.id,
          loadOrder,
          matrixAttemptId: request.matrixAttemptId,
          scenarioId: scenario.id,
        });
        const executorScenario = deepFreeze(structuredClone(scenario));
        const execution = await request.executeIsolatedScenario({
          installation,
          scenario: executorScenario,
          loadOrder,
          cellId,
        });
        if (
          scenarioContractDigest(scenario) !== originalContractDigest ||
          scenarioContractDigest(executorScenario) !== originalContractDigest
        ) {
          integrity("Lifecycle scenario contract changed during isolated execution");
        }
        if (!DIGEST.test(execution.copyDigest) || !Array.isArray(execution.observedMessages)) {
          integrity("Lifecycle child returned invalid copy evidence");
        }
        validateChildEnvironment(execution.childEnvironment, installation, seenIsolationIds);
        const observation = observeScenario(scenario, loadOrder);
        const copiedMessages = structuredClone(execution.observedMessages);

        let sunk: ProvenanceEvaluation | undefined;
        const handler = createShadowContextHandler(
          (messages) =>
            evaluateProvenance({
              sourceProjections: scenario.sourceProjections,
              observedMessages: messages,
              candidates: scenario.candidates,
              groundTruth: observation.groundTruth,
            }),
          (evaluation) => {
            sunk = evaluation;
          },
        );
        const context = asContextMessages(copiedMessages);
        const returned = handler({ type: "context", messages: context });
        if (returned.messages !== context || sunk === undefined) {
          integrity("Shadow lifecycle handler changed context or did not emit provenance");
        }
        const evaluation = sunk;
        const result = deepFreeze({
          matrixAttemptId: request.matrixAttemptId,
          installationId: installation.id,
          piVersion: installation.version,
          scenarioId: scenario.id,
          loadOrder,
          pass: evaluation.comparison.pass,
          claims: evaluation.evidence,
          coverage: evaluation.comparison,
          sourceDigest: scenario.sourceDigest,
          copyDigest: execution.copyDigest,
          environmentDigest: lifecycleEnvironmentDigest(installation, execution.childEnvironment),
        });
        await appendEvent(
          request.safeRun,
          LIFECYCLE_EVIDENCE_PATH,
          resultEvent(result, request.eventTimestamp, cellId),
        );
        results.push(result);
      }
    }
  }
  return Object.freeze(results);
}

/** Generated-only executor used by hermetic tests; it never starts a process. */
export async function executeGeneratedScenario(
  request: LifecycleExecutionRequest,
): Promise<LifecycleExecutionResult> {
  const observedMessages = observeScenario(request.scenario, request.loadOrder).observedMessages;
  return {
    observedMessages,
    copyDigest: sha256(canonicalJson(observedMessages)),
    childEnvironment: {
      isolationId: `cell-${request.cellId.slice(0, 32)}`,
      piVersion: request.installation.version,
      nodeVersion: "v24.0.0",
      platform: "generated",
      architecture: "generated",
    },
  };
}

/** Explicit T-021 handoff: real process wiring is deliberately not implemented in T-010B. */
export function requireT021RealMatrixExecutor(): never {
  throw new EvidenceStoreError(
    "E_EVAL_INCOMPLETE",
    "T-021 must supply the owner-pinned real Pi subprocess executor after metadata validation",
  );
}

export const REQUIRED_LIFECYCLE_SCENARIOS = LIFECYCLE_SCENARIO_IDS;
