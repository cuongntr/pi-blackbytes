import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import { parseBlackbytesConfig } from "../../config/schema.js";
import { type StatusInteractiveCtx, handleBlackbytesStatus } from "../blackbytes-status.js";

async function makeTempAgentDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "blackbytes-status-test-"));
}

async function writeSettings(agentDir: string, blackbytes: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ blackbytes }, null, 2),
    "utf8",
  );
}

describe("handleBlackbytesStatus", () => {
  let tmpDir: string;
  const originalAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(async () => {
    tmpDir = await makeTempAgentDir();
    process.env.PI_AGENT_DIR = tmpDir;
    _resetEnabledSet();
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = originalAgentDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
    _resetEnabledSet();
  });

  it("returns init message when EnabledSet is not initialized", async () => {
    const out = await handleBlackbytesStatus();
    assert.match(out, /Blackbytes not initialized/);
  });

  it("renders 'Reserved / Unsupported Settings: None.' when no reserved fields configured", async () => {
    await writeSettings(tmpDir, {});
    const cfg = parseBlackbytesConfig({});
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);

    const out = await handleBlackbytesStatus();
    assert.match(out, /### Reserved \/ Unsupported Settings/);
    assert.match(out, /_None\._/);
    // No spurious temperature mention.
    assert.ok(!/temperature/i.test(out), "should not mention temperature when unset");
  });

  it("surfaces configured per-agent temperature as reserved/unsupported", async () => {
    const blackbytes = {
      sub_agents: {
        oracle: { model: "claude-opus-4-5", temperature: 0.42 },
        explore: { temperature: 0.1 },
      },
    };
    await writeSettings(tmpDir, blackbytes);
    const cfg = parseBlackbytesConfig(blackbytes);
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);

    const out = await handleBlackbytesStatus();

    assert.match(out, /### Reserved \/ Unsupported Settings/);
    assert.match(out, /NOT yet supported by the nested Pi CLI/);
    assert.match(out, /`sub_agents\.oracle\.temperature` = 0\.42/);
    assert.match(out, /`sub_agents\.explore\.temperature` = 0\.1/);
    assert.match(out, /reserved — not passed to nested Pi/);
  });

  it("does not list non-reserved fields (model, reasoningEffort) as reserved", async () => {
    const blackbytes = {
      sub_agents: {
        oracle: { model: "claude-opus-4-5", reasoningEffort: "high" },
      },
    };
    await writeSettings(tmpDir, blackbytes);
    const cfg = parseBlackbytesConfig(blackbytes);
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);

    const out = await handleBlackbytesStatus();
    assert.match(out, /### Reserved \/ Unsupported Settings\n_None\._/);
  });
});

