#!/usr/bin/env node
/**
 * CLI dispatcher for the context-pruning evaluation toolchain.
 *
 * Usage: bun run evidence:context-pruning -- <command> [options]
 *
 * T-001 implements only the dispatcher skeleton. All commands are stubs that
 * return a structured `E_EVAL_INCOMPLETE` error. Unknown commands return
 * `E_EVAL_CONFIG`. `--help` exits 0.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { selectAnnotatedCandidate, validateCandidateSelectionInput } from "./annotations.js";
import { canonicalJson } from "./canonical-json.js";
import { executeCleanup, persistCleanupManifest, planCleanup } from "./cleanup.js";
import { CORPUS_KEY_FILENAME } from "./evidence-store.js";
import { buildRedactedReport } from "./export-redacted.js";
import {
  runFormalCommand,
  verifyFrozenT017SampleAndTarget,
  verifyT017HardStopDisposition,
} from "./formal-run.js";
import {
  parseLifecycleMatrixMetadata,
  requireT021RealMatrixExecutor,
  runLifecycleMatrix,
} from "./lifecycle/runner.js";
import { openSafeRun, safeRunReadFile, safeRunWriteFile } from "./path-safety.js";
import { validateTargetSelectionRecord } from "./protocol.js";
import {
  createGeneratedCompactionProofPlan,
  createProviderReplayConfirmation,
  declineGeneratedCompactionProof,
  loadT009BPrivateInputs,
  prepareProviderReplayExecution,
  recordGeneratedCompactionNotApplicable,
  runGeneratedCompactionProof,
  runProviderReplay,
  validateProviderPolicy,
  verifyPersistedGeneratedCompactionProof,
} from "./provider-runner.js";
import type { GeneratedCompactionProofAdapter, ProviderReplayAdapter } from "./provider-runner.js";
import { buildReplayPlan, replayPlanSummary, validateReplayPlanInput } from "./replay.js";
import {
  freezeSnapshot,
  openReplaySnapshotAccess,
  persistFrozenSnapshot,
  validateFreezeSnapshotInput,
} from "./snapshots.js";
import { EvidenceStoreError } from "./types.js";
import type { CliCommand, EvalErrorCode, EvidenceError } from "./types.js";
import { CLI_COMMANDS } from "./types.js";

// ── Help text ───────────────────────────────────────────────────────────────

const HELP_TEXT = `Usage: bun run evidence:context-pruning -- <command> [options]

Commands:
  init              Create sampling lock and private run root
  inventory         Content-free local inventory and aggregate summary
  sample            Immutable first-40 sample manifest
  select-target     Immutable target-selection record
  qualify           Qualification records and unresolved disagreements
  adjudicate        Resolved qualification records
  freeze            Evaluation lock and artifact digests
  replay            Append-only run and usage events (external cost)
  score             Score/cost records and uncertainty evidence
  lifecycle         Lifecycle and benchmark results
  decide            One mechanical decision plus threshold trace
  report            Local detailed report plus committed-safe aggregate
  verify            Hash, schema, source-integrity and decision checks
  cleanup           Deletes only manifest-listed local artifacts

Options:
  --help            Show this help message and exit
  --input <path>    Content-free stage input JSON
  --run-id <id>     Private evidence run identifier
  --pi-agent-dir <path>  Pi agent directory containing the private run
  --corpus-id <id>   Frozen snapshot corpus identifier (replay)
  --dry-run         Strict T-012A provider-free plan mode (no external cost)
  --plan-provider   Provider confirmation planning only (no provider call)
  --confirm <hash>  Exact provider confirmation digest/token
  --adapter-module <path>  Explicit local adapter module for --opt-in execution
  --decline <hash>  Decline a plan
  --not-applicable <hash>  Record a verified upstream hard-stop
  --opt-in                 Required for lifecycle matrix handoff; provider replay remains adapter-only
  --metadata <path>        Separate protocol pins and local Pi installation paths
  --attempt-id <id>        Stable lifecycle matrix attempt identity
  --event-timestamp <iso>  Stable ISO-8601 timestamp for resume-safe events
`;

// ── Error emission ──────────────────────────────────────────────────────────

/**
 * Emit a structured evaluation error as JSON to stderr and exit.
 *
 * @param code - Error code.
 * @param message - Human-readable error description.
 * @param recordId - Optional record identifier.
 * @param exitCode - Process exit code (default 1).
 */
