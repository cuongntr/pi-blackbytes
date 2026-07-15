import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { candidateIdForQualification, qualificationCatalogDigest } from "../annotations.js";
import { canonicalDigest } from "../canonical-json.js";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
const digest = (character: string): string => character.repeat(64);
let root: string;

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

function input(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const corpusId = digest("a");
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
      branchLeafId: digest("b"),
      startEntryId: digest("c"),
      endEntryId: digest("d"),
      closureEntryId: digest("e"),
      startOrder: 1,
      endOrder: 2,
      closureOrder: 3,
      closureEvidence: ["goal-transition"],
      estimatedTokens: 2_048,
      subsequentRequestIds: ["f", "1", "2", "3", "4"].map(digest),
    },
    annotatorIds: [],
    adjudicationStatus: "not-needed",
  };
  const candidateEnvelope = {
    schemaVersion: 1,
    qualificationDigest: canonicalDigest(qualification),
    qualification,
  };
  const candidateId = candidateIdForQualification(qualification);
  const catalogDigest = qualificationCatalogDigest([candidateEnvelope]);
  const claim = { candidateId, closureEvidence: ["goal-transition"] };
  const annotation = (
    annotationId: string,
    annotatorId: string,
    annotatorKind: "owner" | "independent-human",
  ) => ({
    schemaVersion: 1,
    annotationId,
    catalogDigest,
    corpusId,
    selectedRank: 1,
    annotatorId,
    annotatorKind,
    decision: "candidates-identified",
    claims: [claim],
    reasonCodes: [],
  });
  return {
    candidates: [candidateEnvelope],
    annotations: [
      annotation(digest("5"), digest("6"), "owner"),
      annotation(digest("7"), digest("8"), "independent-human"),
    ],
    ...extra,
  };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "annotation-cli-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("qualification CLI access boundary", () => {
  it("selects and emits a final T-007A qualification record", () => {
    const path = join(root, "qualify.json");
    writeFileSync(path, JSON.stringify(input()));
    const result = runCli(["qualify", "--input", path]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "selected");
    assert.equal(output.qualification.qualifies, true);
    assert.equal(output.qualification.annotatorIds.length, 2);
    assert.equal(result.stdout.includes("transcript"), false);
  });

  it("rejects forbidden future/cost/gold inputs before selection", () => {
    const path = join(root, "forbidden.json");
    writeFileSync(path, JSON.stringify(input({ gold: "SECRET_CANARY" })));
    const result = runCli(["qualify", "--input", path]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "E_EVAL_SCHEMA");
    assert.equal(result.stdout, "");
  });

  it("requires adjudication data only for the adjudicate command", () => {
    const path = join(root, "no-adjudication.json");
    writeFileSync(path, JSON.stringify(input()));
    const result = runCli(["adjudicate", "--input", path]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "E_EVAL_CONFIG");
  });
});
