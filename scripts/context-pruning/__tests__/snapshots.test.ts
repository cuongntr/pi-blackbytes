import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalDigest, canonicalJson } from "../canonical-json.js";
import { atomicManifestWrite, corpusKeyDigest, loadOrCreateCorpusKey } from "../evidence-store.js";
import {
  ensurePrivateRunRoot,
  openSafeRun,
  safeRunPath,
  safeRunReadFile,
  safeRunWriteFile,
} from "../path-safety.js";
import {
  assertSnapshotImmutable,
  buildSummaryGenerationAccess,
  freezeSnapshot,
  persistFrozenSnapshot,
  validateEvaluationSnapshot,
  validateGoldLedger,
  validateRepositoryFixture,
  verifyFrozenBundle,
} from "../snapshots.js";
import type { FreezeSnapshotInput, FrozenSnapshotBundle, GoldFact } from "../snapshots.js";
import type { RunManifest } from "../types.js";

const digest = (character: string): string => character.repeat(64);
const corpusId = digest("a");
const requestIds = ["1", "2", "3", "4", "5"].map(digest);
let root: string;
let runCounter = 0;

function qualification() {
  return {
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
}

function selection(qualificationValue = qualification()) {
  return {
    schemaVersion: 1,
    corpusId: qualificationValue.corpusId,
    selectedRank: qualificationValue.selectedRank,
    status: "selected",
    reasonCode: "candidate-selected",
    annotationDigests: [digest("d"), digest("e")],
    adjudicationDigest: digest("f"),
    qualification: qualificationValue,
  };
}

function exactFixture() {
  return {
    status: "exact",
    executionTarget: "disposable-only",
    commitDigest: digest("d"),
    archiveDigest: digest("e"),
    artifactId: digest("f"),
  };
}

function input(patch: Partial<FreezeSnapshotInput> = {}): FreezeSnapshotInput {
  return {
    selection: selection(),
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
    fixture: exactFixture(),
    goldFacts: [
      {
        factId: digest("7"),
        category: "hard-constraint",
        sourceEntryIds: [digest("8")],
        statement: "GENERATED_PRIVATE_GOLD_CANARY",
        diagnosticAtCheckpoints: [true, true, false, false, true],
      },
    ],
    ...patch,
  };
}

function recomputeSnapshot(bundle: FrozenSnapshotBundle, patch: Record<string, unknown>) {
  const withoutDigest = { ...bundle.snapshot, ...patch } as Record<string, unknown>;
  delete withoutDigest.snapshotDigest;
  return { ...withoutDigest, snapshotDigest: canonicalDigest(withoutDigest) };
}

async function safeRun() {
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
  return openSafeRun(agentDir, runId);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "snapshot-test-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("snapshot freezing and leakage controls", () => {
  it("freezes exactly five bound checkpoints and mutually bound gold", () => {
    const bundle = freezeSnapshot(input());
    assert.equal(bundle.snapshot.checkpoints.length, 5);
    assert.deepEqual(
      bundle.snapshot.checkpoints.map((checkpoint) => checkpoint.requestEntryId),
      requestIds,
    );
    assert.equal(bundle.snapshot.goldLedgerDigest, bundle.goldLedger.ledgerDigest);
    assert.doesNotThrow(() => verifyFrozenBundle(bundle));
    assert.doesNotThrow(() => validateEvaluationSnapshot(bundle.snapshot));
    assert.doesNotThrow(() => validateGoldLedger(bundle.goldLedger));
  });

  it("requires the complete selected T-007B result, not a bare qualification", () => {
    assert.throws(() => freezeSnapshot(input({ selection: qualification() })), {
      code: "E_EVAL_SCHEMA",
    });
    const duplicatedAnnotator = qualification();
    duplicatedAnnotator.annotatorIds = [digest("b"), digest("b")];
    assert.throws(() => freezeSnapshot(input({ selection: selection(duplicatedAnnotator) })), {
      code: "E_EVAL_SCHEMA",
    });
  });

  it("rejects checkpoint count, order, and horizon mismatches", () => {
    assert.throws(() => freezeSnapshot(input({ checkpoints: input().checkpoints.slice(0, 4) })), {
      code: "E_EVAL_SCHEMA",
    });
    const reordered = [...input().checkpoints].reverse();
    assert.throws(() => freezeSnapshot(input({ checkpoints: reordered })), {
      code: "E_EVAL_SCHEMA",
    });
    const wrong = input().checkpoints.map((checkpoint, index) =>
      index === 4
        ? { ...(checkpoint as Record<string, unknown>), requestEntryId: digest("0") }
        : checkpoint,
    );
    assert.throws(() => freezeSnapshot(input({ checkpoints: wrong })), {
      code: "E_EVAL_INTEGRITY",
    });
  });

  it("gives the summary generator only range references and its instruction digest", () => {
    const bundle = freezeSnapshot(input());
    const access = buildSummaryGenerationAccess(bundle.snapshot, selection());
    assert.deepEqual(Object.keys(access).sort(), [
      "candidateRange",
      "snapshotId",
      "summaryInstructionDigest",
    ]);
    const serialized = JSON.stringify(access);
    for (const forbidden of [
      "checkpoints",
      "gold",
      "objectiveChecks",
      "baseline",
      "future",
      "GENERATED_PRIVATE_GOLD_CANARY",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });

  it("keeps private gold statements out of the primary snapshot", () => {
    const bundle = freezeSnapshot(input());
    assert.equal(JSON.stringify(bundle.snapshot).includes("GENERATED_PRIVATE_GOLD_CANARY"), false);
    assert.equal(JSON.stringify(bundle.goldLedger).includes("GENERATED_PRIVATE_GOLD_CANARY"), true);
  });
});

describe("gold ledger", () => {
  it("requires atomic source-provenanced facts and five diagnostic statuses", () => {
    const fact = (input().goldFacts as Record<string, unknown>[])[0];
    assert.throws(() => freezeSnapshot(input({ goldFacts: [{ ...fact, sourceEntryIds: [] }] })), {
      code: "E_EVAL_SCHEMA",
    });
    assert.throws(
      () => freezeSnapshot(input({ goldFacts: [{ ...fact, diagnosticAtCheckpoints: [true] }] })),
      { code: "E_EVAL_SCHEMA" },
    );
    assert.throws(
      () => freezeSnapshot(input({ goldFacts: [{ ...fact, category: "unsupported" }] })),
      { code: "E_EVAL_SCHEMA" },
    );
  });

  it("rejects duplicate facts and detects any ledger mutation", () => {
    const fact = input().goldFacts[0];
    assert.throws(() => freezeSnapshot(input({ goldFacts: [fact, fact] })), {
      code: "E_EVAL_SCHEMA",
    });
    const bundle = freezeSnapshot(input());
    const mutated = structuredClone(bundle.goldLedger);
    (mutated.facts[0] as unknown as { statement: string }).statement = "mutated";
    assert.throws(() => validateGoldLedger(mutated), { code: "E_EVAL_INTEGRITY" });

    const secondFact = {
      ...(input().goldFacts[0] as Record<string, unknown>),
      factId: digest("6"),
    };
    const ordered = freezeSnapshot(input({ goldFacts: [input().goldFacts[0], secondFact] }));
    const reordered = structuredClone(ordered.goldLedger);
    (reordered.facts as GoldFact[]).reverse();
    assert.throws(() => validateGoldLedger(reordered), { code: "E_EVAL_INTEGRITY" });
  });
});

describe("repository fixture classification", () => {
  it("accepts exactly exact, reconstructed, and unavailable classifications", () => {
    assert.equal(validateRepositoryFixture(exactFixture()).status, "exact");
    assert.equal(
      validateRepositoryFixture({
        status: "reconstructed",
        executionTarget: "disposable-only",
        commitDigest: digest("1"),
        patchDigest: digest("2"),
        reconstructionLogDigest: digest("3"),
        artifactId: digest("4"),
      }).status,
      "reconstructed",
    );
    assert.equal(
      validateRepositoryFixture({
        status: "unavailable",
        executionTarget: "none",
        reasonCode: "fixture-not-captured",
      }).status,
      "unavailable",
    );
  });

  it("never accepts an original repository path or execution target", () => {
    assert.throws(
      () => validateRepositoryFixture({ ...exactFixture(), sourcePath: "/real/repository" }),
      { code: "E_EVAL_SCHEMA" },
    );
    assert.throws(
      () => validateRepositoryFixture({ ...exactFixture(), executionTarget: "original" }),
      { code: "E_EVAL_SCHEMA" },
    );
  });
});

describe("immutability and persistence", () => {
  it("detects every post-freeze snapshot mutation", () => {
    const bundle = freezeSnapshot(input());
    const mutated = structuredClone(bundle.snapshot);
    (mutated as unknown as { systemPromptDigest: string }).systemPromptDigest = digest("0");
    assert.throws(() => validateEvaluationSnapshot(mutated), { code: "E_EVAL_INTEGRITY" });

    const validMutation = recomputeSnapshot(bundle, { systemPromptDigest: digest("0") });
    assert.throws(() => assertSnapshotImmutable(bundle.snapshot, validMutation), {
      code: "E_EVAL_INTEGRITY",
    });
  });

  it("persists idempotently and allows exactly one primary snapshot per corpus", async () => {
    const run = await safeRun();
    const bundle = freezeSnapshot(input());
    await persistFrozenSnapshot(run, bundle);
    await persistFrozenSnapshot(run, bundle);
    const snapshot = JSON.parse(
      (await safeRunReadFile(run, `snapshots/${corpusId}.json`)).toString("utf8"),
    );
    const gold = JSON.parse((await safeRunReadFile(run, `gold/${corpusId}.json`)).toString("utf8"));
    assert.equal(canonicalJson(snapshot), canonicalJson(bundle.snapshot));
    assert.equal(canonicalJson(gold), canonicalJson(bundle.goldLedger));

    await unlink(safeRunPath(run, `snapshots/${corpusId}.json`));
    await unlink(safeRunPath(run, `gold/${corpusId}.json`));
    await persistFrozenSnapshot(run, bundle);
    assert.equal(
      canonicalJson(
        JSON.parse((await safeRunReadFile(run, `snapshots/${corpusId}.json`)).toString("utf8")),
      ),
      canonicalJson(bundle.snapshot),
    );

    const changedSnapshot = recomputeSnapshot(bundle, { systemPromptDigest: digest("0") });
    await assert.rejects(
      () => persistFrozenSnapshot(run, { ...bundle, snapshot: changedSnapshot as never }),
      { code: "E_EVAL_INTEGRITY" },
    );
  });

  it("blocks replay-facing verification after persisted tampering", async () => {
    const run = await safeRun();
    const bundle = freezeSnapshot({
      ...input(),
      selection: selection({ ...qualification(), selectedRank: 2 }),
    });
    await persistFrozenSnapshot(run, bundle);
    const path = `snapshots/${corpusId}.json`;
    const tampered = structuredClone(bundle.snapshot);
    (tampered as unknown as { rubricDigest: string }).rubricDigest = digest("0");
    await safeRunWriteFile(run, path, JSON.stringify(tampered));
    await assert.rejects(() => persistFrozenSnapshot(run, bundle), { code: "E_EVAL_INTEGRITY" });
  });

  it("rejects a pre-created frozen-directory symlink without writing private gold outside", async () => {
    const run = await safeRun();
    const outside = join(root, `outside-${runCounter}`);
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, safeRunPath(run, "frozen"), "dir");

    await assert.rejects(() => persistFrozenSnapshot(run, freezeSnapshot(input())), {
      code: "E_EVAL_INTEGRITY",
    });
    await assert.rejects(() => readFile(join(outside, `${corpusId}.json`)), { code: "ENOENT" });
  });

  it("normalizes before queuing so caller mutation cannot poison the commit marker", async () => {
    const run = await safeRun();
    const mutable = structuredClone(freezeSnapshot(input()));
    const expectedDigest = mutable.snapshot.systemPromptDigest;
    const persistence = persistFrozenSnapshot(run, mutable);
    (mutable.snapshot as unknown as { systemPromptDigest: string }).systemPromptDigest =
      digest("0");
    (mutable as unknown as Record<string, unknown>).unexpected = "not-persisted";
    await persistence;

    const persisted = JSON.parse(
      (await safeRunReadFile(run, `frozen/${corpusId}.json`)).toString("utf8"),
    );
    assert.equal(persisted.snapshot.systemPromptDigest, expectedDigest);
    assert.equal("unexpected" in persisted, false);
  });

  it("rejects non-schema bundle fields before publishing a permanent marker", async () => {
    const run = await safeRun();
    const bundle = { ...freezeSnapshot(input()), unexpected: "not-persisted" };
    assert.throws(() => persistFrozenSnapshot(run, bundle as never), {
      code: "E_EVAL_INTEGRITY",
    });
    await assert.rejects(() => safeRunReadFile(run, `frozen/${corpusId}.json`), {
      code: "E_EVAL_INTEGRITY",
    });
  });
});
