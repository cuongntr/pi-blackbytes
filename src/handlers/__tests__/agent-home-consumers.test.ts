import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getEnabledSet } from "../../config/enabled-set.js";
import { clearConfigCache, loadBlackbytesConfig } from "../../config/loader.js";
import { getAgentHomeGuidance } from "../../shared/agent-home-guidance.js";
import { getLogger } from "../../shared/logger.js";
import { getAgentHome, resetSessionRuntimeState } from "../../shared/session-state.js";
import { createMockPi } from "../../test-utils/pi-mock.js";
import { handleSessionStart } from "../index.js";

it("session startup refreshes same-home settings inside the production cache TTL", async () => {
  const official = process.env.PI_CODING_AGENT_DIR;
  const legacy = process.env.PI_AGENT_DIR;
  const nodeEnv = process.env.NODE_ENV;
  const dir = await mkdtemp(join(tmpdir(), "bb-home-cache-"));
  // Freeze the cache clock so the regression cannot pass through TTL expiry.
  const clock = mock.method(Date, "now", () => 1_000_000);
  const ctx = { cwd: dir, hasUI: false } as ExtensionContext;
  try {
    process.env.NODE_ENV = "production";
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_AGENT_DIR = dir;
    await writeFile(join(dir, "settings.json"), JSON.stringify({ blackbytes: {} }));
    await handleSessionStart(createMockPi(), { type: "session_start", reason: "startup" }, ctx);
    const original = await loadBlackbytesConfig();
    assert.ok(getEnabledSet().tools.has("web_search"));

    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ blackbytes: { disabled_tools: ["web_search"] } }),
    );
    // Prove the real cache remains warm and serves stale data within a session.
    assert.equal(await loadBlackbytesConfig(), original);
    await handleSessionStart(createMockPi(), { type: "session_start", reason: "reload" }, ctx);
    assert.deepEqual((await loadBlackbytesConfig()).disabled_tools, ["web_search"]);
    assert.ok(!getEnabledSet().tools.has("web_search"));
  } finally {
    clock.mock.restore();
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    if (official === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = official;
    if (legacy === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = legacy;
    clearConfigCache();
    resetSessionRuntimeState();
    await rm(dir, { recursive: true, force: true });
  }
});

it("startup surfaces bounded legacy/conflict restart guidance without loading parent credentials", async () => {
  const official = process.env.PI_CODING_AGENT_DIR;
  const legacy = process.env.PI_AGENT_DIR;
  const dir = await mkdtemp(join(tmpdir(), "bb-home-guidance-"));
  const warnings = mock.method(getLogger(), "warn", () => {});
  const notifications: string[] = [];
  const ctx = {
    cwd: dir,
    hasUI: true,
    ui: { notify: (text: string) => notifications.push(text), setWidget: () => {} },
    get modelRegistry() {
      throw new Error("must not access parent registry");
    },
  } as unknown as ExtensionContext;
  try {
    for (const conflict of [false, true]) {
      process.env.PI_AGENT_DIR = dir;
      if (conflict) process.env.PI_CODING_AGENT_DIR = join(dir, "official");
      else delete process.env.PI_CODING_AGENT_DIR;
      await handleSessionStart(createMockPi(), { type: "session_start", reason: "startup" }, ctx);
      const guidance = getAgentHomeGuidance(getAgentHome());
      assert.ok(guidance);
      assert.equal(notifications.at(-1), guidance);
      assert.equal(warnings.mock.calls.filter((call) => call.arguments[0] === guidance).length, 1);
      assert.ok(guidance.length < 400);
      assert.ok(!guidance.includes(dir));
    }
    assert.equal(notifications.length, 2);
  } finally {
    warnings.mock.restore();
    if (official === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = official;
    if (legacy === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = legacy;
    resetSessionRuntimeState();
    await rm(dir, { recursive: true, force: true });
  }
});
