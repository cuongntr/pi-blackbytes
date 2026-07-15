import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { atomicManifestWrite, corpusKeyDigest, loadOrCreateCorpusKey } from "../evidence-store.js";
import { ensurePrivateRunRoot } from "../path-safety.js";
import type { RunManifest } from "../types.js";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
const digest = (character: string): string => character.repeat(64);
const corpusId = digest("a");
const runId = "snapshot-cli-run";
let root: string;
let agentDir: string;

function runCli(args: readonly string[]): { stdout: string; stderr: string; status: number } {
  try {
    return {
      stdout: execFileSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
        encoding: "utf8",
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
      }),
      stderr: "",
      status: 0,
    };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      status: failure.status ?? 1,
    };
  }
}

function freezeInput() {
  const requestIds = ["1", "2", "3", "4", "5"].map(digest);
  const qualification = {
    schemaVersion: 1,
    corpusId,
    selectedRank: 1,
    qualifies: true,
    criteria: {
      parent: true,
      pressure: true,
      completedSegment: true,
      fiveSubsequentRequests: true,
    },
    reasonCodes: [],
    candidate: {
      branchLeafId: digest("6"),
      startEntryId: digest("7"),
      endEntryId: digest("8"),
      closureEntryId: digest("9"),
      startOrder: 1,
      endOrder: 2,
      closureOrder: 3,
      closureEvidence: ["goal-transition"],
      estimatedTokens: 2_048,
      subsequentRequestIds: requestIds,
    },
    annotatorIds: [digest("b"), digest("c")],
    adjudicationStatus: "resolved",
  };
  return {
    selection: {
      schemaVersion: 1,
      corpusId,
      selectedRank: 1,
      status: "selected",
      reasonCode: "candidate-selected",
      annotationDigests: [digest("d"), digest("e")],
      adjudicationDigest: digest("f"),
      qualification,
    },
    checkpoints: requestIds.map((requestEntryId, index) => ({
      checkpointIndex: index + 1,
      requestEntryId,
      nativeContextDigest: digest(String(index + 1)),
    })),
    targetSelectionDigest: digest("1"),
    systemPromptDigest: digest("2"),
    toolSchemaDigest: digest("3"),
    summaryInstructionDigest: digest("4"),
    rubricDigest: digest("5"),
    objectiveChecksDigest: digest("6"),
    fixture: {
      status: "unavailable",
      executionTarget: "none",
      reasonCode: "fixture-not-captured",
    },
    goldFacts: [
      {
        factId: digest("7"),
        category: "goal",
        sourceEntryIds: [digest("8")],
        statement: "GENERATED CLI GOLD",
        diagnosticAtCheckpoints: [true, true, true, true, true],
      },
    ],
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "snapshot-cli-test-"));
  agentDir = join(root, "agent");
  const preRun = await ensurePrivateRunRoot(agentDir, runId);
  const key = await loadOrCreateCorpusKey(preRun);
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId,
    createdAt: "2026-07-15T00:00:00.000Z",
    corpusKeyDigest: corpusKeyDigest(key),
    eventCount: 0,
  };
  await atomicManifestWrite(preRun, manifest);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("freeze CLI", () => {
  it("persists private immutable snapshot/gold artifacts and returns digests only", async () => {
    const inputPath = join(root, "freeze-input.json");
    await writeFile(inputPath, JSON.stringify(freezeInput()));
    const result = runCli([
      "freeze",
      "--input",
      inputPath,
      "--run-id",
      runId,
      "--pi-agent-dir",
      agentDir,
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output).sort(), [
      "goldLedgerDigest",
      "snapshotDigest",
      "snapshotId",
    ]);
    const snapshot = await readFile(
      join(
        agentDir,
        "blackbytes",
        "evaluations",
        "context-pruning",
        runId,
        "snapshots",
        `${corpusId}.json`,
      ),
      "utf8",
    );
    const gold = await readFile(
      join(
        agentDir,
        "blackbytes",
        "evaluations",
        "context-pruning",
        runId,
        "gold",
        `${corpusId}.json`,
      ),
      "utf8",
    );
    assert.equal(snapshot.includes("GENERATED CLI GOLD"), false);
    assert.equal(gold.includes("GENERATED CLI GOLD"), true);
  });

  it("is resume-idempotent", async () => {
    const inputPath = join(root, "freeze-input.json");
    const first = runCli([
      "freeze",
      "--input",
      inputPath,
      "--run-id",
      runId,
      "--pi-agent-dir",
      agentDir,
    ]);
    const second = runCli([
      "freeze",
      "--input",
      inputPath,
      "--run-id",
      runId,
      "--pi-agent-dir",
      agentDir,
    ]);
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, first.stdout);
  });
});
