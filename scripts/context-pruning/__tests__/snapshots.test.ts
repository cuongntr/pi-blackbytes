import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalJson } from "../canonical-json.js";
import {
  atomicManifestWrite,
  corpusKeyDigest,
  generateCorpusKey,
  hmacDigest,
  loadOrCreateCorpusKey,
} from "../evidence-store.js";
import { createDisposableSessionCopy, inventorySource } from "../inventory.js";
import {
  ensurePrivateRunRoot,
  openSafeRun,
  safeRunFileExists,
  safeRunPath,
  safeRunReadFile,
  safeRunReaddir,
  safeRunWriteFile,
} from "../path-safety.js";
import type { SafeRun } from "../path-safety.js";
import {
  buildSummaryGenerationAccess,
  createPrivateGoldLedgerAccess,
  freezeSnapshot,
  loadPrivateGoldLedger,
  nativeContextDigest,
  openReplaySnapshotAccess,
  persistFrozenSnapshot,
  summaryInstructionDigest,
} from "../snapshots.js";
import type { FreezeSnapshotInput, FrozenSnapshotBundle } from "../snapshots.js";
import type { RunManifest } from "../types.js";

const digest = (character: string): string => character.repeat(64);
let root: string;
let runCounter = 0;

function sessionJsonl(): string {
  const header = {
    type: "session",
    id: "generated-session",
    version: 3,
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
    message: {
      role: index >= 3 ? "assistant" : "user",
      content:
        ["root context", "candidate context", "closure context"][index] ??
        `BASELINE_CANARY_${index - 2}`,
      ...(index >= 3
        ? {
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }
        : {}),
    },
  }));
  return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function preparedRun(): Promise<{
  run: SafeRun;
  key: string;
  corpusId: string;
}> {
  runCounter += 1;
  const runId = `snapshot-run-${runCounter}`;
  const agentDir = join(root, runId);
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
  const run = await openSafeRun(agentDir, runId);
  const source = join(root, `${runId}.jsonl`);
  await writeFile(source, sessionJsonl());
  const record = await inventorySource(source, generateCorpusKey());
  await createDisposableSessionCopy(record, run);
  return {
    run,
    key,
    corpusId: record.corpusId,
  };
}

