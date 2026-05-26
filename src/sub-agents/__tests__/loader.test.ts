import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import type { BlackbytesConfig } from "../../config/schema.js";
import { loadYamlDeclarations } from "../loader.js";

const defaultConfig: BlackbytesConfig = {
  disabled_tools: [],
  disabled_sub_agents: [],
  hashline_edit: true,
  copilot_initiator_header: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let origAgentDir: string | undefined;

async function createTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yaml-loader-test-"));
}

async function writeYaml(dir: string, filename: string, content: string): Promise<void> {
  const subAgentsDir = path.join(dir, "sub-agents");
  await fs.mkdir(subAgentsDir, { recursive: true });
  await fs.writeFile(path.join(subAgentsDir, filename), content, "utf8");
}

function validYaml(overrides: Record<string, unknown> = {}): string {
  const base = {
    name: "researcher",
    description: "A research specialist",
    system_prompt: "You are a research specialist.",
    ...overrides,
  };
  return Object.entries(base)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map((i) => `  - ${i}`).join("\n")}`;
      }
      if (typeof v === "string" && v.includes("\n")) {
        return `${k}: |\n  ${v.replace(/\n/g, "\n  ")}`;
      }
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe("loadYamlDeclarations", () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    origAgentDir = process.env.PI_AGENT_DIR;
    process.env.PI_AGENT_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.PI_AGENT_DIR;
    if (origAgentDir !== undefined) {
      process.env.PI_AGENT_DIR = origAgentDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("loads a valid YAML declaration with defaults", async () => {
    await writeYaml(tmpDir, "researcher.yaml", validYaml());

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);

    const decl = declarations[0];
    assert.equal(decl.name, "researcher");
    assert.equal(decl.toolName, "delegate_researcher");
    assert.equal(decl.description, "A research specialist");
    assert.equal(decl.systemPrompt, "You are a research specialist.");
    assert.equal(decl.buildUserPrompt({ prompt: "hello" }), "hello");
  });

  it("loads multiple YAML files sorted alphabetically", async () => {
    await writeYaml(tmpDir, "beta.yaml", validYaml({ name: "beta" }));
    await writeYaml(tmpDir, "alpha.yaml", validYaml({ name: "alpha" }));

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 2);
    assert.equal(declarations[0].name, "alpha");
    assert.equal(declarations[1].name, "beta");
  });

  it("loads both .yaml and .yml extensions", async () => {
    await writeYaml(tmpDir, "first.yaml", validYaml({ name: "first" }));
    await writeYaml(tmpDir, "second.yml", validYaml({ name: "second" }));

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 2);
  });

  it("supports allowed_tools with static allowlist", async () => {
    const yaml = validYaml({ allowed_tools: ["read", "grep"] });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);

    const tools = declarations[0].allowedTools;
    assert.ok(Array.isArray(tools), "allowlist should be a static array");
    assert.deepEqual(tools, ["read", "grep"]);
  });

  it("supports denied_tools with dynamic resolver", async () => {
    const yaml = validYaml({ denied_tools: ["ast_search"] });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);

    const tools = declarations[0].allowedTools;
    assert.equal(typeof tools, "function", "denylist should produce a dynamic resolver");
  });

  it("supports model and reasoning_effort overrides via staticOverrides", async () => {
    const yaml = validYaml({ model: "o3", reasoning_effort: "high" });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);

    assert.deepEqual(declarations[0].staticOverrides, {
      model: "o3",
      reasoningEffort: "high",
      timeoutMs: undefined,
      fallbackModels: undefined,
    });
  });

  it("no staticOverrides when model/reasoning_effort absent", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml());

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].staticOverrides, undefined);
  });

  // -------------------------------------------------------------------------
  // Missing directory / empty
  // -------------------------------------------------------------------------

  it("returns empty declarations and directoryExists:false when sub-agents directory does not exist", async () => {
    // tmpDir exists but has no sub-agents/ subdirectory
    const result = await loadYamlDeclarations();
    assert.deepEqual(result.declarations, []);
    assert.equal(result.diagnostics.directoryExists, false);
    assert.deepEqual([...result.diagnostics.scannedFiles], []);
    assert.deepEqual([...result.diagnostics.skippedFiles], []);
  });

  it("returns empty declarations and directoryExists:true when sub-agents directory is empty", async () => {
    await fs.mkdir(path.join(tmpDir, "sub-agents"), { recursive: true });
    const result = await loadYamlDeclarations();
    assert.deepEqual(result.declarations, []);
    assert.equal(result.diagnostics.directoryExists, true);
    assert.deepEqual([...result.diagnostics.scannedFiles], []);
  });

  // -------------------------------------------------------------------------
  // Invalid files — warn and skip
  // -------------------------------------------------------------------------

  it("skips files with YAML syntax errors", async () => {
    await writeYaml(tmpDir, "bad.yaml", "name: [\ninvalid yaml");

    const { declarations, diagnostics } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
    assert.equal(diagnostics.skippedFiles.length, 1);
    assert.match(diagnostics.skippedFiles[0].reason, /YAML syntax error/);
  });

  it("skips files missing required fields", async () => {
    await writeYaml(tmpDir, "bad.yaml", "name: test\n");

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  it("skips files with invalid name format", async () => {
    await writeYaml(tmpDir, "bad.yaml", validYaml({ name: "UPPERCASE" }));

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  it("skips files with both allowed_tools and denied_tools", async () => {
    const yaml = validYaml({
      allowed_tools: ["read"],
      denied_tools: ["grep"],
    });
    await writeYaml(tmpDir, "bad.yaml", yaml);

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  it("skips files with unknown tool names in allowed_tools", async () => {
    const yaml = validYaml({ allowed_tools: ["read", "nonexistent_tool"] });
    await writeYaml(tmpDir, "bad.yaml", yaml);

    const { declarations, diagnostics } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
    assert.equal(diagnostics.skippedFiles.length, 1);
    assert.match(diagnostics.skippedFiles[0].reason, /Unknown tool names/);
  });

  it("skips files with delegate_* in allowed_tools", async () => {
    const yaml = validYaml({ allowed_tools: ["read", "delegate_explore"] });
    await writeYaml(tmpDir, "bad.yaml", yaml);

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  it("skips files with unknown tool names in denied_tools", async () => {
    const yaml = validYaml({ denied_tools: ["nonexistent_tool"] });
    await writeYaml(tmpDir, "bad.yaml", yaml);

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  // -------------------------------------------------------------------------
  // Mixed valid and invalid
  // -------------------------------------------------------------------------

  it("loads valid files and skips invalid ones", async () => {
    await writeYaml(tmpDir, "good.yaml", validYaml({ name: "good-agent" }));
    await writeYaml(tmpDir, "bad.yaml", "not valid yaml: [");
    await writeYaml(tmpDir, "also-good.yaml", validYaml({ name: "also-good" }));

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 2);
    assert.equal(declarations[0].name, "also-good");
    assert.equal(declarations[1].name, "good-agent");
  });

  it("ignores non-yaml files in the directory", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml());
    const subAgentsDir = path.join(tmpDir, "sub-agents");
    await fs.writeFile(path.join(subAgentsDir, "readme.txt"), "ignore me", "utf8");
    await fs.writeFile(path.join(subAgentsDir, "config.json"), "{}", "utf8");

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);
  });

  // -------------------------------------------------------------------------
  // Tool strategy defaults
  // -------------------------------------------------------------------------

  it("defaults to read-only safe base set when no tool spec provided", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml());

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);

    const decl = declarations[0];
    assert.equal(decl.mutability, "read-only");
    assert.equal(decl.finalizeMode, "lenient");

    const tools = decl.allowedTools;
    assert.equal(typeof tools, "function", "no-spec should produce a dynamic resolver");

    _resetEnabledSet();
    initEnabledSet(defaultConfig);

    const resolved = (tools as () => readonly string[])();
    // Mutating tools must NEVER appear in the YAML default base set.
    for (const mutating of ["bash", "edit", "write", "hashline_edit", "ast_replace"]) {
      assert.ok(!resolved.includes(mutating), `${mutating} must not be in YAML default base`);
    }
    // Read/search/docs members should be present.
    assert.ok(resolved.includes("read"), "read must be in YAML default base");
    assert.ok(resolved.includes("grep"), "grep must be in YAML default base");
  });

  it("denylist mode resolves from safe base set, not all-except-delegates", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml({ denied_tools: ["web_search"] }));

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);
    const decl = declarations[0];
    assert.equal(decl.mutability, "read-only");

    _resetEnabledSet();
    initEnabledSet(defaultConfig);

    const resolved = (decl.allowedTools as () => readonly string[])();
    assert.ok(!resolved.includes("web_search"), "denied tool must be excluded");
    for (const mutating of ["bash", "edit", "write", "hashline_edit", "ast_replace"]) {
      assert.ok(!resolved.includes(mutating), `${mutating} must not appear in YAML denylist base`);
    }
  });

  it("allowlist with mutating tool auto-promotes mutability to full-access", async () => {
    const yaml = validYaml({ allowed_tools: ["read", "bash", "hashline_edit"] });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);
    const decl = declarations[0];
    assert.equal(decl.mutability, "full-access");
    assert.deepEqual(decl.allowedTools, ["read", "bash", "hashline_edit"]);
  });

  it("allowlist with read-only tools keeps mutability read-only", async () => {
    const yaml = validYaml({ allowed_tools: ["read", "grep"] });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations } = await loadYamlDeclarations();
    const decl = declarations[0];
    assert.equal(decl.mutability, "read-only");
  });

  it("explicit mutability:'read-only' overrides auto-detection of mutating allowlist", async () => {
    const yaml = validYaml({
      allowed_tools: ["read", "bash"],
      mutability: "read-only",
    });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations } = await loadYamlDeclarations();
    const decl = declarations[0];
    assert.equal(decl.mutability, "read-only");
  });

  it("explicit mutability:'full-access' is honoured even with read-only allowlist", async () => {
    const yaml = validYaml({
      allowed_tools: ["read", "grep"],
      mutability: "full-access",
    });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations } = await loadYamlDeclarations();
    const decl = declarations[0];
    assert.equal(decl.mutability, "full-access");
  });

  // -------------------------------------------------------------------------
  // Diagnostics shape
  // -------------------------------------------------------------------------

  it("returns diagnostics with correct shape for a valid YAML file", async () => {
    await writeYaml(tmpDir, "researcher.yaml", validYaml());

    const { diagnostics } = await loadYamlDeclarations();
    assert.equal(diagnostics.directoryExists, true);
    assert.deepEqual([...diagnostics.scannedFiles], ["researcher.yaml"]);
    assert.equal(diagnostics.loadedDeclarations.length, 1);
    assert.equal(diagnostics.loadedDeclarations[0].name, "researcher");
    assert.equal(diagnostics.loadedDeclarations[0].file, "researcher.yaml");
    assert.equal(diagnostics.skippedFiles.length, 0);
  });

  // -------------------------------------------------------------------------
  // Duplicate detection
  // -------------------------------------------------------------------------

  it("skips YAML file with name conflicting with a builtin (reservedNames)", async () => {
    await writeYaml(tmpDir, "explore.yaml", validYaml({ name: "explore" }));
    await writeYaml(tmpDir, "safe.yaml", validYaml({ name: "safe-agent" }));

    const { declarations, diagnostics } = await loadYamlDeclarations(["explore"]);

    // explore.yaml should be skipped, safe.yaml should load
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].name, "safe-agent");

    const skipped = diagnostics.skippedFiles.find((s) => s.file === "explore.yaml");
    assert.ok(skipped !== undefined, "explore.yaml should be in skippedFiles");
    assert.match(skipped.reason, /conflicts with builtin/);
    assert.ok(skipped.conflictWith !== undefined);
    assert.equal(skipped.conflictWith!.source, "builtin");
    assert.equal((skipped.conflictWith as { source: "builtin"; name: string }).name, "explore");
  });

  it("skips second YAML file with duplicate name (YAML-vs-YAML conflict)", async () => {
    // alpha.yaml sorts before beta.yaml, so alpha wins
    await writeYaml(tmpDir, "alpha.yaml", validYaml({ name: "myagent" }));
    await writeYaml(tmpDir, "beta.yaml", validYaml({ name: "myagent" }));

    const { declarations, diagnostics } = await loadYamlDeclarations();

    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].name, "myagent");

    const skipped = diagnostics.skippedFiles.find((s) => s.file === "beta.yaml");
    assert.ok(skipped !== undefined, "beta.yaml should be in skippedFiles");
    assert.match(skipped.reason, /conflicts with earlier YAML file/);
    assert.ok(skipped.conflictWith !== undefined);
    assert.equal(skipped.conflictWith!.source, "yaml");
    assert.equal(
      (skipped.conflictWith as { source: "yaml"; name: string; file: string }).file,
      "alpha.yaml",
    );
  });

  it("non-conflicting agents still register when one file has a duplicate", async () => {
    await writeYaml(tmpDir, "alpha.yaml", validYaml({ name: "myagent" }));
    await writeYaml(tmpDir, "beta.yaml", validYaml({ name: "myagent" }));
    await writeYaml(tmpDir, "gamma.yaml", validYaml({ name: "other-agent" }));

    const { declarations, diagnostics } = await loadYamlDeclarations();

    assert.equal(declarations.length, 2);
    const names = declarations.map((d) => d.name);
    assert.ok(names.includes("myagent"));
    assert.ok(names.includes("other-agent"));
    assert.equal(diagnostics.skippedFiles.length, 1);
    assert.equal(diagnostics.skippedFiles[0].file, "beta.yaml");
  });

  // -------------------------------------------------------------------------
  // promptMode / prompt_mode field
  // -------------------------------------------------------------------------

  it("accepts valid prompt_mode: static", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml({ prompt_mode: "static" }));
    const { declarations, diagnostics } = await loadYamlDeclarations();
    assert.equal(diagnostics.skippedFiles.length, 0, "should not skip a valid prompt_mode");
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].promptMode, "static");
  });

  it("accepts valid prompt_mode: append", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml({ prompt_mode: "append" }));
    const { declarations, diagnostics } = await loadYamlDeclarations();
    assert.equal(diagnostics.skippedFiles.length, 0, "should not skip a valid prompt_mode");
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].promptMode, "append");
  });

  it("rejects invalid prompt_mode values with a diagnostic", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml({ prompt_mode: "hybrid" }));
    const { declarations, diagnostics } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0, "invalid prompt_mode must cause the file to be skipped");
    assert.equal(diagnostics.skippedFiles.length, 1);
    assert.match(diagnostics.skippedFiles[0].reason, /Schema validation failed/);
  });

  it("prompt_mode defaults to undefined (static by default) when omitted", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml());
    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].promptMode, undefined);
  });

  // -------------------------------------------------------------------------
  // routing field
  // -------------------------------------------------------------------------

  it("accepts valid routing metadata and copies to declaration", async () => {
    const yaml = validYaml({
      routing: {
        category: "exploration",
        cost: "medium",
        use_when: ["Broad codebase search", "Cross-file discovery"],
        avoid_when: ["Simple grep suffices"],
        key_trigger: "Find code across files",
      },
    });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations, diagnostics } = await loadYamlDeclarations();
    assert.equal(diagnostics.skippedFiles.length, 0);
    assert.equal(declarations.length, 1);
    assert.ok(declarations[0].routing);
    assert.equal(declarations[0].routing!.category, "exploration");
    assert.equal(declarations[0].routing!.cost, "medium");
    assert.deepEqual(declarations[0].routing!.useWhen, [
      "Broad codebase search",
      "Cross-file discovery",
    ]);
    assert.deepEqual(declarations[0].routing!.avoidWhen, ["Simple grep suffices"]);
    assert.equal(declarations[0].routing!.keyTrigger, "Find code across files");
  });

  it("loads YAML agents without routing unchanged", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml());

    const { declarations } = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].routing, undefined);
  });

  it("skips YAML with invalid routing category", async () => {
    const yaml = validYaml({
      routing: {
        category: "advisor",
        cost: "low",
        use_when: ["test"],
        avoid_when: ["test"],
      },
    });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations, diagnostics } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
    assert.equal(diagnostics.skippedFiles.length, 1);
    assert.match(diagnostics.skippedFiles[0].reason, /Schema validation failed/);
  });

  it("skips YAML with too many useWhen entries", async () => {
    const yaml = validYaml({
      routing: {
        category: "exploration",
        cost: "low",
        use_when: ["a", "b", "c", "d", "e", "f", "g"],
        avoid_when: [],
      },
    });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations, diagnostics } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
    assert.equal(diagnostics.skippedFiles.length, 1);
  });

  it("skips YAML with useWhen entry exceeding 60 chars", async () => {
    const yaml = validYaml({
      routing: {
        category: "exploration",
        cost: "low",
        use_when: ["a".repeat(61)],
        avoid_when: [],
      },
    });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const { declarations, diagnostics } = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
    assert.equal(diagnostics.skippedFiles.length, 1);
  });
});
