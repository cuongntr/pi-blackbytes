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

import { selectAnnotatedCandidate, validateCandidateSelectionInput } from "./annotations.js";
import { canonicalJson } from "./canonical-json.js";
import {
  parseLifecycleMatrixMetadata,
  requireT021RealMatrixExecutor,
  runLifecycleMatrix,
} from "./lifecycle/runner.js";
import { openSafeRun } from "./path-safety.js";
import { freezeSnapshot, persistFrozenSnapshot, validateFreezeSnapshotInput } from "./snapshots.js";
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
  --dry-run         Plan mode (no external cost)
  --confirm <hash>  Confirm a plan
  --decline <hash>  Decline a plan
  --not-applicable <hash>  Record a verified upstream hard-stop
  --opt-in                 Required for lifecycle matrix handoff to T-021
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
    const bundle = freezeSnapshot(validateFreezeSnapshotInput(value));
    const safeRun = await openSafeRun(piAgentDir, runId);
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

async function runLifecycleCommand(args: readonly string[]): Promise<never> {
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
  if (command === "qualify" || command === "adjudicate") {
    await runCandidateSelectionCommand(args.slice(1), command);
    return;
  }
  if (command === "freeze") {
    await runFreezeCommand(args.slice(1));
    return;
  }
  if (command === "lifecycle") {
    await runLifecycleCommand(args.slice(1));
    return;
  }

  // Known but unimplemented command
  emitError("E_EVAL_INCOMPLETE", `Command '${command}' is not yet implemented in T-001.`);
}

void main();