function input(corpusId: string, runCorpusKey: string): FreezeSnapshotInput {
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
        statement: "GENERATED_PRIVATE_GOLD_CANARY",
        diagnosticAtCheckpoints: [true, true, true, true, true],
      },
    ],
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "snapshot-test-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("authenticated snapshot freezing", () => {
  it("derives its catalog from a guarded disposable copy rather than caller JSON", async () => {
    const prepared = await preparedRun();
    const frozen = await freezeSnapshot(prepared.run, input(prepared.corpusId, prepared.key));
    assert.equal(frozen.snapshot.copyReferenceDigest.length, 64);
    const isolated = await preparedRun();
    const unrelated = JSON.parse(
      JSON.stringify(input(isolated.corpusId, isolated.key)),
    ) as FreezeSnapshotInput & {
      selection: { qualification: { candidate: { branchLeafId: string } } };
    };
    unrelated.selection.qualification.candidate.branchLeafId = digest("a");
    await assert.rejects(() => freezeSnapshot(isolated.run, unrelated), {
      code: "E_EVAL_INTEGRITY",
    });
    await assert.rejects(
      () =>
        freezeSnapshot(prepared.run, {
          ...input(prepared.corpusId, prepared.key),
          goldFacts: [
            {
              factId: digest("7"),
              category: "goal",
              sourceEntryIds: [digest("0")],
              statement: "bad",
              diagnosticAtCheckpoints: [true, true, true, true, true],
            },
          ],
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
  });

  it("does not publish a catalog for invalid ordering and permits a corrected retry", async () => {
    const prepared = await preparedRun();
    const invalid = JSON.parse(
      JSON.stringify(input(prepared.corpusId, prepared.key)),
    ) as FreezeSnapshotInput & {
      selection: { qualification: { candidate: { startOrder: number } } };
    };
    invalid.selection.qualification.candidate.startOrder = 0;

    await assert.rejects(() => freezeSnapshot(prepared.run, invalid), {
      code: "E_EVAL_INTEGRITY",
    });
    assert.equal(
      await safeRunFileExists(prepared.run, `catalogs/${prepared.corpusId}.json`),
      false,
    );

    await freezeSnapshot(prepared.run, input(prepared.corpusId, prepared.key));
    assert.equal(await safeRunFileExists(prepared.run, `catalogs/${prepared.corpusId}.json`), true);
  });

  it("loads full bundles for replay/gold roles and keeps the gold canary out of replay", async () => {
    const prepared = await preparedRun();
    const frozen = await freezeSnapshot(prepared.run, input(prepared.corpusId, prepared.key));
    await persistFrozenSnapshot(prepared.run, frozen);
    const replay = JSON.stringify(await openReplaySnapshotAccess(prepared.run, prepared.corpusId));
    assert.equal(replay.includes("GENERATED_PRIVATE_GOLD_CANARY"), false);
    assert.equal(
      (await loadPrivateGoldLedger(createPrivateGoldLedgerAccess(prepared.run, prepared.corpusId)))
        .facts[0]?.statement,
      "GENERATED_PRIVATE_GOLD_CANARY",
    );
  });

  it("gives the summary role only authenticated instruction content and candidate messages", async () => {
    const prepared = await preparedRun();
    const freezeInput = input(prepared.corpusId, prepared.key);
    const frozen = await freezeSnapshot(prepared.run, freezeInput);
    await persistFrozenSnapshot(prepared.run, frozen);
    const summary = await buildSummaryGenerationAccess(
      await openReplaySnapshotAccess(prepared.run, prepared.corpusId),
      freezeInput.selection,
    );
    assert.deepEqual(Object.keys(summary).sort(), ["candidateMessages", "instruction"]);
    assert.equal(summary.instruction, freezeInput.summaryInstruction);
    assert.equal(JSON.stringify(summary).includes("GENERATED_PRIVATE_GOLD_CANARY"), false);
    assert.equal(JSON.stringify(summary).includes("BASELINE_CANARY"), false);
  });

  it("rejects missing or mutated catalog/copy artifacts before either loader projects a role", async () => {
    const prepared = await preparedRun();
    const frozen = await freezeSnapshot(prepared.run, input(prepared.corpusId, prepared.key));
    await persistFrozenSnapshot(prepared.run, frozen);
    await unlink(safeRunPath(prepared.run, `copied-session-descriptors/${prepared.corpusId}.json`));
    await assert.rejects(() => openReplaySnapshotAccess(prepared.run, prepared.corpusId), {
      code: "E_EVAL_INTEGRITY",
    });
    await assert.rejects(
      () => loadPrivateGoldLedger(createPrivateGoldLedgerAccess(prepared.run, prepared.corpusId)),
      { code: "E_EVAL_INTEGRITY" },
    );
    assert.equal(
      (await safeRunReadFile(prepared.run, `gold/${prepared.corpusId}.json`))
        .toString()
        .includes("GENERATED_PRIVATE_GOLD_CANARY"),
      true,
    );
  });

  it("rejects a guarded private-copy mutation after catalog scanning", async () => {
    const prepared = await preparedRun();
    const frozen = await freezeSnapshot(prepared.run, input(prepared.corpusId, prepared.key));
    await persistFrozenSnapshot(prepared.run, frozen);
    const copyName = (await safeRunReaddir(prepared.run, "copied-sessions"))[0]?.name;
    assert.ok(copyName);
    await safeRunWriteFile(prepared.run, `copied-sessions/${copyName}`, "mutated\n");
    await assert.rejects(() => openReplaySnapshotAccess(prepared.run, prepared.corpusId), {
      code: "E_EVAL_INTEGRITY",
    });
  });

  it("does not repair a committed bundle after a catalog mutation", async () => {
    const prepared = await preparedRun();
    const frozen: FrozenSnapshotBundle = await freezeSnapshot(
      prepared.run,
      input(prepared.corpusId, prepared.key),
    );
    await persistFrozenSnapshot(prepared.run, frozen);
    await safeRunWriteFile(
      prepared.run,
      `catalogs/${prepared.corpusId}.json`,
      canonicalJson({ mutated: true }),
    );
    await assert.rejects(() => persistFrozenSnapshot(prepared.run, frozen), {
      code: "E_EVAL_INTEGRITY",
    });
  });
});
