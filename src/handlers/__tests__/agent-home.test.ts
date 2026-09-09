import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, mock } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveStartupAgentHome } from "../../shared/agent-home.js";
import { getLogger } from "../../shared/logger.js";
import {
  getAgentHome,
  initSessionAgentHome,
  resetSessionRuntimeState,
} from "../../shared/session-state.js";
import { createMockPi } from "../../test-utils/pi-mock.js";
import { handleSessionStart } from "../index.js";

it("snapshots before asynchronous startup; env and child cwd changes wait until reload", async () => {
  const originalCwd = process.cwd();
  const originalOfficial = process.env.PI_CODING_AGENT_DIR;
  const originalLegacy = process.env.PI_AGENT_DIR;
  const dir = await mkdtemp(join(tmpdir(), "agent-home-session-"));
  const warnings = mock.method(getLogger(), "warn", () => {});
  const ctx = { cwd: dir, hasUI: false } as ExtensionContext;
  const pi = createMockPi();
  try {
    // Existing consumers remain legacy-based in this bead. Keep their IO in a
    // temporary home; selected-home IO adoption is deliberately not asserted.
    await writeFile(join(dir, "settings.json"), JSON.stringify({ blackbytes: {} }));
    process.env.PI_AGENT_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = "first-home";
    resetSessionRuntimeState();
    const before = getAgentHome();
    assert.equal(before.path, resolve(originalCwd, "first-home"));
    process.chdir(dir);
    assert.deepEqual(resolveStartupAgentHome(), before);
    process.env.PI_CODING_AGENT_DIR = "startup-home";
    const startup = handleSessionStart(pi, { type: "session_start", reason: "startup" }, ctx);
    const snapshot = getAgentHome();
    assert.equal(snapshot.path, resolve(originalCwd, "startup-home"));
    assert.equal(snapshot.source, "PI_CODING_AGENT_DIR");
    process.env.PI_CODING_AGENT_DIR = "reload-home";
    await startup;
    assert.strictEqual(getAgentHome(), snapshot);
    assert.strictEqual(initSessionAgentHome(), snapshot);
    assert.equal(process.env.PI_CODING_AGENT_DIR, "reload-home");
    assert.equal(process.env.PI_AGENT_DIR, dir);
    assert.equal(
      warnings.mock.calls.filter((call) => call.arguments[0] === snapshot.diagnostic).length,
      1,
    );

    await handleSessionStart(pi, { type: "session_start", reason: "reload" }, ctx);
    assert.equal(getAgentHome().path, resolve(originalCwd, "reload-home"));
    assert.notStrictEqual(getAgentHome(), snapshot);
    assert.equal(
      warnings.mock.calls.filter((call) => call.arguments[0] === snapshot.diagnostic).length,
      2,
    );
    for (const call of warnings.mock.calls) {
      if (call.arguments[0] === snapshot.diagnostic) assert.equal(call.arguments.length, 1);
    }
    // A partially failed startup must not poison the next startup snapshot.
    const failedPi = createMockPi();
    failedPi.registerTool = () => {
      throw new Error("fixture registration failure");
    };
    process.env.PI_CODING_AGENT_DIR = "failed-home";
    await assert.rejects(
      handleSessionStart(failedPi, { type: "session_start", reason: "reload" }, ctx),
      /fixture registration failure/,
    );
    process.env.PI_CODING_AGENT_DIR = "recovered-home";
    await handleSessionStart(pi, { type: "session_start", reason: "reload" }, ctx);
    assert.equal(getAgentHome().path, resolve(originalCwd, "recovered-home"));

    // Reset clears the snapshot, not the startup cwd.
    process.env.PI_CODING_AGENT_DIR = "after-reset";
    resetSessionRuntimeState();
    resetSessionRuntimeState();
    assert.equal(getAgentHome().path, resolve(originalCwd, "after-reset"));
  } finally {
    warnings.mock.restore();
    process.chdir(originalCwd);
    if (originalOfficial === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalOfficial;
    if (originalLegacy === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = originalLegacy;
    resetSessionRuntimeState();
    await rm(dir, { recursive: true, force: true });
  }
});