describe("handleBlackbytesStatus snapshot section", () => {
  let tmpDir: string;
  const originalAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(async () => {
    tmpDir = await makeTempAgentDir();
    process.env.PI_AGENT_DIR = tmpDir;
    _resetEnabledSet();
    const { _resetAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    _resetAgentSnapshot();
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = originalAgentDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
    _resetEnabledSet();
    const { _resetAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    _resetAgentSnapshot();
  });

  it("renders the Sub-Agent Snapshot section once initialized", async () => {
    const blackbytes = {
      sub_agents: {
        oracle: { model: "claude-opus-4-5", temperature: 0.5 },
      },
    };
    await writeSettings(tmpDir, blackbytes);
    const cfg = parseBlackbytesConfig(blackbytes);
    assert.ok(cfg.ok);
    if (!cfg.ok) return;
    initEnabledSet(cfg.value);

    const { defineSubAgent } = await import("../../sub-agents/declaration.js");
    const { initAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    const { Type } = await import("typebox");
    const oracleDecl = defineSubAgent({
      name: "oracle",
      toolName: "delegate_oracle",
      description: "x",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read"],
      source: "builtin",
      buildUserPrompt: (p: { q: string }) => p.q,
    });
    initAgentSnapshot([oracleDecl], cfg.value);

    const out = await handleBlackbytesStatus();
    assert.match(out, /### Sub-Agent Snapshot/);
    assert.match(out, /Resolved at session_start; immutable for the life of this session/);
    assert.match(out, /oracle/);
    assert.match(out, /claude-opus-4-5/);
    // Reserved temperature still surfaced under reserved section, sourced from snapshot.
    assert.match(out, /`sub_agents\.oracle\.temperature` = 0\.5/);
  });
});

describe("handleBlackbytesStatus YAML diagnostics section", () => {
  let tmpDir: string;
  const originalAgentDir = process.env.PI_AGENT_DIR;

  async function writeYaml(filename: string, content: string): Promise<void> {
    const subAgentsDir = path.join(tmpDir, "sub-agents");
    await fs.mkdir(subAgentsDir, { recursive: true });
    await fs.writeFile(path.join(subAgentsDir, filename), content, "utf8");
  }

  function validYaml(name: string): string {
    return `name: ${name}\ndescription: "Test agent"\nsystem_prompt: "You are a test agent."\n`;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bs-yaml-test-"));
    process.env.PI_AGENT_DIR = tmpDir;
    _resetEnabledSet();
    const { _resetAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    const { _resetYamlDiagnostics } = await import("../../sub-agents/diagnostics.js");
    _resetAgentSnapshot();
    _resetYamlDiagnostics();
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = originalAgentDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
    _resetEnabledSet();
    const { _resetAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    const { _resetYamlDiagnostics } = await import("../../sub-agents/diagnostics.js");
    _resetAgentSnapshot();
    _resetYamlDiagnostics();
  });

  it("shows 'no YAML diagnostics' message when session_start has not run", async () => {
    const cfg = parseBlackbytesConfig({});
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);

    const out = await handleBlackbytesStatus();
    assert.match(out, /### YAML Sub-Agents/);
    assert.match(out, /No YAML diagnostics available/);
  });

  it("shows loaded and skipped YAML agents after simulated session_start", async () => {
    // Set up: one valid YAML and one invalid YAML
    await writeYaml("valid-agent.yaml", validYaml("valid-agent"));
    await writeYaml("bad.yaml", "name: [\ninvalid yaml");

    const cfg = parseBlackbytesConfig({});
    assert.ok(cfg.ok);
    if (!cfg.ok) return;

    // Simulate session_start: load config, builtins unique assert, load yaml with diagnostics
    const { assertUniqueNames } = await import("../../sub-agents/validate-unique.js");
    const { loadYamlDeclarations } = await import("../../sub-agents/loader.js");
    const { setYamlDiagnostics } = await import("../../sub-agents/diagnostics.js");
    const { initAgentSnapshot } = await import("../../sub-agents/snapshot.js");

    const builtinNames = ["explore", "oracle", "librarian", "general"];
    assertUniqueNames(builtinNames);
    const { declarations, diagnostics } = await loadYamlDeclarations(builtinNames);
    setYamlDiagnostics(diagnostics);
    initEnabledSet(cfg.value, [...builtinNames, ...declarations.map((d) => d.name)]);
    initAgentSnapshot(declarations, cfg.value);

    const out = await handleBlackbytesStatus();

    // YAML section present
    assert.match(out, /### YAML Sub-Agents/);
    // loaded valid agent appears
    assert.match(out, /valid-agent/);
    // skipped file appears
    assert.match(out, /bad\.yaml/);
    assert.match(out, /YAML syntax error/);
    // system_prompt must NOT be shown
    assert.ok(!out.includes("system_prompt"), "system_prompt must not appear in output");
    // pending note in snapshot section
    assert.match(out, /changes will take effect on the next session_start/);
  });

  it("status output does not change after disk mutation (reads active session snapshot)", async () => {
    await writeYaml("stable.yaml", validYaml("stable-agent"));

    const cfg = parseBlackbytesConfig({});
    assert.ok(cfg.ok);
    if (!cfg.ok) return;

    const { assertUniqueNames } = await import("../../sub-agents/validate-unique.js");
    const { loadYamlDeclarations } = await import("../../sub-agents/loader.js");
    const { setYamlDiagnostics } = await import("../../sub-agents/diagnostics.js");
    const { initAgentSnapshot } = await import("../../sub-agents/snapshot.js");

    const builtinNames = ["explore", "oracle", "librarian", "general"];
    assertUniqueNames(builtinNames);
    const { declarations, diagnostics } = await loadYamlDeclarations(builtinNames);
    setYamlDiagnostics(diagnostics);
    initEnabledSet(cfg.value, [...builtinNames, ...declarations.map((d) => d.name)]);
    initAgentSnapshot(declarations, cfg.value);

    const outBefore = await handleBlackbytesStatus();
    assert.match(outBefore, /stable-agent/);

    // Mutate disk: overwrite the YAML with a different agent name
    await writeYaml("stable.yaml", validYaml("different-agent"));

    // Status must still show stable-agent (snapshot frozen at session_start)
    const outAfter = await handleBlackbytesStatus();
    assert.match(outAfter, /stable-agent/);
    assert.ok(
      !outAfter.includes("different-agent"),
      "disk change must not affect active session output",
    );
  });
});

// ---------------------------------------------------------------------------
// Diagnostics section tests
// ---------------------------------------------------------------------------

describe("handleBlackbytesStatus diagnostics section", () => {
  let tmpDir: string;
  const originalAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(async () => {
    tmpDir = await makeTempAgentDir();
    process.env.PI_AGENT_DIR = tmpDir;
    _resetEnabledSet();
    const { _resetAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    const { _resetYamlDiagnostics } = await import("../../sub-agents/diagnostics.js");
    const { resetDelegationLog } = await import("../../sub-agents/delegation-log.js");
    _resetAgentSnapshot();
    _resetYamlDiagnostics();
    resetDelegationLog();
    const { _resetPiAvailability } = await import("../../sub-agents/pi-availability.js");
    _resetPiAvailability();
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = originalAgentDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
    _resetEnabledSet();
    const { _resetAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    const { _resetYamlDiagnostics } = await import("../../sub-agents/diagnostics.js");
    const { resetDelegationLog } = await import("../../sub-agents/delegation-log.js");
    _resetAgentSnapshot();
    _resetYamlDiagnostics();
    resetDelegationLog();
    const { _resetPiAvailability } = await import("../../sub-agents/pi-availability.js");
    _resetPiAvailability();
  });

  it("renders diagnostics section with healthy state (all agents enabled, no failures)", async () => {
    const config = {
      sub_agents: {
        oracle: {
          model: "claude-opus-4-5",
          timeoutMs: 120000,
          fallbackModels: ["claude-sonnet-4-20250514"],
        },
        explore: { model: "claude-sonnet-4-20250514", timeoutMs: 60000 },
      },
    };
    await writeSettings(tmpDir, config);
    const cfg = parseBlackbytesConfig(config);
    assert.ok(cfg.ok);
    if (!cfg.ok) return;
    initEnabledSet(cfg.value);

    const { defineSubAgent } = await import("../../sub-agents/declaration.js");
    const { initAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    const { Type } = await import("typebox");
    const { logDelegation } = await import("../../sub-agents/delegation-log.js");
    const { checkPiAvailability } = await import("../../sub-agents/pi-availability.js");

    const oracleDecl = defineSubAgent({
      name: "oracle",
      toolName: "delegate_oracle",
      description: "Oracle agent",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "You are Oracle.",
      allowedTools: ["read"],
      source: "builtin",
      buildUserPrompt: (p: { q: string }) => p.q,
    });
    const exploreDecl = defineSubAgent({
      name: "explore",
      toolName: "delegate_explore",
      description: "Explore agent",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "You are Explore.",
      allowedTools: ["read"],
      source: "builtin",
      buildUserPrompt: (p: { q: string }) => p.q,
    });
    initAgentSnapshot([oracleDecl, exploreDecl], cfg.value);

    // Add successful delegations so success rate shows
    logDelegation({
      agent: "oracle",
      startedAt: Date.now() - 10000,
      durationMs: 5000,
      success: true,
      toolCallCount: 3,
      outputChars: 500,
    });
    logDelegation({
      agent: "explore",
      startedAt: Date.now() - 5000,
      durationMs: 2000,
      success: true,
      toolCallCount: 1,
      outputChars: 100,
    });

    // Set Pi availability cache
    await checkPiAvailability(async () => ({ available: true }));

    const out = await handleBlackbytesStatus();

    assert.match(out, /### Sub-Agent Diagnostics/);
    assert.match(out, /Nested Pi CLI.*✓.*available/);
    assert.match(out, /Agents.*2\/2 enabled/);
    assert.match(out, /✓ oracle/);
    assert.match(out, /✓ explore/);
    assert.match(out, /120000ms/);
    assert.match(out, /60000ms/);
    assert.match(out, /1 fallback/);
    assert.match(out, /Success rate.*100%.*2 delegations/);
    assert.ok(!out.includes("Recent failures"), "should not show failures section when none");
    assert.ok(!out.includes("YAML warnings"), "should not show YAML warnings when none");
  });

  it("renders diagnostics section with failures grouped by kind", async () => {
    const config = {
      sub_agents: {
        oracle: { model: "claude-opus-4-5" },
      },
    };
    await writeSettings(tmpDir, config);
    const cfg = parseBlackbytesConfig(config);
    assert.ok(cfg.ok);
    if (!cfg.ok) return;
    initEnabledSet(cfg.value);

    const { defineSubAgent } = await import("../../sub-agents/declaration.js");
    const { initAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    const { Type } = await import("typebox");
    const { logDelegation } = await import("../../sub-agents/delegation-log.js");
    const { checkPiAvailability } = await import("../../sub-agents/pi-availability.js");

    const oracleDecl = defineSubAgent({
      name: "oracle",
      toolName: "delegate_oracle",
      description: "x",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read"],
      source: "yaml",
      buildUserPrompt: (p: { q: string }) => p.q,
    });
    initAgentSnapshot([oracleDecl], cfg.value);

    // 2 timed_out + 1 spawn_error
    logDelegation({
      agent: "oracle",
      startedAt: Date.now() - 30000,
      durationMs: 300000,
      success: false,
      toolCallCount: 0,
      outputChars: 0,
      failureKind: "timed_out",
      errorHint: "Timeout after 300s",
    });
    logDelegation({
      agent: "oracle",
      startedAt: Date.now() - 20000,
      durationMs: 300000,
      success: false,
      toolCallCount: 0,
      outputChars: 0,
      failureKind: "timed_out",
      errorHint: "Timeout after 300s",
    });
    logDelegation({
      agent: "oracle",
      startedAt: Date.now() - 10000,
      durationMs: 0,
      success: false,
      toolCallCount: 0,
      outputChars: 0,
      failureKind: "spawn_error",
      errorHint: "pi CLI not found",
    });

    await checkPiAvailability(async () => ({ available: true }));

    const out = await handleBlackbytesStatus();

    assert.match(out, /### Sub-Agent Diagnostics/);
    assert.match(out, /timed_out: 2x/);
    assert.match(out, /spawn_error: 1x/);
    assert.match(out, /Timeout after 300s/);
    assert.match(out, /pi CLI not found/);
    assert.match(out, /Success rate.*0%.*3 delegations/);
  });

  it("renders diagnostics section with Pi unavailable", async () => {
    const config = {
      sub_agents: {
        oracle: { model: "claude-opus-4-5" },
      },
    };
    await writeSettings(tmpDir, config);
    const cfg = parseBlackbytesConfig(config);
    assert.ok(cfg.ok);
    if (!cfg.ok) return;
    initEnabledSet(cfg.value);

    const { defineSubAgent } = await import("../../sub-agents/declaration.js");
    const { initAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    const { Type } = await import("typebox");
    const { checkPiAvailability } = await import("../../sub-agents/pi-availability.js");

    const oracleDecl = defineSubAgent({
      name: "oracle",
      toolName: "delegate_oracle",
      description: "x",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read"],
      source: "builtin",
      buildUserPrompt: (p: { q: string }) => p.q,
    });
    initAgentSnapshot([oracleDecl], cfg.value);

    await checkPiAvailability(async () => ({ available: false, error: "pi command not found" }));

    const out = await handleBlackbytesStatus();

    assert.match(out, /### Sub-Agent Diagnostics/);
    assert.match(out, /Nested Pi CLI.*✗.*unavailable/);
    assert.match(out, /hint: pi command not found/);
  });

  it("renders diagnostics section with YAML warnings", async () => {
    const config = {
      sub_agents: {
        oracle: { model: "claude-opus-4-5" },
      },
    };
    await writeSettings(tmpDir, config);
    const cfg = parseBlackbytesConfig(config);
    assert.ok(cfg.ok);
    if (!cfg.ok) return;
    initEnabledSet(cfg.value);

    const { defineSubAgent } = await import("../../sub-agents/declaration.js");
    const { initAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    const { Type } = await import("typebox");
    const { setYamlDiagnostics } = await import("../../sub-agents/diagnostics.js");
    const { checkPiAvailability } = await import("../../sub-agents/pi-availability.js");

    const oracleDecl = defineSubAgent({
      name: "oracle",
      toolName: "delegate_oracle",
      description: "x",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read"],
      source: "builtin",
      buildUserPrompt: (p: { q: string }) => p.q,
    });
    initAgentSnapshot([oracleDecl], cfg.value);

    setYamlDiagnostics({
      directory: "/tmp/test",
      directoryExists: true,
      scannedFiles: ["bad.yaml"],
      loadedDeclarations: [],
      skippedFiles: [
        { file: "bad.yaml", reason: "YAML syntax error" },
        {
          file: "conflict.yaml",
          reason: "Name conflict with builtin 'oracle'",
          conflictWith: { source: "builtin" as const, name: "oracle" },
        },
      ],
    });

    await checkPiAvailability(async () => ({ available: true }));

    const out = await handleBlackbytesStatus();

    assert.match(out, /### Sub-Agent Diagnostics/);
    assert.match(out, /YAML warnings/);
    assert.match(out, /Skipped bad.yaml: YAML syntax error/);
    assert.match(out, /Skipped conflict.yaml: Name conflict/);
  });

  it("redacts secrets from diagnostics output", async () => {
    const config = {
      sub_agents: {
        oracle: { model: "claude-opus-4-5" },
      },
    };
    await writeSettings(tmpDir, config);
    const cfg = parseBlackbytesConfig(config);
    assert.ok(cfg.ok);
    if (!cfg.ok) return;
    initEnabledSet(cfg.value);

    const { defineSubAgent } = await import("../../sub-agents/declaration.js");
    const { initAgentSnapshot } = await import("../../sub-agents/snapshot.js");
    const { Type } = await import("typebox");
    const { logDelegation } = await import("../../sub-agents/delegation-log.js");
    const { checkPiAvailability } = await import("../../sub-agents/pi-availability.js");

    const oracleDecl = defineSubAgent({
      name: "oracle",
      toolName: "delegate_oracle",
      description: "x",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read"],
      source: "builtin",
      buildUserPrompt: (p: { q: string }) => p.q,
    });
    initAgentSnapshot([oracleDecl], cfg.value);

    // Log a failure with a secret-shaped hint
    logDelegation({
      agent: "oracle",
      startedAt: Date.now() - 10000,
      durationMs: 5000,
      success: false,
      toolCallCount: 0,
      outputChars: 0,
      failureKind: "provider_or_model_unavailable",
      errorHint: "API key sk-abc123def456ghi789jkl is invalid",
    });

    await checkPiAvailability(async () => ({ available: true }));

    const out = await handleBlackbytesStatus();

    // Verify secrets are redacted
    assert.ok(!out.includes("sk-abc123def456ghi789jkl"), "raw API key must be redacted");
    assert.ok(out.includes("[REDACTED]"), "redaction marker must be present");
  });
});

// ---------------------------------------------------------------------------
// Interactive section picker tests
// ---------------------------------------------------------------------------

describe("handleBlackbytesStatus interactive section picker", () => {
  let tmpDir: string;
  const originalAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(async () => {
    tmpDir = await makeTempAgentDir();
    process.env.PI_AGENT_DIR = tmpDir;
    _resetEnabledSet();
    const { _resetPiAvailability } = await import("../../sub-agents/pi-availability.js");
    _resetPiAvailability();
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = originalAgentDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
    _resetEnabledSet();
    const { _resetPiAvailability } = await import("../../sub-agents/pi-availability.js");
    _resetPiAvailability();
  });

  function mockCtx(
    selectResponse: string | undefined,
    piAvailabilityProbe?: StatusInteractiveCtx["piAvailabilityProbe"],
  ): StatusInteractiveCtx {
    return {
      ui: {
        select: async () => selectResponse,
      },
      ...(piAvailabilityProbe ? { piAvailabilityProbe } : {}),
    };
  }

  it("returns full output when user selects 'Show All'", async () => {
    await writeSettings(tmpDir, {});
    const cfg = parseBlackbytesConfig({});
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);

    const fullOutput = await handleBlackbytesStatus();
    const interactiveOutput = await handleBlackbytesStatus(mockCtx("Show All"));

    assert.equal(interactiveOutput, fullOutput);
  });

  it("returns full output when user cancels selection (undefined)", async () => {
    await writeSettings(tmpDir, {});
    const cfg = parseBlackbytesConfig({});
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);

    const fullOutput = await handleBlackbytesStatus();
    const interactiveOutput = await handleBlackbytesStatus(mockCtx(undefined));

    assert.equal(interactiveOutput, fullOutput);
  });

  it("returns only selected section with overview when specific section chosen", async () => {
    await writeSettings(tmpDir, {});
    const cfg = parseBlackbytesConfig({});
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);

    const out = await handleBlackbytesStatus(mockCtx("System Prompt Log"));

    // Should contain overview
    assert.match(out, /## Blackbytes Status/);
    // Should contain the selected section
    assert.match(out, /### System Prompt Log/);
    // Should NOT contain other sections
    assert.ok(!out.includes("### Enabled Tools"), "should not include Enabled Tools section");
    assert.ok(!out.includes("### Config"), "should not include Config section");
    assert.ok(
      !out.includes("### Sub-Agent Snapshot"),
      "should not include Sub-Agent Snapshot section",
    );
  });

  it("returns Reserved section when selected", async () => {
    const blackbytes = {
      sub_agents: {
        oracle: { temperature: 0.42 },
      },
    };
    await writeSettings(tmpDir, blackbytes);
    const cfg = parseBlackbytesConfig(blackbytes);
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);

    const out = await handleBlackbytesStatus(mockCtx("Reserved / Unsupported Settings"));

    assert.match(out, /## Blackbytes Status/);
    assert.match(out, /### Reserved \/ Unsupported Settings/);
    assert.match(out, /temperature/);
    // Should NOT contain other sections
    assert.ok(!out.includes("### Enabled Tools"), "should not include other sections");
  });

  it("probes Pi availability when diagnostics section is selected", async () => {
    await writeSettings(tmpDir, {});
    const cfg = parseBlackbytesConfig({});
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);
    let probeCount = 0;

    const out = await handleBlackbytesStatus(
      mockCtx("Sub-Agent Diagnostics", async () => {
        probeCount++;
        return { available: true };
      }),
    );

    assert.equal(probeCount, 1);
    assert.match(out, /### Sub-Agent Diagnostics/);
    assert.match(out, /Nested Pi CLI.*✓.*available/);
  });

  it("does not probe Pi availability for unrelated selected sections", async () => {
    await writeSettings(tmpDir, {});
    const cfg = parseBlackbytesConfig({});
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);
    let probeCount = 0;

    const out = await handleBlackbytesStatus(
      mockCtx("System Prompt Log", async () => {
        probeCount++;
        return { available: true };
      }),
    );

    assert.equal(probeCount, 0);
    assert.match(out, /### System Prompt Log/);
  });

  it("overview line includes tool/agent/skill counts", async () => {
    await writeSettings(tmpDir, {});
    const cfg = parseBlackbytesConfig({});
    assert.ok(cfg.ok);
    if (cfg.ok) initEnabledSet(cfg.value);

    const out = await handleBlackbytesStatus(mockCtx("Compact Tool Output"));

    assert.match(out, /Tools: \*\*\d+\*\* enabled/);
    assert.match(out, /Agents: \*\*\d+\*\* enabled/);
    assert.match(out, /Skills: \*\*\d+\*\* enabled/);
  });
});
