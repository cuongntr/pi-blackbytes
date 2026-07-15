import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalJson } from "../canonical-json.js";
import { atomicManifestWrite, corpusKeyDigest, loadOrCreateCorpusKey } from "../evidence-store.js";
import { createShadowContextHandler } from "../lifecycle/extension.js";
import {
  CANONICAL_PI_PACKAGE,
  LIFECYCLE_EVIDENCE_PATH,
  PI_074_VERSION,
  executeGeneratedScenario,
  parseLifecycleMatrixMetadata,
  runLifecycleMatrix,
  validatePinnedPiInstallation,
} from "../lifecycle/runner.js";
import type {
  LifecycleExecutionRequest,
  LifecycleMatrixMetadata,
  PiInstallationPin,
  PinnedPiInstallation,
} from "../lifecycle/runner.js";
import {
  CONTEXT_HOOK_LOAD_ORDERS,
  LIFECYCLE_SCENARIO_IDS,
  asContextMessages,
  createGeneratedLifecycleScenarios,
  estimateCanonicalModelVisibleTokens,
  observeScenario,
} from "../lifecycle/scenarios.js";
import { ensurePrivateRunRoot, openSafeRun, preManifestRunPath } from "../path-safety.js";
import type { RunManifest } from "../types.js";

let root: string;
let sequence = 0;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeSafeRun() {
  sequence += 1;
  const agentDir = join(root, `agent-${sequence}`);
  const runId = `lifecycle-${sequence}`;
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
  return {
    safeRun: await openSafeRun(agentDir, runId),
    runRoot: preManifestRunPath(preRun),
  };
}

interface InstallationFixture {
  readonly installation: PinnedPiInstallation;
  readonly pin: PiInstallationPin;
  readonly packageBytes: Uint8Array;
  readonly binaryBytes: Uint8Array;
}

function installationFixture(
  id: string,
  version: string,
  packageName = CANONICAL_PI_PACKAGE,
): InstallationFixture {
  const packageBytes = Buffer.from(JSON.stringify({ name: packageName, version }), "utf8");
  const binaryBytes = Buffer.from(`generated-pi-${id}-${version}`, "utf8");
  return {
    installation: {
      id,
      packageManifestPath: `/${id}/package.json`,
      binaryPath: `/${id}/pi`,
    },
    pin: {
      id,
      version,
      packageIntegrityDigest: digest(packageBytes),
      binaryDigest: digest(binaryBytes),
    },
    packageBytes,
    binaryBytes,
  };
}

function matrixFixtures(): readonly [InstallationFixture, InstallationFixture] {
  return [
    installationFixture("pi-074", PI_074_VERSION),
    installationFixture("pi-current", "0.80.6"),
  ];
}

function metadata(
  fixtures: readonly [InstallationFixture, InstallationFixture],
): LifecycleMatrixMetadata {
  return {
    installations: [fixtures[0].installation, fixtures[1].installation],
    protocolPins: [fixtures[0].pin, fixtures[1].pin],
  };
}

function readerFor(fixtures: readonly InstallationFixture[]) {
  const files = new Map<string, Uint8Array>();
  for (const fixture of fixtures) {
    files.set(fixture.installation.packageManifestPath, fixture.packageBytes);
    files.set(fixture.installation.binaryPath, fixture.binaryBytes);
  }
  return {
    readFile: async (path: string): Promise<Uint8Array> => {
      const value = files.get(path);
      if (value === undefined) throw new Error("mock file missing");
      return value;
    },
  };
}

function probeFor(fixtures: readonly InstallationFixture[]) {
  const versions = new Map(
    fixtures.map((fixture) => [fixture.installation.binaryPath, fixture.pin.version]),
  );
  return async (path: string): Promise<string> => {
    const version = versions.get(path);
    if (version === undefined) throw new Error("mock binary missing");
    return version;
  };
}

function runRequest(
  fixtures: readonly [InstallationFixture, InstallationFixture],
  safeRun: Awaited<ReturnType<typeof makeSafeRun>>["safeRun"],
) {
  return {
    ...metadata(fixtures),
    safeRun,
    matrixAttemptId: "attempt-1",
    eventTimestamp: "2026-07-15T00:00:00.000Z",
    reader: readerFor(fixtures),
    probeVersion: probeFor(fixtures),
    executeIsolatedScenario: executeGeneratedScenario,
  } as const;
}

