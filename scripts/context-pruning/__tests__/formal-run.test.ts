/** Hermetic T-017 command orchestration tests: fabricated JSONL only. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalJson } from "../canonical-json.js";
import { runFormalCommand } from "../formal-run.js";
import { sampleManifestDigest } from "../sampling.js";

const DIGEST = "a".repeat(64);
let root: string;
let sequence = 0;

function lock(runId: string, endsAt = "2030-01-01T00:00:00.000Z") {
  return {
    stage: "sampling-lock",
    schemaVersion: 1,
    runId,
    protocolSeed: "generated-seed",
    longSessionMinRequests: 20,
    collectionWindowEndsAt: endsAt,
    maxInventoryRefreshes: 1,
    modelRegistryDigest: DIGEST,
    estimatorPolicyDigest: "b".repeat(64),
  };
}

function session(index: number): string {
  const now = "2026-07-15T00:00:00.000Z";
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const lines: object[] = [
    { type: "session", id: `session-${index}`, version: 2, timestamp: now },
    {
      type: "message",
      id: "root",
      parentId: null,
      timestamp: now,
      message: { role: "user", content: "private-canary" },
    },
  ];
  let parentId = "root";
  for (let request = 1; request <= 20; request += 1) {
    const id = `request-${request}`;
    lines.push({
      type: "message",
      id,
      parentId,
      timestamp: now,
      message: { role: "assistant", content: "private-canary", usage },
    });
    parentId = id;
  }
  return `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function testRoot(label: string) {
  const base = join(root, `${++sequence}-${label}`);
  const agent = join(base, "agent");
  const sources = join(base, "sources");
  await mkdir(sources, { recursive: true });
  const config = join(base, "sampling.json");
  return { base, agent, sources, config };
}

async function init(runId: string, config: string, agent: string, endsAt?: string) {
  await writeFile(config, JSON.stringify(lock(runId, endsAt)));
  return runFormalCommand("init", ["--run-id", runId, "--config", config, "--pi-agent-dir", agent]);
}

function runFile(agent: string, runId: string, file: string): string {
  return join(agent, "blackbytes/evaluations/context-pruning", runId, file);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await writeFile(path, canonicalJson(value));
}

async function inventory(runId: string, agent: string, sources: string) {
  return runFormalCommand("inventory", [
    "--run-id",
    runId,
    "--source-root",
    sources,
    "--pi-agent-dir",
    agent,
  ]);
}

before(async () => {
  root = join(tmpdir(), `formal-run-${process.pid}`);
  await mkdir(root, { recursive: true });
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("formal T-017 orchestration", () => {
  it("freezes a fabricated 40-session sample, binds target, and verifies without publishing content", async () => {
    const { agent, sources, config } = await testRoot("success");
    const runId = "formal-success";
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(join(sources, `s-${index}.jsonl`), session(index)),
      ),
    );
    const first = await init(runId, config, agent);
    const resumed = await runFormalCommand("init", [
      "--run-id",
      runId,
      "--config",
      config,
      "--pi-agent-dir",
      agent,
    ]);
    assert.deepEqual(resumed, first);
    const inventory = await runFormalCommand("inventory", [
      "--run-id",
      runId,
      "--source-root",
      sources,
      "--pi-agent-dir",
      agent,
    ]);
    assert.equal((inventory as { eligibleFrameSize: number }).eligibleFrameSize, 40);
    const sample = await runFormalCommand("sample", ["--run-id", runId, "--pi-agent-dir", agent]);
    assert.equal((sample as { status: string }).status, "frozen");
    const target = {
      stage: "target-selection",
      schemaVersion: 1,
      runId,
      provider: "generated",
      model: "generated",
      api: "generated",
      reasoning: "generated",
      samplingLockDigest: (first as { lockDigest: string }).lockDigest,
      inventoryDigest: (inventory as { inventoryDigest: string }).inventoryDigest,
      sampleDigest: (sample as { sampleDigest: string }).sampleDigest,
      providerPolicyDigest: "c".repeat(64),
    };
    const targetPath = join(root, "target.json");
    await writeFile(targetPath, JSON.stringify(target));
    await runFormalCommand("select-target", [
      "--run-id",
      runId,
      "--target",
      targetPath,
      "--pi-agent-dir",
      agent,
    ]);
    const verified = await runFormalCommand("verify", ["--run-id", runId, "--pi-agent-dir", agent]);
    assert.equal((verified as { terminal: string }).terminal, "frozen");
    const publicInventory = await readFile(
      join(agent, "blackbytes/evaluations/context-pruning", runId, "inventory/attempt-0.json"),
      "utf8",
    );
    assert.equal(publicInventory.includes("private-canary"), false);
    assert.equal(publicInventory.includes(sources), false);
  });

  it("records pending and hard-stop underflow without a partial sample", async () => {
    const pending = await testRoot("pending");
    await init("underflow-pending", pending.config, pending.agent);
    await runFormalCommand("inventory", [
      "--run-id",
      "underflow-pending",
      "--source-root",
      pending.sources,
      "--pi-agent-dir",
      pending.agent,
    ]);
    const pendingSample = await runFormalCommand("sample", [
      "--run-id",
      "underflow-pending",
      "--pi-agent-dir",
      pending.agent,
    ]);
    assert.equal((pendingSample as { status: string }).status, "underflow-pending");
    const hard = await testRoot("hard");
    await init("underflow-hard", hard.config, hard.agent, "2020-01-01T00:00:00.000Z");
    await runFormalCommand("inventory", [
      "--run-id",
      "underflow-hard",
      "--source-root",
      hard.sources,
      "--pi-agent-dir",
      hard.agent,
    ]);
    const hardSample = await runFormalCommand("sample", [
      "--run-id",
      "underflow-hard",
      "--pi-agent-dir",
      hard.agent,
    ]);
    assert.equal((hardSample as { status: string }).status, "underflow-hard-stop");
    const verified = await runFormalCommand("verify", [
      "--run-id",
      "underflow-hard",
      "--pi-agent-dir",
      hard.agent,
    ]);
    assert.equal((verified as { terminal: string }).terminal, "underflow-hard-stop");
  });

  it("fails closed on drift, symlinked source roots, and duplicate command options", async () => {
    const { agent, sources, config, base } = await testRoot("refusal");
    await init("refusal", config, agent);
    await assert.rejects(
      runFormalCommand("init", [
        "--run-id",
        "refusal",
        "--config",
        config,
        "--config",
        config,
        "--pi-agent-dir",
        agent,
      ]),
    );
    const link = join(base, "link");
    await symlink(sources, link);
    await assert.rejects(
      runFormalCommand("inventory", [
        "--run-id",
        "refusal",
        "--source-root",
        link,
        "--pi-agent-dir",
        agent,
      ]),
    );
  });

  it("requires an authenticated pending predecessor and the original source root for refresh", async () => {
    const first = await testRoot("refresh-predecessor");
    await init("refresh-predecessor", first.config, first.agent);
    await inventory("refresh-predecessor", first.agent, first.sources);
    await assert.rejects(inventory("refresh-predecessor", first.agent, first.sources));

    const hard = await testRoot("refresh-hard-stop");
    await init("refresh-hard-stop", hard.config, hard.agent, "2020-01-01T00:00:00.000Z");
    await inventory("refresh-hard-stop", hard.agent, hard.sources);
    await runFormalCommand("sample", [
      "--run-id",
      "refresh-hard-stop",
      "--pi-agent-dir",
      hard.agent,
    ]);
    await assert.rejects(inventory("refresh-hard-stop", hard.agent, hard.sources));

    const switched = await testRoot("refresh-root-switch");
    const alternate = join(switched.base, "alternate");
    await mkdir(alternate);
    await init("refresh-root-switch", switched.config, switched.agent);
    await inventory("refresh-root-switch", switched.agent, switched.sources);
    await runFormalCommand("sample", [
      "--run-id",
      "refresh-root-switch",
      "--pi-agent-dir",
      switched.agent,
    ]);
    await assert.rejects(inventory("refresh-root-switch", switched.agent, alternate));
  });

  it("rejects inventory filename/index, summary, and private same-byte path mapping drift", async () => {
    const mismatch = await testRoot("inventory-index");
    await init("inventory-index", mismatch.config, mismatch.agent);
    await inventory("inventory-index", mismatch.agent, mismatch.sources);
    const artifactPath = runFile(mismatch.agent, "inventory-index", "inventory/attempt-0.json");
    await writeFile(
      runFile(mismatch.agent, "inventory-index", "inventory/attempt-1.json"),
      await readFile(artifactPath),
    );
    await assert.rejects(
      runFormalCommand("sample", ["--run-id", "inventory-index", "--pi-agent-dir", mismatch.agent]),
    );

    const summary = await testRoot("inventory-summary");
    await init("inventory-summary", summary.config, summary.agent);
    await inventory("inventory-summary", summary.agent, summary.sources);
    const summaryPath = runFile(summary.agent, "inventory-summary", "inventory/attempt-0.json");
    const summaryArtifact = await readJson(summaryPath);
    await writeCanonical(summaryPath, { ...summaryArtifact, sourceCount: 99 });
    await assert.rejects(
      runFormalCommand("sample", [
        "--run-id",
        "inventory-summary",
        "--pi-agent-dir",
        summary.agent,
      ]),
    );

    const mapped = await testRoot("private-mapping");
    await writeFile(join(mapped.sources, "one.jsonl"), session(1));
    await writeFile(join(mapped.sources, "same-bytes.jsonl"), session(1));
    await init("private-mapping", mapped.config, mapped.agent);
    await inventory("private-mapping", mapped.agent, mapped.sources);
    const privatePath = runFile(
      mapped.agent,
      "private-mapping",
      "private/inventory-attempt-0.json",
    );
    const privateEvidence = await readJson(privatePath);
    const sources = privateEvidence.sources as Record<string, unknown>[];
    await writeCanonical(privatePath, {
      ...privateEvidence,
      sources: sources.map((source, index) =>
        index === 0 ? { ...source, path: join(mapped.sources, "same-bytes.jsonl") } : source,
      ),
    });
    await assert.rejects(
      runFormalCommand("sample", ["--run-id", "private-mapping", "--pi-agent-dir", mapped.agent]),
    );
  });

  it("authenticates underflow dispositions and anchors the exact frozen sample and target", async () => {
    const underflow = await testRoot("underflow-schema");
    await init("underflow-schema", underflow.config, underflow.agent);
    await inventory("underflow-schema", underflow.agent, underflow.sources);
    const pending = await runFormalCommand("sample", [
      "--run-id",
      "underflow-schema",
      "--pi-agent-dir",
      underflow.agent,
    ]);
    assert.match((pending as { dispositionDigest: string }).dispositionDigest, /^[0-9a-f]{64}$/);
    const underflowPath = runFile(
      underflow.agent,
      "underflow-schema",
      "sampling/attempt-0-underflow.json",
    );
    const disposition = await readJson(underflowPath);
    await writeCanonical(underflowPath, { ...disposition, extra: true });
    await assert.rejects(
      runFormalCommand("verify", [
        "--run-id",
        "underflow-schema",
        "--pi-agent-dir",
        underflow.agent,
      ]),
    );
    const { frameSize: _frameSize, ...missingField } = disposition;
    await writeCanonical(underflowPath, missingField);
    await assert.rejects(
      runFormalCommand("verify", [
        "--run-id",
        "underflow-schema",
        "--pi-agent-dir",
        underflow.agent,
      ]),
    );

    const frozen = await testRoot("sample-target-anchor");
    const runId = "sample-target-anchor";
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(join(frozen.sources, `s-${index}.jsonl`), session(index)),
      ),
    );
    const initialized = await init(runId, frozen.config, frozen.agent);
    const inventoried = await inventory(runId, frozen.agent, frozen.sources);
    const sampled = await runFormalCommand("sample", [
      "--run-id",
      runId,
      "--pi-agent-dir",
      frozen.agent,
    ]);
    const target = {
      stage: "target-selection",
      schemaVersion: 1,
      runId,
      provider: "generated",
      model: "generated",
      api: "generated",
      reasoning: "generated",
      samplingLockDigest: (initialized as { lockDigest: string }).lockDigest,
      inventoryDigest: (inventoried as { inventoryDigest: string }).inventoryDigest,
      sampleDigest: (sampled as { sampleDigest: string }).sampleDigest,
      providerPolicyDigest: "c".repeat(64),
    };
    const targetPath = join(frozen.base, "target.json");
    await writeCanonical(targetPath, target);
    await runFormalCommand("select-target", [
      "--run-id",
      runId,
      "--target",
      targetPath,
      "--pi-agent-dir",
      frozen.agent,
    ]);
    await writeCanonical(targetPath, { ...target, providerPolicyDigest: "d".repeat(64) });
    await assert.rejects(
      runFormalCommand("select-target", [
        "--run-id",
        runId,
        "--target",
        targetPath,
        "--pi-agent-dir",
        frozen.agent,
      ]),
    );

    const samplePath = runFile(frozen.agent, runId, "sample.json");
    const manifest = await readJson(samplePath);
    const entries = [...(manifest.entries as Record<string, unknown>[])]
      .reverse()
      .map((entry, index) => ({
        ...entry,
        rank: index + 1,
      }));
    const reordered = { ...manifest, entries };
    await writeCanonical(samplePath, reordered);
    await writeCanonical(targetPath, {
      ...target,
      sampleDigest: sampleManifestDigest(reordered as never),
    });
    await assert.rejects(
      runFormalCommand("verify", ["--run-id", runId, "--pi-agent-dir", frozen.agent]),
    );
  });

  it("rejects added or renamed approved sources before re-inventory", async () => {
    const added = await testRoot("source-added");
    await writeFile(join(added.sources, "original.jsonl"), session(1));
    await init("source-added", added.config, added.agent);
    await inventory("source-added", added.agent, added.sources);
    await writeFile(join(added.sources, "added.jsonl"), session(2));
    await assert.rejects(
      runFormalCommand("sample", ["--run-id", "source-added", "--pi-agent-dir", added.agent]),
    );

    const renamed = await testRoot("source-renamed");
    const original = join(renamed.sources, "original.jsonl");
    await writeFile(original, session(1));
    await init("source-renamed", renamed.config, renamed.agent);
    await inventory("source-renamed", renamed.agent, renamed.sources);
    await writeFile(join(renamed.sources, "renamed.jsonl"), await readFile(original));
    await unlink(original);
    await assert.rejects(
      runFormalCommand("sample", ["--run-id", "source-renamed", "--pi-agent-dir", renamed.agent]),
    );
  });

  it("terminalizes expired pending underflow without scanning a refresh", async () => {
    const pending = await testRoot("pending-expiry");
    const endsAt = new Date(Date.now() + 1_000).toISOString();
    await init("pending-expiry", pending.config, pending.agent, endsAt);
    await inventory("pending-expiry", pending.agent, pending.sources);
    const first = await runFormalCommand("sample", [
      "--run-id",
      "pending-expiry",
      "--pi-agent-dir",
      pending.agent,
    ]);
    assert.equal((first as { status: string }).status, "underflow-pending");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(2_000, Math.max(0, Date.parse(endsAt) - Date.now() + 25)));
    });
    await assert.rejects(
      runFormalCommand("verify", ["--run-id", "pending-expiry", "--pi-agent-dir", pending.agent]),
    );
    await assert.rejects(inventory("pending-expiry", pending.agent, join(pending.base, "missing")));
    const terminal = await runFormalCommand("sample", [
      "--run-id",
      "pending-expiry",
      "--pi-agent-dir",
      pending.agent,
    ]);
    assert.equal((terminal as { status: string }).status, "underflow-hard-stop");
    assert.notEqual(
      (terminal as { dispositionDigest: string }).dispositionDigest,
      (first as { dispositionDigest: string }).dispositionDigest,
    );
    const verified = await runFormalCommand("verify", [
      "--run-id",
      "pending-expiry",
      "--pi-agent-dir",
      pending.agent,
    ]);
    assert.equal((verified as { terminal: string }).terminal, "underflow-hard-stop");
    await readFile(
      runFile(pending.agent, "pending-expiry", "sampling/attempt-0-underflow-terminal.json"),
    );
  });

  it("rejects tampered frozen samples before target anchoring", async () => {
    const frozen = await testRoot("target-sample-tamper");
    const runId = "target-sample-tamper";
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(join(frozen.sources, `s-${index}.jsonl`), session(index)),
      ),
    );
    const initialized = await init(runId, frozen.config, frozen.agent);
    const inventoried = await inventory(runId, frozen.agent, frozen.sources);
    await runFormalCommand("sample", ["--run-id", runId, "--pi-agent-dir", frozen.agent]);
    const samplePath = runFile(frozen.agent, runId, "sample.json");
    const manifest = await readJson(samplePath);
    const entries = [...(manifest.entries as Record<string, unknown>[])]
      .reverse()
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
    const tampered = { ...manifest, entries };
    await writeCanonical(samplePath, tampered);
    const targetPath = join(frozen.base, "target.json");
    await writeCanonical(targetPath, {
      stage: "target-selection",
      schemaVersion: 1,
      runId,
      provider: "generated",
      model: "generated",
      api: "generated",
      reasoning: "generated",
      samplingLockDigest: (initialized as { lockDigest: string }).lockDigest,
      inventoryDigest: (inventoried as { inventoryDigest: string }).inventoryDigest,
      sampleDigest: sampleManifestDigest(tampered as never),
      providerPolicyDigest: "c".repeat(64),
    });
    await assert.rejects(
      runFormalCommand("select-target", [
        "--run-id",
        runId,
        "--target",
        targetPath,
        "--pi-agent-dir",
        frozen.agent,
      ]),
    );
  });

  it("inspects every inventory directory entry before accepting an empty sequence", async () => {
    const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["missing-zero", ["attempt-1.json"]],
      ["gap", ["attempt-0.json", "attempt-2.json"]],
      ["numeric-alias", ["attempt-0.json", "attempt-00.json"]],
      ["unexpected", ["unexpected.json"]],
    ];
    for (const [label, files] of cases) {
      const fixture = await testRoot(`attempt-${label}`);
      const runId = `attempt-${label}`;
      await init(runId, fixture.config, fixture.agent);
      const directory = runFile(fixture.agent, runId, "inventory");
      await mkdir(directory);
      await Promise.all(files.map((file) => writeFile(join(directory, file), "{}")));
      await assert.rejects(
        runFormalCommand("sample", ["--run-id", runId, "--pi-agent-dir", fixture.agent]),
      );
    }
    const malformed = await testRoot("attempt-directory");
    await init("attempt-directory", malformed.config, malformed.agent);
    const directory = runFile(malformed.agent, "attempt-directory", "inventory");
    await mkdir(join(directory, "attempt-0.json"), { recursive: true });
    await assert.rejects(
      runFormalCommand("sample", [
        "--run-id",
        "attempt-directory",
        "--pi-agent-dir",
        malformed.agent,
      ]),
    );
  });

  it("resumes a frozen selected-copy set after an interruption following the first descriptor", async () => {
    const resumed = await testRoot("copy-resume");
    const runId = "copy-resume";
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(join(resumed.sources, `s-${index}.jsonl`), session(index)),
      ),
    );
    await init(runId, resumed.config, resumed.agent);
    await inventory(runId, resumed.agent, resumed.sources);
    await runFormalCommand("sample", ["--run-id", runId, "--pi-agent-dir", resumed.agent]);
    await unlink(runFile(resumed.agent, runId, "sample.json"));
    const descriptors = await readdir(runFile(resumed.agent, runId, "copied-session-descriptors"));
    await Promise.all(
      descriptors
        .slice(1)
        .map((name) => unlink(runFile(resumed.agent, runId, `copied-session-descriptors/${name}`))),
    );
    const result = await runFormalCommand("sample", [
      "--run-id",
      runId,
      "--pi-agent-dir",
      resumed.agent,
    ]);
    assert.equal((result as { status: string }).status, "frozen");
    assert.equal(
      (await readdir(runFile(resumed.agent, runId, "copied-session-descriptors"))).length,
      40,
    );
  });
});