function emitError(code: EvalErrorCode, message: string, recordId?: string, exitCode = 1): never {
  const error: EvidenceError =
    recordId === undefined ? { code, message } : { code, message, recordId };
  process.stderr.write(`${JSON.stringify(error)}\n`);
  process.exit(exitCode);
}

// ── Main ────────────────────────────────────────────────────────────────────

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function runCandidateSelectionCommand(
  args: readonly string[],
  mode: "qualify" | "adjudicate",
): Promise<void> {
  const inputPath = optionValue(args, "--input");
  if (inputPath === undefined) {
    emitError("E_EVAL_CONFIG", `Command '${mode}' requires --input <path>.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    emitError("E_EVAL_SCHEMA", `Command '${mode}' input cannot be read or parsed.`);
  }
  try {
    const input = validateCandidateSelectionInput(value);
    const hasAdjudication = input.adjudication !== undefined;
    if (mode === "qualify" && hasAdjudication) {
      emitError("E_EVAL_CONFIG", "qualify input must not include adjudication data.");
    }
    if (mode === "adjudicate" && !hasAdjudication) {
      emitError("E_EVAL_CONFIG", "adjudicate input requires an adjudication record.");
    }
    const result = selectAnnotatedCandidate(
      input.candidates,
      input.annotations,
      input.adjudication,
    );
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) {
      emitError(error.code, error.message, error.recordId);
    }
    emitError("E_EVAL_INTEGRITY", `Command '${mode}' failed before producing a result.`);
  }
}

async function runFreezeCommand(args: readonly string[]): Promise<void> {
  const inputPath = optionValue(args, "--input");
  const runId = optionValue(args, "--run-id");
  const piAgentDir = optionValue(args, "--pi-agent-dir");
  if (inputPath === undefined || runId === undefined || piAgentDir === undefined) {
    emitError("E_EVAL_CONFIG", "freeze requires --input, --run-id, and --pi-agent-dir.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    emitError("E_EVAL_SCHEMA", "freeze input cannot be read or parsed.");
  }
  try {
    const safeRun = await openSafeRun(piAgentDir, runId);
    const bundle = await freezeSnapshot(safeRun, validateFreezeSnapshotInput(value));
    await persistFrozenSnapshot(safeRun, bundle);
    process.stdout.write(
      `${canonicalJson({
        snapshotId: bundle.snapshot.snapshotId,
        snapshotDigest: bundle.snapshot.snapshotDigest,
        goldLedgerDigest: bundle.goldLedger.ledgerDigest,
      })}\n`,
    );
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) {
      emitError(error.code, error.message, error.recordId);
    }
    emitError("E_EVAL_INTEGRITY", "freeze failed before immutable evidence was written.");
  }
}

function parseStrictReplayArguments(args: readonly string[]): {
  readonly inputPath: string;
  readonly runId: string;
  readonly piAgentDir: string;
  readonly corpusId: string;
} {
  const valued = new Set(["--input", "--run-id", "--pi-agent-dir", "--corpus-id"]);
  const values = new Map<string, string>();
  let dryRunCount = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      dryRunCount += 1;
      continue;
    }
    if (!valued.has(argument) || values.has(argument)) {
      emitError(
        "E_EVAL_CONFIG",
        "replay accepts only one each of --dry-run, --input, --run-id, --pi-agent-dir, and --corpus-id.",
      );
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      emitError("E_EVAL_CONFIG", `replay requires a value for ${argument}.`);
    }
    values.set(argument, value);
    index += 1;
  }
  if (dryRunCount !== 1 || values.size !== valued.size) {
    emitError(
      "E_EVAL_CONFIG",
      "replay requires exactly --dry-run --input <path> --run-id <id> --pi-agent-dir <path> --corpus-id <digest>.",
    );
  }
  const corpusId = values.get("--corpus-id")!;
  if (!/^[0-9a-f]{64}$/.test(corpusId)) {
    emitError("E_EVAL_CONFIG", "replay --corpus-id must be a lowercase SHA-256 digest.");
  }
  return {
    inputPath: values.get("--input")!,
    runId: values.get("--run-id")!,
    piAgentDir: values.get("--pi-agent-dir")!,
    corpusId,
  };
}

function providerReplayOptions(args: readonly string[]): {
  readonly inputPath: string;
  readonly runId: string;
  readonly piAgentDir: string;
  readonly corpusId: string;
  readonly confirmation?: string;
  readonly adapterModule?: string;
} {
  const valued = new Set([
    "--input",
    "--run-id",
    "--pi-agent-dir",
    "--corpus-id",
    "--confirm",
    "--adapter-module",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--plan-provider" || option === "--opt-in") continue;
    if (!valued.has(option) || values.has(option))
      emitError("E_EVAL_CONFIG", "provider replay options are duplicated or unsupported.");
    const value = args[++index];
    if (value === undefined || value.startsWith("--"))
      emitError("E_EVAL_CONFIG", `replay requires a value for ${option}.`);
    values.set(option, value);
  }
  for (const required of ["--input", "--run-id", "--pi-agent-dir", "--corpus-id"])
    if (!values.has(required)) emitError("E_EVAL_CONFIG", `provider replay requires ${required}.`);
  const corpusId = values.get("--corpus-id")!;
  if (!/^[0-9a-f]{64}$/.test(corpusId))
    emitError("E_EVAL_CONFIG", "replay --corpus-id must be a lowercase SHA-256 digest.");
  return {
    inputPath: values.get("--input")!,
    runId: values.get("--run-id")!,
    piAgentDir: values.get("--pi-agent-dir")!,
    corpusId,
    confirmation: values.get("--confirm"),
    adapterModule: values.get("--adapter-module"),
  };
}

async function loadExplicitLocalAdapter(modulePath: string): Promise<ProviderReplayAdapter> {
  // There is deliberately no configured/default adapter and no package lookup seam.
  const resolved = resolve(modulePath);
  const loaded = (await import(pathToFileURL(resolved).href)) as {
    providerReplayAdapter?: unknown;
  };
  const adapter = loaded.providerReplayAdapter;
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    typeof (adapter as { execute?: unknown }).execute !== "function"
  )
    throw new EvidenceStoreError(
      "E_EVAL_CONFIG",
      "adapter module must export providerReplayAdapter.",
    );
  return adapter as ProviderReplayAdapter;
}

async function runReplayCommand(args: readonly string[]): Promise<void> {
  const providerPlanning = args.includes("--plan-provider");
  const providerExecution = args.includes("--opt-in");
  if (providerPlanning && providerExecution)
    emitError("E_EVAL_CONFIG", "choose either --plan-provider or --opt-in, not both.");
  if (!providerPlanning && !providerExecution) {
    const { inputPath, runId, piAgentDir, corpusId } = parseStrictReplayArguments(args);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(inputPath, "utf8"));
    } catch {
      emitError("E_EVAL_SCHEMA", "replay input cannot be read or parsed.");
    }
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.hasOwn(value, "selection") ||
      !Object.hasOwn(value, "replay") ||
      Object.keys(value).length !== 2
    )
      emitError("E_EVAL_SCHEMA", "replay input must contain exactly selection and replay.");
    try {
      validateReplayPlanInput((value as { readonly replay: unknown }).replay);
      const safeRun = await openSafeRun(piAgentDir, runId);
      const access = await openReplaySnapshotAccess(safeRun, corpusId);
      const plan = await buildReplayPlan(
        access,
        (value as { readonly selection: unknown }).selection,
        (value as { readonly replay: unknown }).replay,
      );
      process.stdout.write(`${canonicalJson(replayPlanSummary(plan))}\n`);
    } catch (error: unknown) {
      if (error instanceof EvidenceStoreError) emitError(error.code, error.message, error.recordId);
      emitError("E_EVAL_INTEGRITY", "replay failed before a provider-free plan could be produced.");
    }
    return;
  }
  // All confirmation and frozen-input validation happens before an adapter module is imported.
  const options = providerReplayOptions(args);
  if (
    providerExecution &&
    (options.confirmation === undefined || options.adapterModule === undefined)
  )
    emitError(
      "E_EVAL_CONFIG",
      "--opt-in requires --confirm <digest> and --adapter-module <local-path>.",
    );
  let value: unknown;
  try {
    value = JSON.parse(await readFile(options.inputPath, "utf8"));
  } catch {
    emitError("E_EVAL_SCHEMA", "provider replay input cannot be read or parsed.");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "selection") ||
    !Object.hasOwn(value, "replay") ||
    !Object.hasOwn(value, "targetSelection") ||
    !Object.hasOwn(value, "providerPolicy")
  )
    emitError(
      "E_EVAL_SCHEMA",
      "provider replay input requires selection, replay, targetSelection, and providerPolicy.",
    );
  const parsed = value as {
    readonly selection: unknown;
    readonly replay: unknown;
    readonly targetSelection: unknown;
    readonly providerPolicy: unknown;
    readonly compactionAccountingResolution?: unknown;
  };
  try {
    validateReplayPlanInput(parsed.replay);
    const target = validateTargetSelectionRecord(parsed.targetSelection);
    const policy = validateProviderPolicy(parsed.providerPolicy as never);
    const safeRun = await openSafeRun(options.piAgentDir, options.runId);
    const access = await openReplaySnapshotAccess(safeRun, options.corpusId);
    const plan = await buildReplayPlan(access, parsed.selection, parsed.replay);
    const confirmation = createProviderReplayConfirmation(plan, target, policy);
    if (providerPlanning) {
      process.stdout.write(`${canonicalJson(confirmation)}\n`);
      return;
    }
    if (options.confirmation !== confirmation.confirmationDigest)
      emitError("E_EVAL_INTEGRITY", "--confirm does not match the provider confirmation plan.");
    if (parsed.compactionAccountingResolution === undefined)
      emitError(
        "E_EVAL_INCOMPLETE",
        "ordinary provider replay requires a persisted compactionAccountingResolution.",
      );
    // The caller may name a resolution only after it exactly equals the
    // authenticated fixed-private-input proof for this environment.
    const privateInputs = await loadT009BPrivateInputs(safeRun, target);
    const persistedResolution = await verifyPersistedGeneratedCompactionProof({
      ...privateInputs,
      safeRun,
    });
    if (canonicalJson(parsed.compactionAccountingResolution) !== canonicalJson(persistedResolution))
      emitError(
        "E_EVAL_INTEGRITY",
        "ordinary replay resolution is not the authenticated persisted T-009B resolution.",
      );
    const preflight = {
      safeRun,
      replayAccess: access,
      selection: parsed.selection,
      replayInput: parsed.replay,
      plan,
      targetSelection: target,
      providerPolicy: policy,
      confirmation: options.confirmation,
      gate: {
        frozenPlanDigest: plan.planDigest,
        resolution: parsed.compactionAccountingResolution as never,
      },
    };
    // This complete gate runs before importing caller-controlled module code.
    await prepareProviderReplayExecution(preflight);
    const adapter = await loadExplicitLocalAdapter(options.adapterModule!);
    const result = await runProviderReplay({
      ...preflight,
      adapter,
      now: () => new Date().toISOString(),
    });
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) emitError(error.code, error.message, error.recordId);
    emitError(
      "E_EVAL_INTEGRITY",
      "provider replay failed before a provider result could be produced.",
    );
  }
}

async function loadExplicitGeneratedCompactionProofAdapter(
  modulePath: string,
): Promise<GeneratedCompactionProofAdapter> {
  // Confirm preflight has already completed before this caller-controlled import.
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    GeneratedCompactionProofAdapter?: unknown;
  };
  const adapter = loaded.GeneratedCompactionProofAdapter;
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    (adapter as { kind?: unknown }).kind !== "external" ||
    typeof (adapter as { execute?: unknown }).execute !== "function"
  )
    throw new EvidenceStoreError(
      "E_EVAL_CONFIG",
      "adapter module must export an external GeneratedCompactionProofAdapter.",
    );
  return adapter as GeneratedCompactionProofAdapter;
}

function t009bLifecycleOptions(args: readonly string[]):
  | {
      readonly runId: string;
      readonly piAgentDir: string;
      readonly mode: "dry-run" | "decline" | "confirm" | "not-applicable";
      readonly digest?: string;
      readonly adapterModule?: string;
    }
  | undefined {
  if (optionValue(args, "--scenario") !== "compaction-accounting") return undefined;
  const valued = new Set([
    "--run-id",
    "--scenario",
    "--pi-agent-dir",
    "--decline",
    "--confirm",
    "--not-applicable",
    "--adapter-module",
  ]);
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--dry-run") {
      if (dryRun)
        emitError("E_EVAL_CONFIG", "T-009B lifecycle options are duplicated or unsupported.");
      dryRun = true;
      continue;
    }
    if (!valued.has(option) || values.has(option))
      emitError("E_EVAL_CONFIG", "T-009B lifecycle options are duplicated or unsupported.");
    const value = args[++index];
    if (value === undefined || value.startsWith("--"))
      emitError("E_EVAL_CONFIG", `lifecycle requires a value for ${option}.`);
    values.set(option, value);
  }
  if (!values.has("--run-id")) emitError("E_EVAL_CONFIG", "T-009B lifecycle requires --run-id.");
  const decline = values.get("--decline");
  const confirm = values.get("--confirm");
  const notApplicable = values.get("--not-applicable");
  if (
    (dryRun ? 1 : 0) +
      (decline === undefined ? 0 : 1) +
      (confirm === undefined ? 0 : 1) +
      (notApplicable === undefined ? 0 : 1) !==
    1
  )
    emitError(
      "E_EVAL_CONFIG",
      "T-009B lifecycle requires exactly one of --dry-run, --decline, --confirm, or --not-applicable.",
    );
  if (values.has("--adapter-module") !== (confirm !== undefined))
    emitError("E_EVAL_CONFIG", "T-009B --adapter-module is required only for --confirm.");
  return {
    runId: values.get("--run-id")!,
    piAgentDir:
      values.get("--pi-agent-dir") ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    mode: dryRun
      ? "dry-run"
      : decline !== undefined
        ? "decline"
        : confirm !== undefined
          ? "confirm"
          : "not-applicable",
    digest: decline ?? confirm ?? notApplicable,
    adapterModule: values.get("--adapter-module"),
  };
}

async function runT009BLifecycleCommand(
  options: NonNullable<ReturnType<typeof t009bLifecycleOptions>>,
): Promise<void> {
  const safeRun = await openSafeRun(options.piAgentDir, options.runId);
  if (options.mode === "not-applicable") {
    await verifyT017HardStopDisposition(safeRun, options.digest!);
    const disposition = await recordGeneratedCompactionNotApplicable({
      safeRun,
      upstreamHardStopDigest: options.digest!,
    });
    process.stdout.write(
      `${canonicalJson({ compactionAccounting: "not-applicable", dispositionDigest: disposition.dispositionDigest })}\n`,
    );
    return;
  }
  // Full source/sample/copy/target verification gates planning and execution.
  const targetSelection = await verifyFrozenT017SampleAndTarget(safeRun);
  const prepared = await loadT009BPrivateInputs(safeRun, targetSelection);
  const plan = createGeneratedCompactionProofPlan(
    prepared.targetSelection,
    prepared.providerPolicy,
    prepared.proofPolicy,
    prepared.environment,
  );
  if (options.mode === "dry-run") {
    process.stdout.write(`${canonicalJson(plan)}\n`);
    return;
  }
  if (options.digest !== plan.planDigest)
    emitError("E_EVAL_INTEGRITY", "T-009B digest does not match the exact generated proof plan.");
  if (options.mode === "decline") {
    await declineGeneratedCompactionProof({ ...prepared, safeRun, planDigest: options.digest });
    process.stdout.write(
      `${canonicalJson({ compactionAccounting: "blocking-incomplete", planDigest: plan.planDigest })}\n`,
    );
    return;
  }
  // Revalidate after confirmation and immediately before caller-controlled import.
  await verifyFrozenT017SampleAndTarget(safeRun);
  // Dynamic module loading is deliberately last: all immutable inputs and exact confirmation match.
  const adapter = await loadExplicitGeneratedCompactionProofAdapter(options.adapterModule!);
  const result = await runGeneratedCompactionProof({
    safeRun,
    targetSelection: prepared.targetSelection,
    providerPolicy: prepared.providerPolicy,
    proofPolicy: prepared.proofPolicy,
    environmentDigest: prepared.environmentDigest,
    confirmation: plan.planDigest,
    adapter,
    now: () => new Date().toISOString(),
  });
  process.stdout.write(`${canonicalJson(result)}\n`);
}

async function runLifecycleCommand(args: readonly string[]): Promise<void> {
  const t009b = t009bLifecycleOptions(args);
  if (t009b !== undefined) {
    try {
      await runT009BLifecycleCommand(t009b);
      return;
    } catch (error: unknown) {
      if (error instanceof EvidenceStoreError) emitError(error.code, error.message, error.recordId);
      emitError(
        "E_EVAL_INTEGRITY",
        "T-009B lifecycle failed before a provider result could be produced.",
      );
    }
  }
  if (!args.includes("--opt-in")) {
    return emitError(
      "E_EVAL_INCOMPLETE",
      "lifecycle matrix is opt-in and reserved for T-021; pass --opt-in with pinned metadata.",
    );
  }
  const metadataPath = optionValue(args, "--metadata");
  const runId = optionValue(args, "--run-id");
  const piAgentDir = optionValue(args, "--pi-agent-dir");
  const matrixAttemptId = optionValue(args, "--attempt-id");
  const eventTimestamp = optionValue(args, "--event-timestamp");
  if (
    metadataPath === undefined ||
    runId === undefined ||
    piAgentDir === undefined ||
    matrixAttemptId === undefined ||
    eventTimestamp === undefined
  ) {
    return emitError(
      "E_EVAL_CONFIG",
      "Lifecycle --opt-in requires --metadata, --run-id, --pi-agent-dir, --attempt-id, and --event-timestamp.",
    );
  }

  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    return emitError("E_EVAL_INTEGRITY", "Pinned lifecycle metadata cannot be read or parsed.");
  }
  try {
    const metadata = parseLifecycleMatrixMetadata(metadataValue);
    const safeRun = await openSafeRun(piAgentDir, runId);
    await runLifecycleMatrix({
      ...metadata,
      safeRun,
      matrixAttemptId,
      eventTimestamp,
      executeIsolatedScenario: async () => requireT021RealMatrixExecutor(),
    });
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) {
      return emitError(error.code, error.message, error.recordId);
    }
    return emitError(
      "E_EVAL_INTEGRITY",
      "Lifecycle matrix failed before evidence could be written.",
    );
  }
  return emitError("E_EVAL_INCOMPLETE", "T-021 real lifecycle executor did not stop as expected.");
}

function parseRunArguments(
  args: readonly string[],
  command: "report" | "verify" | "cleanup",
  requireInput: boolean,
): { readonly inputPath?: string; readonly runId: string; readonly piAgentDir: string } {
  const inputPath = optionValue(args, "--input");
  const runId = optionValue(args, "--run-id");
  const piAgentDir = optionValue(args, "--pi-agent-dir");
  if (
    runId === undefined ||
    piAgentDir === undefined ||
    (requireInput && inputPath === undefined)
  ) {
    emitError(
      "E_EVAL_CONFIG",
      `${command} requires --run-id, --pi-agent-dir${requireInput ? ", and --input" : ""}.`,
    );
  }
  return { inputPath, runId, piAgentDir };
}

async function readReportInput(inputPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    emitError("E_EVAL_SCHEMA", "report input cannot be read or parsed.");
  }
}

async function loadReportKey(piAgentDir: string, runId: string) {
  const safeRun = await openSafeRun(piAgentDir, runId);
  const corpusKey = (await safeRunReadFile(safeRun, CORPUS_KEY_FILENAME)).toString("utf8");
  return { safeRun, corpusKey };
}

async function runReportCommand(args: readonly string[]): Promise<void> {
  const { inputPath, runId, piAgentDir } = parseRunArguments(args, "report", true);
  try {
    const { safeRun, corpusKey } = await loadReportKey(piAgentDir, runId);
    const report = await buildRedactedReport(await readReportInput(inputPath!), corpusKey);
    await safeRunWriteFile(safeRun, "report.local.json", canonicalJson(report.local));
    process.stdout.write(`${canonicalJson(report.candidate)}\n`);
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) emitError(error.code, error.message, error.recordId);
    emitError("E_EVAL_INTEGRITY", "report failed before a redacted candidate was produced.");
  }
}

async function runVerifyCommand(args: readonly string[]): Promise<void> {
  // T-015's report-input verifier remains deliberately separate from the formal
  // T-017 terminal verifier, selected solely by the presence of --input.
  if (!args.includes("--input")) {
    try {
      process.stdout.write(`${canonicalJson(await runFormalCommand("verify", args))}\n`);
      return;
    } catch (error: unknown) {
      if (error instanceof EvidenceStoreError)
        emitError(error.code, "Formal verify failed.", error.recordId);
      emitError("E_EVAL_INTEGRITY", "Formal verify failed.");
    }
  }
  const { inputPath, runId, piAgentDir } = parseRunArguments(args, "verify", true);
  try {
    const { corpusKey } = await loadReportKey(piAgentDir, runId);
    await buildRedactedReport(await readReportInput(inputPath!), corpusKey);
    process.stdout.write(`${canonicalJson({ status: "verified" })}\n`);
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) emitError(error.code, error.message, error.recordId);
    emitError("E_EVAL_INTEGRITY", "verify failed before calculation.");
  }
}

async function runFormalStageCommand(
  command: "init" | "inventory" | "sample" | "select-target",
  args: readonly string[],
): Promise<void> {
  try {
    process.stdout.write(`${canonicalJson(await runFormalCommand(command, args))}\n`);
  } catch (error: unknown) {
    // Formal-stage errors must never disclose approved-root paths or session data.
    if (error instanceof EvidenceStoreError)
      emitError(error.code, `Formal ${command} failed.`, error.recordId);
    emitError("E_EVAL_INTEGRITY", `Formal ${command} failed.`);
  }
}

async function runCleanupCommand(args: readonly string[]): Promise<void> {
  const { runId, piAgentDir } = parseRunArguments(args, "cleanup", false);
  const dryRun = args.includes("--dry-run");
  const confirmation = optionValue(args, "--confirm");
  if ((dryRun ? 1 : 0) + (confirmation === undefined ? 0 : 1) !== 1) {
    emitError(
      "E_EVAL_CONFIG",
      "cleanup requires exactly one of --dry-run or --confirm <plan-digest>.",
    );
  }
  try {
    const safeRun = await openSafeRun(piAgentDir, runId);
    const corpusKey = (await safeRunReadFile(safeRun, CORPUS_KEY_FILENAME)).toString("utf8");
    const plan = await planCleanup(safeRun, corpusKey);
    if (dryRun) {
      process.stdout.write(`${canonicalJson(plan)}\n`);
      return;
    }
    if (confirmation !== plan.planDigest) {
      emitError(
        "E_EVAL_INTEGRITY",
        "Confirmed plan digest does not match the current cleanup plan.",
      );
    }
    await persistCleanupManifest(safeRun, plan, corpusKey);
    const deletedCount = await executeCleanup(safeRun, corpusKey, runId, confirmation);
    process.stdout.write(`${canonicalJson({ deletedCount })}\n`);
  } catch (error: unknown) {
    if (error instanceof EvidenceStoreError) emitError(error.code, error.message, error.recordId);
    emitError("E_EVAL_INTEGRITY", "cleanup failed before deleting local artifacts.");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    emitError("E_EVAL_CONFIG", "Missing command. Use --help to see available commands.");
  }

  if (args[0] === "--help") {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  const rawCommand = args[0];

  // Unknown command
  if (!(CLI_COMMANDS as readonly string[]).includes(rawCommand)) {
    emitError(
      "E_EVAL_CONFIG",
      `Unknown command: ${rawCommand}. Use --help to see available commands.`,
    );
  }

  const command = rawCommand as CliCommand;
  if (
    command === "init" ||
    command === "inventory" ||
    command === "sample" ||
    command === "select-target"
  ) {
    await runFormalStageCommand(command, args.slice(1));
    return;
  }
  if (command === "qualify" || command === "adjudicate") {
    await runCandidateSelectionCommand(args.slice(1), command);
    return;
  }
  if (command === "freeze") {
    await runFreezeCommand(args.slice(1));
    return;
  }
  if (command === "replay") {
    await runReplayCommand(args.slice(1));
    return;
  }
  if (command === "lifecycle") {
    await runLifecycleCommand(args.slice(1));
    return;
  }
  if (command === "report") {
    await runReportCommand(args.slice(1));
    return;
  }
  if (command === "verify") {
    await runVerifyCommand(args.slice(1));
    return;
  }
  if (command === "cleanup") {
    await runCleanupCommand(args.slice(1));
    return;
  }

  // Known but unimplemented command
  emitError("E_EVAL_INCOMPLETE", `Command '${command}' is not yet implemented in T-001.`);
}

void main();
