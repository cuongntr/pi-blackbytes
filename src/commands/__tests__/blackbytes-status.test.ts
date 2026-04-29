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

    const builtinNames = ["explore", "oracle", "librarian", "general", "reviewer"];
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

    const builtinNames = ["explore", "oracle", "librarian", "general", "reviewer"];
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
// Interactive section picker tests
// ---------------------------------------------------------------------------

describe("handleBlackbytesStatus interactive section picker", () => {
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

  function mockCtx(selectResponse: string | undefined): StatusInteractiveCtx {
    return {
      ui: {
        select: async () => selectResponse,
      },
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
