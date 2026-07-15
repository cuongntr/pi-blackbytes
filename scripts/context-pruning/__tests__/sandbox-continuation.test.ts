import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalDigest } from "../canonical-json.js";
import { atomicManifestWrite, corpusKeyDigest, loadOrCreateCorpusKey } from "../evidence-store.js";
import {
  ensurePrivateDir,
  ensurePrivateRunRoot,
  openSafeRun,
  safeRunPath,
  safeRunWriteFile,
} from "../path-safety.js";
import {
  hiddenCheckDefinitionDigest,
  runSandboxContinuation,
  sandboxContinuationResultExists,
} from "../sandbox-continuation.js";
import type { ContinuationArmAdapter, HiddenCheckDefinition } from "../sandbox-continuation.js";
import type { RepositoryFixture } from "../snapshots.js";

const digest = (value: string): string => canonicalDigest({ value });
let tempRoot = "";
let sequence = 0;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "sandbox-continuation-test-"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function safeRun() {
  sequence += 1;
  const agentDir = join(tempRoot, `agent-${sequence}`);
  const runId = `run-${sequence}`;
  const preRun = await ensurePrivateRunRoot(agentDir, runId);
  const key = await loadOrCreateCorpusKey(preRun);
  await atomicManifestWrite(preRun, {
    schemaVersion: 1,
    runId,
    createdAt: "2026-01-01T00:00:00.000Z",
    corpusKeyDigest: corpusKeyDigest(key),
    eventCount: 0,
  });
  return openSafeRun(agentDir, runId);
}

async function generatedGitRepository(name: string): Promise<string> {
  const root = join(tempRoot, name);
  await mkdir(root, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture baseline\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
}

async function copyFixture(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source))
    await cp(join(source, entry), join(destination, entry), { recursive: true });
}

async function verifiedFixtureFor(
  run: Awaited<ReturnType<typeof safeRun>>,
  status: "exact" | "reconstructed" = "exact",
): Promise<RepositoryFixture> {
  const artifactId = digest(`verified-artifact-${sequence}-${status}`);
  await ensurePrivateDir(run, `fixtures/${artifactId}`);
  const archive = Buffer.from("generated-fixture-archive", "utf8");
  const { createHash } = await import("node:crypto");
  const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  if (status === "exact") {
    await safeRunWriteFile(run, `fixtures/${artifactId}/archive`, archive.toString("utf8"));
    return {
      status,
      executionTarget: "disposable-only",
      commitDigest: digest("commit"),
      archiveDigest: hash(archive),
      artifactId,
    };
  }
  const patch = Buffer.from("generated patch", "utf8");
  const log = Buffer.from("generated reconstruction log", "utf8");
  await safeRunWriteFile(run, `fixtures/${artifactId}/patch`, patch.toString("utf8"));
  await safeRunWriteFile(run, `fixtures/${artifactId}/reconstruction-log`, log.toString("utf8"));
  return {
    status,
    executionTarget: "disposable-only",
    commitDigest: digest("commit"),
    patchDigest: hash(patch),
    reconstructionLogDigest: hash(log),
    artifactId,
  };
}

function checks(): readonly HiddenCheckDefinition[] {
  return Object.freeze([
    Object.freeze({
      checkId: "pass",
      command: process.execPath,
      args: ["-e", "process.stdout.write('private check output')"],
      timeoutMs: 1_000,
    }),
  ]);
}

function adapter(): ContinuationArmAdapter {
  return {
    async continue({ arm, cwd, caps }) {
      await writeFile(join(cwd, "arm.txt"), arm, "utf8");
      return { requestsUsed: 1, toolsUsed: [caps.allowedTools[0]!] };
    },
  };
}

