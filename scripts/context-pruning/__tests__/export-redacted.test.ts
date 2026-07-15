/** Focused T-015 report privacy, integrity, and suppression tests. */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { canonicalDigest, canonicalJson } from "../canonical-json.js";
import { hmacDigest } from "../evidence-store.js";
import {
  MINIMUM_INDEPENDENT_AGGREGATE_N,
  authenticateRedactedReportInput,
  buildRedactedReport,
} from "../export-redacted.js";
import { EvidenceStoreError } from "../types.js";

const CORPUS_KEY = "7".repeat(64);
const SOURCE_CONTENT = "content-free-source-fixture";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function input(snapshotCount: number, replicates = 1) {
  const root = await mkdtemp(join(tmpdir(), "context-pruning-report-"));
  tempRoots.push(root);
  const sourcePath = join(root, "source.jsonl");
  await writeFile(sourcePath, SOURCE_CONTENT);
  const sourceDigest = hmacDigest(CORPUS_KEY, Buffer.from(SOURCE_CONTENT));
  const payload = { locked: true, canary: "AKIAABCDEFGHIJKLMNOP" };
  return {
    schemaVersion: 1,
    outcome: "NO-GO" as const,
    artifacts: [{ digest: canonicalDigest(payload), payload }],
    sourceChecks: [{ sourcePath, beforeDigest: sourceDigest, afterDigest: sourceDigest }],
    observations: Array.from({ length: snapshotCount * replicates }, (_, index) => ({
      snapshotId: `private-snapshot-${index % snapshotCount}`,
      replicateIndex: Math.floor(index / Math.max(snapshotCount, 1)) + 1,
      bucket: "quality" as const,
      value: 10,
    })),
    diagnostics: [
      { kind: "exclusion" as const, code: "qualification-unavailable" },
      { kind: "failure" as const, code: "provider-missing" },
      { kind: "skip" as const, code: "upstream-hard-stop" },
    ],
    repositoryClusteringObserved: true,
    cacheIsolationAvailable: false,
  };
}

async function report(snapshotCount: number, replicates = 1) {
  const value = await input(snapshotCount, replicates);
  return buildRedactedReport(authenticateRedactedReportInput(value, CORPUS_KEY), CORPUS_KEY);
}

function qualityAggregate(reportValue: Awaited<ReturnType<typeof buildRedactedReport>>) {
  return reportValue.candidate.aggregates.find((item) => item.bucket === "quality");
}

describe("T-015 redacted export", () => {
  for (const n of [0, 1, 4]) {
    it(`suppresses the quality subgroup at n=${n}`, async () => {
      assert.deepEqual(qualityAggregate(await report(n)), {
        bucket: "quality",
        status: "suppressed",
      });
    });
  }

  it("reports an aggregate exactly at n=5", async () => {
    const aggregate = qualityAggregate(await report(MINIMUM_INDEPENDENT_AGGREGATE_N));
    assert.deepEqual(aggregate, {
      bucket: "quality",
      status: "reported",
      independentN: MINIMUM_INDEPENDENT_AGGREGATE_N,
      mean: 10,
    });
  });

  it("does not count replicates as independent snapshots", async () => {
    assert.deepEqual(qualityAggregate(await report(4, 3)), {
      bucket: "quality",
      status: "suppressed",
    });
  });

  it("never exports a canary, source path, private ID, payload, or raw diagnostic code", async () => {
    const reportValue = await report(5);
    const candidate = canonicalJson(reportValue.candidate);
    const local = canonicalJson(reportValue.local);
    assert.equal(candidate.includes("AKIAABCDEFGHIJKLMNOP"), false);
    assert.equal(candidate.includes("private-snapshot"), false);
    assert.equal(candidate.includes("qualification-unavailable"), false);
    assert.equal(local.includes("AKIAABCDEFGHIJKLMNOP"), false);
    assert.equal(local.includes("source.jsonl"), false);
    assert.ok(
      reportValue.candidate.limitations.some((item) => item.includes("Repository clustering")),
    );
    assert.ok(reportValue.candidate.limitations.some((item) => item.includes("Cache isolation")));
  });

  it("refuses an artifact whose payload no longer matches its digest", async () => {
    const value = await input(5);
    value.artifacts[0]!.payload = { locked: false, canary: "AKIAABCDEFGHIJKLMNOP" };
    const authenticated = authenticateRedactedReportInput(value, CORPUS_KEY);
    await assert.rejects(
      () => buildRedactedReport(authenticated, CORPUS_KEY),
      (error: unknown) => error instanceof EvidenceStoreError && error.code === "E_EVAL_INTEGRITY",
    );
  });

  it("binds outcome and observations to the authenticated calculation input", async () => {
    const authenticated = authenticateRedactedReportInput(await input(5), CORPUS_KEY);
    const tampered = JSON.parse(JSON.stringify(authenticated)) as {
      report: { outcome: string; observations: Array<{ value: number }> };
    };
    tampered.report.outcome = "GO";
    tampered.report.observations[0]!.value = 999;
    await assert.rejects(
      () => buildRedactedReport(tampered, CORPUS_KEY),
      (error: unknown) => error instanceof EvidenceStoreError && error.code === "E_EVAL_INTEGRITY",
    );
  });

  it("reopens the authoritative source and refuses drift or fabricated equal digest pairs", async () => {
    const changed = await input(5);
    const authenticatedChanged = authenticateRedactedReportInput(changed, CORPUS_KEY);
    await writeFile(changed.sourceChecks[0]!.sourcePath, "changed");
    await assert.rejects(
      () => buildRedactedReport(authenticatedChanged, CORPUS_KEY),
      (error: unknown) => error instanceof EvidenceStoreError && error.code === "E_EVAL_INTEGRITY",
    );

    const fabricated = await input(5);
    fabricated.sourceChecks[0]!.beforeDigest = "a".repeat(64);
    fabricated.sourceChecks[0]!.afterDigest = "a".repeat(64);
    await assert.rejects(
      () =>
        buildRedactedReport(authenticateRedactedReportInput(fabricated, CORPUS_KEY), CORPUS_KEY),
      (error: unknown) => error instanceof EvidenceStoreError && error.code === "E_EVAL_INTEGRITY",
    );
  });
});
