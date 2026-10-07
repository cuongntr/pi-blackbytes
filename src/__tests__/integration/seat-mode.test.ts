import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { bootstrap } from "../../bootstrap.js";
import { handleBlackbytesStatus } from "../../commands/blackbytes-status.js";
import { _resetEnabledSet, getEnabledSet } from "../../config/enabled-set.js";
import { clearConfigCache } from "../../config/loader.js";
import { _resetSubAgentRegistry } from "../../config/resource-metadata.js";
import { captureArtifact, cleanupArtifacts } from "../../sub-agents/artifacts.js";
import { _resetPiAvailability, checkPiAvailability } from "../../sub-agents/pi-availability.js";
import type { SpawnFn } from "../../sub-agents/runner.js";
import { runNestedPi } from "../../sub-agents/runner.js";
import { createMockPi } from "../../test-utils/pi-mock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = ["PASEO_ROOM_ROLE", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "HOME"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const savedEnv: Partial<Record<EnvKey, string | undefined>> = {};

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitForEnabledSet(timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      getEnabledSet();
      return;
    } catch {
      await new Promise<void>((r) => setTimeout(r, 20));
    }
  }
  throw new Error("Timed out waiting for EnabledSet to be initialized");
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else out.push(full);
  }
  return out;
}

const YAML_AGENT = `
name: yaml-helper
description: A YAML-defined helper agent
system_prompt: You are a helper.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: seat mode (PASEO_ROOM_ROLE set)", () => {
  let seatDir: string;
  let fakeHome: string;

  before(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    seatDir = await makeTempDir("pi-blackbytes-seat-");
    fakeHome = await makeTempDir("pi-blackbytes-fakehome-");
    // Put a YAML sub-agent in the seat dir to prove it is NOT registered.
    await fs.mkdir(path.join(seatDir, "sub-agents"), { recursive: true });
    await fs.writeFile(path.join(seatDir, "sub-agents", "yaml-helper.yaml"), YAML_AGENT, "utf8");
    await fs.writeFile(
      path.join(seatDir, "settings.json"),
      JSON.stringify({ blackbytes: { disabled_tools: ["glob"] } }),
      "utf8",
    );
  });

  after(async () => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(seatDir, { recursive: true, force: true });
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetEnabledSet();
    _resetSubAgentRegistry();
    _resetPiAvailability();
    clearConfigCache();
    process.env.PASEO_ROOM_ROLE = "lead";
    process.env.PI_CODING_AGENT_DIR = seatDir;
    delete process.env.PI_AGENT_DIR;
    // Point HOME at an empty temp dir so any accidental ~/.pi access is detectable.
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    _resetEnabledSet();
    _resetSubAgentRegistry();
    _resetPiAvailability();
    clearConfigCache();
  });

  it("registers no delegate_* tool, even with a YAML agent present", async () => {
    const mock = createMockPi();
    bootstrap(mock);
    mock.emit("session_start", {});
    await waitForEnabledSet();

    const toolNames = mock.calls.registerTool.map((t) => (t as { name: string }).name);
    const delegates = toolNames.filter((n) => n.startsWith("delegate_"));
    assert.deepEqual(delegates, [], `expected no delegate tools, got ${delegates.join(", ")}`);
    assert.ok(!toolNames.includes("delegate_yaml-helper"));
    assert.ok(!toolNames.includes("delegate_general"));
    assert.ok(!toolNames.includes("delegate_explore"));

    // Non-agent tools remain registered and disabled_tools still works.
    assert.ok(toolNames.includes("hashline_edit"), "hashline_edit still registered");
    assert.ok(toolNames.includes("web_search"), "web_search still registered");
    assert.ok(toolNames.includes("ast_search"), "ast_search still registered");
    assert.ok(toolNames.includes("look_at"), "look_at still registered");
    const enabled = getEnabledSet();
    assert.equal(enabled.tools.has("glob"), false, "disabled_tools honoured");
    assert.equal(enabled.subAgents.size, 0, "no sub-agents enabled");
  });

  it("before_agent_start returns undefined and leaves the prompt untouched", async () => {
    const mock = createMockPi();
    bootstrap(mock);
    mock.emit("session_start", {});
    await waitForEnabledSet();

    const reg = mock.calls.on.find((c) => c.event === "before_agent_start");
    assert.ok(reg, "before_agent_start registered");
    const original = "Host system prompt.";
    const event = { systemPrompt: original };
    const result = await reg.handler(event, { model: { id: "claude-opus-4" }, cwd: seatDir });
    assert.equal(result, undefined, "handler must return undefined in seat mode");
    assert.equal(event.systemPrompt, original, "event prompt not mutated");
    assert.ok(!event.systemPrompt.includes("Bytes"));
    assert.ok(!event.systemPrompt.includes("Available agents"));
    assert.ok(!event.systemPrompt.includes("pi-blackbytes:resources"));
  });

  it("never spawns a nested pi: runner, chain entry, and availability probe", async () => {
    let spawnCalls = 0;
    const spawnFn: SpawnFn = () => {
      spawnCalls++;
      throw new Error("spawn must not be called in seat mode");
    };
    const result = await runNestedPi(
      { systemPrompt: "s", userPrompt: "u", allowedTools: ["read"] },
      spawnFn,
    );
    assert.equal(spawnCalls, 0);
    assert.equal(result.success, false);
    assert.match(result.content, /seat mode/);

    let probeCalls = 0;
    const probe = await checkPiAvailability(async () => {
      probeCalls++;
      return { available: true };
    });
    assert.equal(probeCalls, 0, "availability probe must not run");
    assert.equal(probe.status, "unknown");
  });

  it("does not write or clean artifacts", async () => {
    const removed = await cleanupArtifacts();
    assert.equal(removed, 0);
    const captured = await captureArtifact({
      agent: "explore",
      content: "x".repeat(10_000),
      startedAt: Date.now(),
      durationMs: 1,
    });
    assert.equal(captured, undefined);
    const artifactsDir = path.join(seatDir, "blackbytes");
    await assert.rejects(fs.access(artifactsDir), "no artifacts directory created");
  });

  it("reads only the seat dir, never ~/.pi/agent, and writes nothing outside it", async () => {
    // Decoy: a ~/.pi/agent/settings.json under the fake HOME that disables look_at
    // and a decoy YAML agent. If either were read, the assertions below would fail.
    const decoyAgentDir = path.join(fakeHome, ".pi", "agent");
    await fs.mkdir(path.join(decoyAgentDir, "sub-agents"), { recursive: true });
    const decoySettings = path.join(decoyAgentDir, "settings.json");
    const decoyYaml = path.join(decoyAgentDir, "sub-agents", "decoy.yaml");
    await fs.writeFile(
      decoySettings,
      JSON.stringify({ blackbytes: { disabled_tools: ["look_at"] } }),
      "utf8",
    );
    await fs.writeFile(decoyYaml, YAML_AGENT.replace("yaml-helper", "decoy"), "utf8");
    const before = (await listFilesRecursive(fakeHome)).sort();
    assert.deepEqual(before, [decoySettings, decoyYaml].sort());

    const mock = createMockPi();
    bootstrap(mock);
    mock.emit("session_start", {});
    await waitForEnabledSet();

    // Config came from the seat dir (disabled_tools: ["glob"] is only there),
    // not from the decoy under HOME (which would have disabled look_at).
    const enabled = getEnabledSet();
    assert.equal(enabled.tools.has("glob"), false, "seat settings.json was read");
    assert.equal(
      enabled.tools.has("look_at"),
      true,
      "decoy ~/.pi/agent/settings.json was NOT read",
    );
    const toolNames = mock.calls.registerTool.map((t) => (t as { name: string }).name);
    assert.ok(!toolNames.includes("delegate_decoy"), "decoy YAML agent was NOT loaded");

    const shutdown = mock.calls.on.find((c) => c.event === "session_shutdown");
    assert.ok(shutdown);
    await shutdown.handler({}, { cwd: seatDir });

    // Nothing new under the fake HOME (no ~/.pi/logs, no artifacts).
    const after = (await listFilesRecursive(fakeHome)).sort();
    assert.deepEqual(after, before, `unexpected files under HOME: ${after.join(", ")}`);
    await assert.rejects(fs.access(path.join(fakeHome, ".pi", "logs")));
  });

  it("/blackbytes-status reports seat mode and what is disabled", async () => {
    const mock = createMockPi();
    bootstrap(mock);
    mock.emit("session_start", {});
    await waitForEnabledSet();

    const out = await handleBlackbytesStatus();
    assert.ok(out.includes("seat mode (role=lead)"), out);
    assert.ok(out.includes("Disabled in seat mode:"));
    assert.ok(out.includes("delegate_*"));
    assert.ok(out.includes(seatDir), "agent dir shown");
  });
});