before(() => {
  root = join(tmpdir(), `lifecycle-runner-${randomBytes(8).toString("hex")}`);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("generated lifecycle scenarios", () => {
  it("declares deterministic semantic fixtures and correctly estimated qualifying ranges", () => {
    const scenarios = createGeneratedLifecycleScenarios();
    assert.deepEqual(scenarios, createGeneratedLifecycleScenarios());
    assert.deepEqual(
      scenarios.map((scenario) => scenario.id),
      LIFECYCLE_SCENARIO_IDS,
    );
    assert.deepEqual(CONTEXT_HOOK_LOAD_ORDERS, [
      "shadow-before-transformer",
      "transformer-before-shadow",
    ]);

    for (const scenario of scenarios) {
      const candidate = scenario.candidates[0];
      const sourceIds = scenario.sourceProjections.map((item) => item.sourceEntryId);
      const start = sourceIds.indexOf(candidate.startEntryId);
      const end = sourceIds.indexOf(candidate.endEntryId);
      const calculated = estimateCanonicalModelVisibleTokens(
        canonicalJson(scenario.sourceProjections.slice(start, end + 1).map((item) => item.message)),
      );
      assert.equal(candidate.estimatedTokens, calculated);
      assert.equal(scenario.qualificationEstimatedTokens, calculated);
      assert.ok(calculated >= 2_048);
      assert.match(scenario.sourceDigest, /^[a-f0-9]{64}$/);
      assert.equal(Object.isFrozen(scenario.sourceProjections[0].message), true);
    }

    const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    assert.equal(byId.get("reload")?.operation.kind, "reload");
    const compaction = byId.get("native-compaction")?.operation;
    assert.equal(compaction?.kind, "native-compaction");
    if (compaction?.kind === "native-compaction") assert.ok(compaction.compactedTurnCount > 0);
    const branch = byId.get("branch-fork-tree")?.operation;
    assert.equal(branch?.kind, "branch-fork-tree");
    if (branch?.kind === "branch-fork-tree") {
      assert.ok(branch.topology.some((node) => node.state === "abandoned"));
      assert.equal(
        branch.topology.find((node) => node.branchId === branch.selectedBranchId)?.selected,
        true,
      );
    }
    assert.equal(byId.get("steering-follow-up")?.groundTruth.completeTurns.length, 2);
    const duplicate = byId.get("duplicate-messages")!;
    assert.equal(
      canonicalJson(duplicate.sourceProjections[0].message),
      canonicalJson(duplicate.sourceProjections[1].message),
    );
    assert.deepEqual(duplicate.groundTruth.contextOwners.slice(0, 2), [null, null]);
    const sequential = byId.get("sequential-tool-calls")?.operation;
    assert.equal(sequential?.kind, "sequential-tool-calls");
    if (sequential?.kind === "sequential-tool-calls") {
      assert.equal(sequential.toolCallIds.length, 3);
    }
  });

  it("models both hook orders and leaves transformer-created messages unowned", () => {
    for (const scenario of createGeneratedLifecycleScenarios()) {
      const before = observeScenario(scenario, "shadow-before-transformer");
      const after = observeScenario(scenario, "transformer-before-shadow");
      assert.equal(before.observedMessages.length, scenario.sourceProjections.length);
      assert.equal(after.observedMessages.length, scenario.sourceProjections.length + 1);
      assert.equal(after.groundTruth.contextOwners.at(-1), null);
    }
  });

  it("returns its original context reference through the no-op shadow handler", () => {
    const scenario = createGeneratedLifecycleScenarios()[0];
    const messages = observeScenario(scenario, "shadow-before-transformer").observedMessages;
    const handler = createShadowContextHandler(
      () =>
        ({
          evidence: { ownershipClaims: [], completeTurnClaims: [], completeRangeClaims: [] },
          comparison: {},
        }) as never,
      () => undefined,
    );
    const context = asContextMessages(messages);
    assert.equal(handler({ type: "context", messages: context }).messages, context);
  });
});

describe("pinned installation validation", () => {
  it("separates protocol pins from paths and validates canonical package, bytes, and probe", async () => {
    const fixture = installationFixture("legacy", PI_074_VERSION);
    const valid = await validatePinnedPiInstallation(
      fixture.installation,
      fixture.pin,
      readerFor([fixture]),
      probeFor([fixture]),
    );
    assert.equal(valid.version, PI_074_VERSION);
    assert.equal(valid.packageName, CANONICAL_PI_PACKAGE);
    assert.equal(valid.binaryPath, fixture.installation.binaryPath);

    await assert.rejects(
      () =>
        validatePinnedPiInstallation(
          fixture.installation,
          { ...fixture.pin, binaryDigest: "0".repeat(64) },
          readerFor([fixture]),
          probeFor([fixture]),
        ),
      { code: "E_EVAL_INTEGRITY" },
    );
    await assert.rejects(
      () =>
        validatePinnedPiInstallation(
          fixture.installation,
          fixture.pin,
          readerFor([fixture]),
          async () => "0.74.1",
        ),
      { code: "E_EVAL_INTEGRITY" },
    );
    const wrongPackage = installationFixture("wrong", PI_074_VERSION, "wrong-package");
    await assert.rejects(
      () =>
        validatePinnedPiInstallation(
          wrongPackage.installation,
          wrongPackage.pin,
          readerFor([wrongPackage]),
          probeFor([wrongPackage]),
        ),
      { code: "E_EVAL_INTEGRITY" },
    );
  });

  it("parses exact paired metadata and rejects self-attested or incomplete shapes", () => {
    const fixtures = matrixFixtures();
    const parsed = parseLifecycleMatrixMetadata(metadata(fixtures));
    assert.equal(parsed.protocolPins[0].version, PI_074_VERSION);
    assert.throws(
      () =>
        parseLifecycleMatrixMetadata(
          fixtures.map((fixture) => ({ ...fixture.installation, ...fixture.pin })),
        ),
      { code: "E_EVAL_SCHEMA" },
    );
    assert.throws(
      () =>
        parseLifecycleMatrixMetadata({
          ...metadata(fixtures),
          protocolPins: [fixtures[0].pin, { ...fixtures[1].pin, version: PI_074_VERSION }],
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
  });
});

describe("isolated lifecycle runner", () => {
  it("validates versions before all cells and writes content-free private evidence", async () => {
    const fixtures = matrixFixtures();
    const { safeRun, runRoot } = await makeSafeRun();
    const probeCalls: string[] = [];
    const executorCalls: string[] = [];
    const request = {
      ...runRequest(fixtures, safeRun),
      probeVersion: async (path: string) => {
        probeCalls.push(path);
        return probeFor(fixtures)(path);
      },
      executeIsolatedScenario: async (cell: LifecycleExecutionRequest) => {
        assert.equal(probeCalls.length, 2);
        executorCalls.push(cell.cellId);
        assert.equal(Object.isFrozen(cell.scenario), true);
        assert.equal(Object.isFrozen(cell.scenario.operation), true);
        return executeGeneratedScenario(cell);
      },
    };
    const results = await runLifecycleMatrix(request);

    assert.equal(
      results.length,
      2 * LIFECYCLE_SCENARIO_IDS.length * CONTEXT_HOOK_LOAD_ORDERS.length,
    );
    assert.equal(new Set(executorCalls).size, results.length);
    assert.ok(results.every((result) => result.pass));
    assert.ok(results.every((result) => result.coverage.messageCoverage.coverage > 0));
    assert.ok(results.every((result) => result.environmentDigest.length === 64));

    const events = await readFile(join(runRoot, LIFECYCLE_EVIDENCE_PATH), "utf8");
    assert.equal(events.trimEnd().split("\n").length, results.length);
    assert.equal(events.includes("lifecycle fixture material"), false);
    assert.equal(events.includes(fixtures[0].installation.packageManifestPath), false);
    const event = JSON.parse(events.split("\n")[0]) as { data: Record<string, unknown> };
    assert.deepEqual(Object.keys(event.data).sort(), [
      "claims",
      "copyDigest",
      "coverage",
      "environmentDigest",
      "installationId",
      "loadOrder",
      "matrixAttemptId",
      "pass",
      "piVersion",
      "scenarioId",
      "sourceDigest",
    ]);
  });

  it("is idempotent when the explicit attempt identity and timestamp are reused", async () => {
    const fixtures = matrixFixtures();
    const { safeRun, runRoot } = await makeSafeRun();
    const request = runRequest(fixtures, safeRun);
    const first = await runLifecycleMatrix(request);
    const second = await runLifecycleMatrix(request);
    assert.deepEqual(second, first);
    const events = await readFile(join(runRoot, LIFECYCLE_EVIDENCE_PATH), "utf8");
    assert.equal(events.trimEnd().split("\n").length, first.length);
  });

  it("fails before the executor when a digest or version probe is wrong", async () => {
    const fixtures = matrixFixtures();
    const { safeRun } = await makeSafeRun();
    let invoked = false;
    await assert.rejects(
      () =>
        runLifecycleMatrix({
          ...runRequest(fixtures, safeRun),
          protocolPins: [fixtures[0].pin, { ...fixtures[1].pin, binaryDigest: "f".repeat(64) }],
          executeIsolatedScenario: async (cell) => {
            invoked = true;
            return executeGeneratedScenario(cell);
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
    assert.equal(invoked, false);

    await assert.rejects(
      () =>
        runLifecycleMatrix({
          ...runRequest(fixtures, safeRun),
          probeVersion: async (path) =>
            path === fixtures[1].installation.binaryPath ? "0.81.0" : PI_074_VERSION,
          executeIsolatedScenario: async (cell) => {
            invoked = true;
            return executeGeneratedScenario(cell);
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
    assert.equal(invoked, false);
  });

  it("rejects reused isolation identities and wrong child versions", async () => {
    const fixtures = matrixFixtures();
    const firstRun = await makeSafeRun();
    await assert.rejects(
      () =>
        runLifecycleMatrix({
          ...runRequest(fixtures, firstRun.safeRun),
          executeIsolatedScenario: async (cell) => {
            const result = await executeGeneratedScenario(cell);
            return {
              ...result,
              childEnvironment: { ...result.childEnvironment, isolationId: "reused-child" },
            };
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );

    const secondRun = await makeSafeRun();
    await assert.rejects(
      () =>
        runLifecycleMatrix({
          ...runRequest(fixtures, secondRun.safeRun),
          executeIsolatedScenario: async (cell) => {
            const result = await executeGeneratedScenario(cell);
            return {
              ...result,
              childEnvironment: { ...result.childEnvironment, piVersion: "9.9.9" },
            };
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
  });

  it("accepts an explicit copied-scenario set and protects its full oracle contract", async () => {
    const fixtures = matrixFixtures();
    const { safeRun } = await makeSafeRun();
    const scenarios = structuredClone(createGeneratedLifecycleScenarios());
    let mutationBlocked = false;
    const results = await runLifecycleMatrix({
      ...runRequest(fixtures, safeRun),
      scenarios,
      executeIsolatedScenario: async (cell) => {
        try {
          (cell.scenario.operation as { kind: string }).kind = "mutated";
        } catch {
          mutationBlocked = true;
        }
        return executeGeneratedScenario(cell);
      },
    });
    assert.equal(mutationBlocked, true);
    assert.equal(results.length, 24);
  });

  it("rejects fabricated qualification estimates before execution", async () => {
    const fixtures = matrixFixtures();
    const { safeRun } = await makeSafeRun();
    const scenarios = structuredClone(createGeneratedLifecycleScenarios());
    (scenarios[0].candidates[0] as { estimatedTokens: number }).estimatedTokens += 1;
    let invoked = false;
    await assert.rejects(
      () =>
        runLifecycleMatrix({
          ...runRequest(fixtures, safeRun),
          scenarios,
          executeIsolatedScenario: async (cell) => {
            invoked = true;
            return executeGeneratedScenario(cell);
          },
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
    assert.equal(invoked, false);
  });

  it("does not import lifecycle evaluation code from production entry points", async () => {
    const productionIndex = await readFile("src/index.ts", "utf8");
    assert.equal(productionIndex.includes("context-pruning/lifecycle"), false);
  });
});
