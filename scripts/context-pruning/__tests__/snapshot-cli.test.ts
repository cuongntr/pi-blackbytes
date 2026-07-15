import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  atomicManifestWrite,
  corpusKeyDigest,
  generateCorpusKey,
  hmacDigest,
  loadOrCreateCorpusKey,
} from "../evidence-store.js";
import {
  createDisposableSessionCopy,
  inventorySource,
  validateDisposableSessionCopy,
} from "../inventory.js";
import { ensurePrivateRunRoot, openSafeRun } from "../path-safety.js";
import { nativeContextDigest, summaryInstructionDigest } from "../snapshots.js";
import type { RunManifest } from "../types.js";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
const digest = (character: string): string => character.repeat(64);
const runId = "snapshot-cli-run";
let root: string;
let agentDir: string;
let corpusId: string;
let runCorpusKey: string;

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
  const pseudonym = (rawId: string) => hmacDigest(runCorpusKey, Buffer.from(rawId));
  const requestIds = ["request-1", "request-2", "request-3", "request-4", "request-5"].map(
    pseudonym,
  );
  return {
    selection: {
      schemaVersion: 1,
      corpusId,
      selectedRank: 1,
      status: "selected",
      reasonCode: "candidate-selected",
      annotationDigests: [digest("d"), digest("e")],
      adjudicationDigest: digest("f"),
      qualification: {
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
          branchLeafId: pseudonym("request-5"),
          startEntryId: pseudonym("start"),
          endEntryId: pseudonym("start"),
          closureEntryId: pseudonym("closure"),
          startOrder: 1,
          endOrder: 1,
          closureOrder: 2,
          closureEvidence: ["goal-transition"],
          estimatedTokens: 2048,
          subsequentRequestIds: requestIds,
        },
        annotatorIds: [digest("b"), digest("c")],
        adjudicationStatus: "resolved",
      },
    },
    checkpoints: requestIds.map((requestEntryId, index) => {
      const entry = (rawId: string, role: "user" | "assistant", content: string) => ({
        entryId: pseudonym(rawId),
        message: { role, content },
      });
      const beforeCandidate = [entry("root", "user", "root context")];
      const candidateRange = [entry("start", "user", "candidate context")];
      const afterCandidate = [
        entry("closure", "user", "closure context"),
        ...Array.from({ length: index }, (_, prior) =>
          entry(`request-${prior + 1}`, "assistant", `BASELINE_CANARY_${prior + 1}`),
        ),
      ];
      return {
        checkpointIndex: index + 1,
        requestEntryId,
        nativeContextDigest: nativeContextDigest({
          checkpointIndex: index + 1,
          requestEntryId,
          beforeCandidate,
          candidateRange,
          afterCandidate,
        }),
      };
    }),
    targetSelectionDigest: digest("1"),
    systemPromptDigest: digest("2"),
    toolSchemaDigest: digest("3"),
    summaryInstruction: "Produce a concise factual summary of the candidate context.",
    summaryInstructionDigest: summaryInstructionDigest(
      "Produce a concise factual summary of the candidate context.",
    ),
    rubricDigest: digest("5"),
    objectiveChecksDigest: digest("6"),
    fixture: { status: "unavailable", executionTarget: "none", reasonCode: "fixture-not-captured" },
    goldFacts: [
      {
        factId: digest("7"),
        category: "goal",
        sourceEntryIds: [pseudonym("start")],
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
  runCorpusKey = key;
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId,
    createdAt: "2026-07-15T00:00:00.000Z",
    corpusKeyDigest: corpusKeyDigest(key),
    eventCount: 0,
  };
  await atomicManifestWrite(preRun, manifest);
  const run = await openSafeRun(agentDir, runId);
  const source = join(root, "generated-session.jsonl");
  const header = {
    type: "session",
    id: "session",
    version: 2,
    timestamp: "2026-07-15T00:00:00.000Z",
    cwd: "/generated",
  };
  const entries = [
    "root",
    "start",
    "closure",
    "request-1",
    "request-2",
    "request-3",
    "request-4",
    "request-5",
  ].map((id, index) => ({
    type: "message",
    id,
    parentId:
      index === 0
        ? null
        : ["root", "start", "closure", "request-1", "request-2", "request-3", "request-4"][
            index - 1
          ],
    timestamp: "2026-07-15T00:00:00.000Z",
    message:
      index < 3
        ? { role: "user", content: ["root context", "candidate context", "closure context"][index] }
        : {
            role: "assistant",
            content: `BASELINE_CANARY_${index - 2}`,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
  }));
  await writeFile(
    source,
    `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const record = await inventorySource(source, generateCorpusKey());
  const copy = await createDisposableSessionCopy(record, run);
  assert.equal((await validateDisposableSessionCopy(copy)).status, "matched");
  corpusId = record.corpusId;
  await writeFile(join(root, "freeze-input.json"), JSON.stringify(freezeInput()));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("freeze CLI", () => {
  it("derives a cross-process catalog from the persisted guarded copy and persists separated artifacts", async () => {
    const result = runCli([
      "freeze",
      "--input",
      join(root, "freeze-input.json"),
      "--run-id",
      runId,
      "--pi-agent-dir",
      agentDir,
    ]);
    assert.equal(result.status, 0);
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
    assert.equal(snapshot.includes("GENERATED CLI GOLD"), false);
    assert.equal(
      (
        await readFile(
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
        )
      ).includes("GENERATED CLI GOLD"),
      true,
    );
  });

  it("produces a strict content-free replay dry-run and rejects unsafe CLI variants", async () => {
    const replayInput = join(root, "replay-input.json");
    await writeFile(
      replayInput,
      JSON.stringify({
        selection: freezeInput().selection,
        replay: { protocolSeed: "cli-seed", replicateCount: 3, requestBudget: 64 },
      }),
    );
    const args = [
      "replay",
      "--dry-run",
      "--input",
      replayInput,
      "--run-id",
      runId,
      "--pi-agent-dir",
      agentDir,
      "--corpus-id",
      corpusId,
    ];
    const result = runCli(args);
    assert.equal(result.status, 0);
    assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), [
      "checkpointAttemptCount",
      "planDigest",
      "replicateCount",
      "snapshotId",
      "summaryGenerationCount",
    ]);
    assert.equal(result.stdout.includes("candidate context"), false);
    const oversizedReplayInput = join(root, "oversized-replay-input.json");
    await writeFile(
      oversizedReplayInput,
      JSON.stringify({
        selection: freezeInput().selection,
        replay: {
          protocolSeed: "cli-seed",
          replicateCount: Number.MAX_SAFE_INTEGER,
          requestBudget: 64,
        },
      }),
    );
    const oversized = runCli(
      args.map((value, index) => (args[index - 1] === "--input" ? oversizedReplayInput : value)),
    );
    assert.equal(oversized.status, 1);
    assert.equal(JSON.parse(oversized.stderr).code, "E_EVAL_SCHEMA");
    for (const invalid of [
      [...args, "--unknown"],
      [...args, "--dry-run"],
      [...args, "--confirm", "deadbeef"],
      args.filter((value) => value !== "--dry-run"),
    ]) {
      const rejected = runCli(invalid);
      assert.equal(rejected.status, 1);
      assert.equal(JSON.parse(rejected.stderr).code, "E_EVAL_CONFIG");
    }
  });

  it("is resume-idempotent", () => {
    const args = [
      "freeze",
      "--input",
      join(root, "freeze-input.json"),
      "--run-id",
      runId,
      "--pi-agent-dir",
      agentDir,
    ];
    assert.equal(runCli(args).status, 0);
    assert.equal(runCli(args).status, 0);
  });
});
