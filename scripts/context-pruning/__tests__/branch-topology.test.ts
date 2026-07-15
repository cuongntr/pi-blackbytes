/** Hermetic topology, lineage, and copied Pi-session validation coverage. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { BranchTopologyAccumulator } from "../branch-topology.js";
import {
  atomicManifestWrite,
  corpusKeyDigest,
  generateCorpusKey,
  hmacDigest,
  loadOrCreateCorpusKey,
} from "../evidence-store.js";
import { inventoryCorpus, inventorySource } from "../inventory.js";
import {
  ensurePrivateRunRoot,
  openSafeRun,
  safeRunReadFile,
  safeRunReaddir,
  safeRunStat,
  safeRunWriteFile,
} from "../path-safety.js";
import {
  createDisposableSessionCopy,
  validateDisposableSessionCopy,
} from "../session-validation.js";
import type { RunManifest } from "../types.js";

let root: string;

function line(id: string, parentId: string | null, role?: "assistant" | "user"): object {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-07-15T00:00:00.000Z",
    ...(role === undefined
      ? {}
      : {
          message:
            role === "assistant"
              ? {
                  role,
                  content: "generated-only",
                  usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                }
              : { role, content: "generated-only" },
        }),
  };
}

async function session(
  path: string,
  id: string,
  entries: object[],
  parentSession?: string,
  version = 3,
): Promise<void> {
  await writeFile(
    path,
    `${[
      JSON.stringify({
        type: "session",
        id,
        version,
        timestamp: "2026-07-15T00:00:00.000Z",
        cwd: "/generated",
        ...(parentSession === undefined ? {} : { parentSession }),
      }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n")}\n`,
  );
}

async function safeRun() {
  const agentDir = join(root, "agent");
  const preRun = await ensurePrivateRunRoot(agentDir, "validation");
  const key = await loadOrCreateCorpusKey(preRun);
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId: "validation",
    createdAt: "2026-07-15T00:00:00.000Z",
    corpusKeyDigest: corpusKeyDigest(key),
    eventCount: 0,
  };
  await atomicManifestWrite(preRun, manifest);
  return openSafeRun(agentDir, "validation");
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "branch-topology-test-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("final Pi branch reconstruction", () => {
  it("selects the last physical leaf, counts only its requests, and excludes corrupt topology", async () => {
    const key = generateCorpusKey();
    const path = join(root, "navigated.jsonl");
    await session(path, "session-canary", [
      line("root", null, "user"),
      line("abandoned", "root", "assistant"),
      line("active", "root", "assistant"),
      line("leaf", "active", "assistant"),
    ]);
    const record = await inventorySource(path, key);
    assert.equal(record.branchCount, 2);
    assert.equal(record.selectedLeafId, hmacDigest(key, Buffer.from("leaf")));
    assert.equal(record.selectedLeafLineIndex, 5);
    assert.equal(record.finalBranchEntryCount, 3);
    assert.equal(record.finalBranchRequestCount, 2);
    assert.equal(record.abandonedEntryCount, 1);
    assert.equal(record.requestCount, 3);

    const corrupt = join(root, "corrupt.jsonl");
    await session(corrupt, "corrupt", [line("a", "b"), line("b", "a"), line("a", null)]);
    const corruptRecord = await inventorySource(corrupt, key);
    assert.equal(corruptRecord.branchCount, 0);
    assert.deepEqual(
      corruptRecord.exclusionReasons.filter(
        (reason) =>
          reason === "duplicate-structural-id" ||
          reason === "structural-cycle" ||
          reason === "no-terminal-leaf",
      ),
      ["duplicate-structural-id", "no-terminal-leaf", "structural-cycle"],
    );
  });

  it("resolves only in-corpus exact lineage and chooses a permutation-stable representative", async () => {
    const key = generateCorpusKey();
    const parent = join(root, "parent.jsonl");
    const child = join(root, "child.jsonl");
    const sibling = join(root, "sibling.jsonl");
    const missing = join(root, "missing.jsonl");
    await session(parent, "parent-id", [line("root", null, "user")]);
    const canonicalParent = await realpath(parent);
    await session(child, "child-id", [line("child", null, "user")], canonicalParent);
    await session(sibling, "sibling-id", [line("sibling", null, "user")], canonicalParent);
    await session(missing, "missing-id", [line("missing", null, "user")], "not-in-corpus.jsonl");

    const one = await inventoryCorpus([child, missing, sibling, parent], key);
    const two = await inventoryCorpus([parent, sibling, child, missing], key);
    const byDigest = (records: readonly (typeof one)[number][]) =>
      new Map(records.map((record) => [record.sourceDigest, record]));
    const first = byDigest(one);
    const second = byDigest(two);
    for (const [digest, record] of first) {
      const reordered = second.get(digest);
      assert.equal(record.corpusId, reordered?.corpusId);
      assert.equal(record.lineageStatus, reordered?.lineageStatus);
      assert.equal(record.lineageDisposition, reordered?.lineageDisposition);
    }
    assert.equal(
      [...one].filter((record) => record.lineageDisposition === "duplicate-lineage").length,
      2,
    );
    assert.ok(one.some((record) => record.exclusionReasons.includes("unresolved-parent-session")));
    assert.equal(JSON.stringify(one).includes(parent), false);
    assert.equal(JSON.stringify(one).includes("parent-id"), false);
  });

  it("opens only a generated SafeRun copy with Pi and leaves the source untouched", async () => {
    const key = generateCorpusKey();
    const path = join(root, "copy-source.jsonl");
    await session(path, "copy-session", [
      line("root", null, "user"),
      line("last", "root", "assistant"),
    ]);
    const sourceBefore = await readFile(path);
    const sourceStatsBefore = await stat(path);
    const record = await inventorySource(path, key);
    const run = await safeRun();
    const copy = await createDisposableSessionCopy(record, run);
    const validation = await validateDisposableSessionCopy(copy);
    assert.equal(validation.status, "matched");
    assert.deepEqual(await readFile(path), sourceBefore);
    assert.equal((await stat(path)).mtimeMs, sourceStatsBefore.mtimeMs);
    const copies = await safeRunReaddir(run, "copied-sessions");
    assert.equal(copies.length, 1);
    const copyName = copies[0]?.name;
    assert.ok(copyName !== undefined);
    assert.equal((await safeRunStat(run, `copied-sessions/${copyName}`)).mode & 0o777, 0o600);
    // The expected leaf is private registration data; callers cannot override it.
    const forged = await validateDisposableSessionCopy({ __brand: "DisposableSessionCopy" });
    assert.equal(forged.status, "copy-failed");
  });

  it("keeps immutable per-file corpus identities while sharing one lineage root identity", async () => {
    const key = generateCorpusKey();
    const parent = join(root, "identity-parent.jsonl");
    const child = join(root, "identity-child.jsonl");
    const sibling = join(root, "identity-sibling.jsonl");
    await session(parent, "identity-parent", [line("p", null, "user")]);
    const parentPath = await realpath(parent);
    await session(child, "identity-child", [line("c", null, "user")], parentPath);
    await session(sibling, "identity-sibling", [line("s", null, "user")], parentPath);
    const capturedLogs: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const capture = (...values: unknown[]) => capturedLogs.push(values.map(String).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    let records: Awaited<ReturnType<typeof inventoryCorpus>>;
    try {
      records = await inventoryCorpus([sibling, parent, child], key);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
    const expected = (path: string, id: string) =>
      createHmac("sha256", Buffer.from(key, "hex"))
        .update(Buffer.concat([Buffer.from(path, "utf8"), Buffer.from(id, "utf8")]))
        .digest("hex");
    const childPath = await realpath(child);
    const siblingPath = await realpath(sibling);
    const parentId = expected(parentPath, "identity-parent");
    const childId = expected(childPath, "identity-child");
    const siblingId = expected(siblingPath, "identity-sibling");
    const parentRecord = records.find((record) => record.corpusId === parentId);
    const childRecord = records.find((record) => record.corpusId === childId);
    const siblingRecord = records.find((record) => record.corpusId === siblingId);
    assert.ok(parentRecord && childRecord && siblingRecord);
    assert.equal(parentRecord.corpusId, parentId);
    assert.equal(childRecord.corpusId, childId);
    assert.equal(siblingRecord.corpusId, siblingId);
    assert.equal(
      new Set([parentRecord.corpusId, childRecord.corpusId, siblingRecord.corpusId]).size,
      3,
    );
    assert.ok(parentRecord.lineageRootId);
    assert.equal(parentRecord.lineageRootId, childRecord.lineageRootId);
    assert.equal(parentRecord.lineageRootId, siblingRecord.lineageRootId);
    assert.equal(records.filter((record) => record.lineageDisposition === "unique").length, 1);
    const logText = capturedLogs.join("\n");
    for (const privateValue of [parentPath, "identity-child", "generated-only"]) {
      assert.equal(logText.includes(privateValue), false);
    }
  });

  it("resolves nested forks iteratively and excludes unresolved and cyclic lineages", async () => {
    const key = generateCorpusKey();
    const rootSession = join(root, "nested-root.jsonl");
    const child = join(root, "nested-child.jsonl");
    const grandchild = join(root, "nested-grandchild.jsonl");
    const unresolved = join(root, "nested-unresolved.jsonl");
    const cycleA = join(root, "nested-cycle-a.jsonl");
    const cycleB = join(root, "nested-cycle-b.jsonl");
    await session(rootSession, "root", [line("r", null, "user")]);
    await session(child, "child", [line("c", null, "user")], await realpath(rootSession));
    await session(grandchild, "grandchild", [line("g", null, "user")], await realpath(child));
    await session(unresolved, "unresolved", [line("u", null, "user")], "not-present.jsonl");
    // Create both files before wiring their generated-only cross-file cycle.
    await session(cycleA, "cycle-a", [line("a", null, "user")]);
    await session(cycleB, "cycle-b", [line("b", null, "user")], await realpath(cycleA));
    await session(cycleA, "cycle-a", [line("a", null, "user")], await realpath(cycleB));
    const records = await inventoryCorpus(
      [grandchild, cycleB, unresolved, child, rootSession, cycleA],
      key,
    );
    const nested = records.filter((record) => record.lineageRootId !== undefined);
    assert.equal(nested.length, 3);
    assert.equal(new Set(nested.map((record) => record.lineageRootId)).size, 1);
    assert.deepEqual(nested.map((record) => record.lineageStatus).sort(), [
      "resolved",
      "resolved",
      "root",
    ]);
    assert.ok(records.some((record) => record.lineageStatus === "unresolved"));
    assert.equal(records.filter((record) => record.lineageStatus === "cycle").length, 2);
    assert.ok(
      records
        .filter((record) => record.lineageStatus === "cycle")
        .every((record) => record.lineageRootId === undefined),
    );
  });

  it("detects duplicate parent entries separately from structural topology failures", async () => {
    const key = generateCorpusKey();
    const parent = join(root, "duplicate-parent.jsonl");
    const child = join(root, "duplicate-child.jsonl");
    await session(parent, "duplicate-parent", [line("p", null, "user")]);
    await session(child, "duplicate-child", [line("c", null, "user")], await realpath(parent));
    const records = await inventoryCorpus([parent, parent, child], key);
    assert.ok(records.some((record) => record.lineageDisposition === "duplicate-lineage"));
    const childDigest = (await inventorySource(child, key)).sourceDigest;
    const childRecord = records.find((record) => record.sourceDigest === childDigest);
    assert.equal(childRecord?.lineageStatus, "unresolved");
    assert.ok(childRecord?.exclusionReasons.includes("unresolved-parent-session"));
  });

  it("uses byte-stable leaf tie-breaks, validates bad line indexes, and handles deep paths", () => {
    const key = generateCorpusKey();
    const tied = new BranchTopologyAccumulator(key);
    tied.add("root", null, 1, false);
    tied.add("z", "root", 4, false);
    tied.add("\u00e9", "root", 4, false);
    const expectedLeaf = hmacDigest(key, Buffer.from("\u00e9", "utf8"));
    assert.equal(tied.finalize().selectedLeafId, expectedLeaf);

    const invalid = new BranchTopologyAccumulator(key);
    invalid.add("ignored", null, Number.NaN, false);
    invalid.add("zero", null, 0, false);
    assert.deepEqual(invalid.finalize().reasons, ["invalid-line-index", "no-terminal-leaf"]);

    const duplicate = new BranchTopologyAccumulator(key);
    duplicate.add("duplicate", null, 1, false);
    duplicate.add("duplicate", null, 2, false);
    assert.ok(duplicate.finalize().reasons.includes("duplicate-structural-id"));

    const missingParent = new BranchTopologyAccumulator(key);
    missingParent.add("orphan", "missing", 1, false);
    assert.ok(missingParent.finalize().reasons.includes("missing-parent"));
    const selfCycle = new BranchTopologyAccumulator(key);
    selfCycle.add("self", "self", 1, false);
    assert.ok(selfCycle.finalize().reasons.includes("structural-cycle"));
    const multiCycle = new BranchTopologyAccumulator(key);
    multiCycle.add("a", "b", 1, false);
    multiCycle.add("b", "a", 2, false);
    assert.ok(multiCycle.finalize().reasons.includes("structural-cycle"));

    const deep = new BranchTopologyAccumulator(key);
    const depth = 12000;
    for (let index = 0; index < depth; index += 1) {
      deep.add(`node-${index}`, index === 0 ? null : `node-${index - 1}`, index + 1, false);
    }
    const finalized = deep.finalize();
    assert.equal(finalized.finalBranchEntryCount, depth);
    assert.equal(finalized.abandonedEntryCount, 0);
  });

  it("reports a Pi leaf mismatch for parent-after-child topology", async () => {
    const key = generateCorpusKey();
    const path = join(root, "copy-leaf-mismatch.jsonl");
    await session(path, "copy-leaf-mismatch", [
      line("selected-child", "late-parent", "user"),
      line("late-parent", null, "user"),
    ]);
    const record = await inventorySource(path, key);
    assert.equal(record.parseStatus, "valid");
    assert.equal(record.selectedLeafId, hmacDigest(key, Buffer.from("selected-child")));

    const copy = await createDisposableSessionCopy(record, await safeRun());
    const validation = await validateDisposableSessionCopy(copy);
    assert.equal(validation.status, "mismatch");
    assert.equal(validation.corpusId, record.corpusId);
  });

  it("allows pinned Pi to migrate a v2 copy without modifying its source", async () => {
    const key = generateCorpusKey();
    const path = join(root, "copy-v2-source.jsonl");
    await session(
      path,
      "copy-v2-source",
      [line("root", null, "user"), line("last", "root", "assistant")],
      undefined,
      2,
    );
    const sourceBefore = await readFile(path);
    const sourceStatsBefore = await stat(path);
    const record = await inventorySource(path, key);
    assert.equal(record.sessionVersion, 2);

    const run = await safeRun();
    const beforeCopies = new Set(
      (await safeRunReaddir(run, "copied-sessions")).map((entry) => entry.name),
    );
    const copy = await createDisposableSessionCopy(record, run);
    const copyName = (await safeRunReaddir(run, "copied-sessions")).find(
      (entry) => !beforeCopies.has(entry.name),
    )?.name;
    assert.ok(copyName);
    const relativePath = `copied-sessions/${copyName}`;
    const copyBefore = await safeRunReadFile(run, relativePath);
    const copyStatsBefore = await safeRunStat(run, relativePath);

    assert.equal((await validateDisposableSessionCopy(copy)).status, "matched");
    const copyAfter = await safeRunReadFile(run, relativePath);
    const copyStatsAfter = await safeRunStat(run, relativePath);
    assert.notDeepEqual(copyAfter, copyBefore);
    assert.match(copyAfter.toString("utf8"), /"version":3/);
    assert.equal(copyStatsAfter.dev, copyStatsBefore.dev);
    assert.equal(copyStatsAfter.ino, copyStatsBefore.ino);
    assert.deepEqual(await readFile(path), sourceBefore);
    assert.equal((await stat(path)).mtimeMs, sourceStatsBefore.mtimeMs);
  });

  it("rejects ineligible lineage records and atomically replaced SafeRun copies", async () => {
    const key = generateCorpusKey();
    const parent = join(root, "copy-parent.jsonl");
    const child = join(root, "copy-child.jsonl");
    await session(parent, "copy-parent", [line("p", null, "user")]);
    await session(child, "copy-child", [line("c", null, "user")], await realpath(parent));
    const lineage = await inventoryCorpus([parent, child], key);
    const excluded = lineage.find((record) => record.lineageDisposition === "duplicate-lineage");
    assert.ok(excluded);
    await assert.rejects(createDisposableSessionCopy(excluded, await safeRun()));

    const malformedTopology = join(root, "copy-invalid-topology.jsonl");
    await session(malformedTopology, "copy-invalid-topology", [line("orphan", "missing", "user")]);
    await assert.rejects(
      createDisposableSessionCopy(await inventorySource(malformedTopology, key), await safeRun()),
    );

    const source = join(root, "copy-tamper.jsonl");
    await session(source, "copy-tamper", [line("root", null, "user")]);
    const run = await safeRun();
    const beforeCopies = new Set(
      (await safeRunReaddir(run, "copied-sessions")).map((entry) => entry.name),
    );
    const copy = await createDisposableSessionCopy(await inventorySource(source, key), run);
    const copyName = (await safeRunReaddir(run, "copied-sessions")).find(
      (entry) => !beforeCopies.has(entry.name),
    )?.name;
    assert.ok(copyName);
    await safeRunWriteFile(run, `copied-sessions/${copyName}`, "{}\n");
    assert.equal((await validateDisposableSessionCopy(copy)).status, "copy-failed");
  });
});