describe("sandbox continuation", () => {
  it("runs exact and reconstructed generated git fixtures in separate disposable paths with identical caps", async () => {
    for (const status of ["exact", "reconstructed"] as const) {
      const run = await safeRun();
      const original = await generatedGitRepository(`original-${sequence}-${status}`);
      const template = await generatedGitRepository(`template-${sequence}-${status}`);
      const fixture = await verifiedFixtureFor(run, status);
      const observed: Array<{ arm: string; cwd: string; caps: string }> = [];
      const continuation: ContinuationArmAdapter = {
        async continue(input) {
          observed.push({ arm: input.arm, cwd: input.cwd, caps: canonicalDigest(input.caps) });
          await writeFile(join(input.cwd, `${input.arm}.txt`), input.arm, "utf8");
          return { requestsUsed: 1, toolsUsed: [input.caps.allowedTools[0]!] };
        },
      };
      const hidden = checks();
      const result = await runSandboxContinuation({
        safeRun: run,
        snapshotDigest: digest(`snapshot-${status}`),
        objectiveChecksDigest: hiddenCheckDefinitionDigest(hidden),
        fixture,
        originalRepositoryPath: original,
        caps: { allowedTools: ["read", "write"], requestLimit: 2 },
        hiddenChecks: hidden,
        materializer: { materialize: ({ destination }) => copyFixture(template, destination) },
        continuation,
      });
      assert.equal(result.execution, "executed");
      assert.equal(observed.length, 2);
      assert.notEqual(observed[0]!.cwd, observed[1]!.cwd);
      assert.equal(observed[0]!.caps, observed[1]!.caps);
      assert.deepEqual(observed.map((entry) => entry.arm).sort(), ["native", "selective"]);
      assert.equal(await readFile(join(original, "README.md"), "utf8"), "fixture baseline\n");
      assert.deepEqual(await readdir(safeRunPath(run, "sandbox-fixtures")), []);
      assert.equal(await sandboxContinuationResultExists(run, result.resultDigest), true);
    }
  });

  it("returns and persists an explicit rubric-only result without materializing an unavailable fixture", async () => {
    const run = await safeRun();
    let called = false;
    const result = await runSandboxContinuation({
      safeRun: run,
      snapshotDigest: digest("unavailable"),
      objectiveChecksDigest: hiddenCheckDefinitionDigest(checks()),
      fixture: {
        status: "unavailable",
        executionTarget: "none",
        reasonCode: "fixture-not-captured",
      },
      originalRepositoryPath: join(tempRoot, "not-read"),
      caps: { allowedTools: ["read"], requestLimit: 1 },
      hiddenChecks: checks(),
      materializer: {
        async materialize() {
          called = true;
        },
      },
      continuation: adapter(),
    });
    assert.equal(result.execution, "rubric-only");
    assert.equal(called, false);
    assert.equal(await sandboxContinuationResultExists(run, result.resultDigest), true);
  });

  it("refuses an original-repository alias, symlinked fixture, and hardlinked fixture file", async () => {
    const run = await safeRun();
    const original = await generatedGitRepository(`unsafe-original-${sequence}`);
    const fixture = await verifiedFixtureFor(run);
    const hidden = checks();
    const base = {
      safeRun: run,
      snapshotDigest: digest("unsafe"),
      objectiveChecksDigest: hiddenCheckDefinitionDigest(hidden),
      fixture,
      caps: { allowedTools: ["read"], requestLimit: 1 },
      hiddenChecks: hidden,
      continuation: adapter(),
    };
    const originalAlias = join(tempRoot, `unsafe-original-alias-${sequence}`);
    await symlink(original, originalAlias);
    await assert.rejects(
      runSandboxContinuation({
        ...base,
        originalRepositoryPath: originalAlias,
        materializer: { async materialize() {} },
      }),
      /real directory/,
    );
    await assert.rejects(
      runSandboxContinuation({
        ...base,
        originalRepositoryPath: original,
        materializer: {
          async materialize({ destination }) {
            await symlink(original, join(destination, "escape"));
          },
        },
      }),
      /unsafe path/,
    );
    await assert.rejects(
      runSandboxContinuation({
        ...base,
        originalRepositoryPath: original,
        materializer: {
          async materialize({ destination }) {
            const { link } = await import("node:fs/promises");
            await link(join(original, "README.md"), join(destination, "README.md"));
          },
        },
      }),
      /hardlinked file/,
    );
  });

  it("records pass, fail, and timeout hidden checks without persisting check output", async () => {
    const run = await safeRun();
    const original = await generatedGitRepository(`checks-original-${sequence}`);
    const template = await generatedGitRepository(`checks-template-${sequence}`);
    const fixture = await verifiedFixtureFor(run);
    const hidden = [
      ...checks(),
      {
        checkId: "fail",
        command: process.execPath,
        args: ["-e", "process.stderr.write('secret failure'); process.exit(3)"],
        timeoutMs: 1_000,
      },
      {
        checkId: "timeout",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 1000)"],
        timeoutMs: 20,
      },
    ] as const;
    const result = await runSandboxContinuation({
      safeRun: run,
      snapshotDigest: digest("checks"),
      objectiveChecksDigest: hiddenCheckDefinitionDigest(hidden),
      fixture,
      originalRepositoryPath: original,
      caps: { allowedTools: ["read"], requestLimit: 1 },
      hiddenChecks: hidden,
      materializer: { materialize: ({ destination }) => copyFixture(template, destination) },
      continuation: adapter(),
    });
    assert.equal(result.execution, "executed");
    if (result.execution !== "executed") return;
    for (const arm of result.arms)
      assert.deepEqual(
        arm.checks.map((check) => check.status),
        ["pass", "fail", "timeout"],
      );
    const persisted = await readFile(
      safeRunPath(run, `sandbox-continuation-results/${result.resultDigest}.json`),
      "utf8",
    );
    assert.doesNotMatch(persisted, /private check output|secret failure/);
    assert.deepEqual(await readdir(safeRunPath(run, "sandbox-fixtures")), []);
  });
});
