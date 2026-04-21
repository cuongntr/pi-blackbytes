import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadYamlDeclarations } from "../loader.js";

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

    const declarations = await loadYamlDeclarations();
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

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 2);
    assert.equal(declarations[0].name, "alpha");
    assert.equal(declarations[1].name, "beta");
  });

  it("loads both .yaml and .yml extensions", async () => {
    await writeYaml(tmpDir, "first.yaml", validYaml({ name: "first" }));
    await writeYaml(tmpDir, "second.yml", validYaml({ name: "second" }));

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 2);
  });

  it("supports allowed_tools with static allowlist", async () => {
    const yaml = validYaml({ allowed_tools: ["read", "grep"] });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);

    const tools = declarations[0].allowedTools;
    assert.ok(Array.isArray(tools), "allowlist should be a static array");
    assert.deepEqual(tools, ["read", "grep"]);
  });

  it("supports denied_tools with dynamic resolver", async () => {
    const yaml = validYaml({ denied_tools: ["ast_search"] });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);

    const tools = declarations[0].allowedTools;
    assert.equal(typeof tools, "function", "denylist should produce a dynamic resolver");
  });

  it("supports model and reasoning_effort overrides", async () => {
    const yaml = validYaml({ model: "o3", reasoning_effort: "high" });
    await writeYaml(tmpDir, "agent.yaml", yaml);

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);

    const overrides = declarations[0].resolveModelOverrides?.();
    assert.deepEqual(overrides, { model: "o3", reasoningEffort: "high" });
  });

  it("no resolveModelOverrides when model/reasoning_effort absent", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml());

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].resolveModelOverrides, undefined);
  });

  // -------------------------------------------------------------------------
  // Missing directory / empty
  // -------------------------------------------------------------------------

  it("returns empty array when sub-agents directory does not exist", async () => {
    // tmpDir exists but has no sub-agents/ subdirectory
    const declarations = await loadYamlDeclarations();
    assert.deepEqual(declarations, []);
  });

  it("returns empty array when sub-agents directory is empty", async () => {
    await fs.mkdir(path.join(tmpDir, "sub-agents"), { recursive: true });
    const declarations = await loadYamlDeclarations();
    assert.deepEqual(declarations, []);
  });

  // -------------------------------------------------------------------------
  // Invalid files — warn and skip
  // -------------------------------------------------------------------------

  it("skips files with YAML syntax errors", async () => {
    await writeYaml(tmpDir, "bad.yaml", "name: [\ninvalid yaml");

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  it("skips files missing required fields", async () => {
    await writeYaml(tmpDir, "bad.yaml", "name: test\n");

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  it("skips files with invalid name format", async () => {
    await writeYaml(tmpDir, "bad.yaml", validYaml({ name: "UPPERCASE" }));

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  it("skips files with both allowed_tools and denied_tools", async () => {
    const yaml = validYaml({
      allowed_tools: ["read"],
      denied_tools: ["grep"],
    });
    await writeYaml(tmpDir, "bad.yaml", yaml);

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  it("skips files with unknown tool names in allowed_tools", async () => {
    const yaml = validYaml({ allowed_tools: ["read", "nonexistent_tool"] });
    await writeYaml(tmpDir, "bad.yaml", yaml);

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  it("skips files with delegate_* in allowed_tools", async () => {
    const yaml = validYaml({ allowed_tools: ["read", "delegate_explore"] });
    await writeYaml(tmpDir, "bad.yaml", yaml);

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  it("skips files with unknown tool names in denied_tools", async () => {
    const yaml = validYaml({ denied_tools: ["nonexistent_tool"] });
    await writeYaml(tmpDir, "bad.yaml", yaml);

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 0);
  });

  // -------------------------------------------------------------------------
  // Mixed valid and invalid
  // -------------------------------------------------------------------------

  it("loads valid files and skips invalid ones", async () => {
    await writeYaml(tmpDir, "good.yaml", validYaml({ name: "good-agent" }));
    await writeYaml(tmpDir, "bad.yaml", "not valid yaml: [");
    await writeYaml(tmpDir, "also-good.yaml", validYaml({ name: "also-good" }));

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 2);
    assert.equal(declarations[0].name, "also-good");
    assert.equal(declarations[1].name, "good-agent");
  });

  it("ignores non-yaml files in the directory", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml());
    const subAgentsDir = path.join(tmpDir, "sub-agents");
    await fs.writeFile(path.join(subAgentsDir, "readme.txt"), "ignore me", "utf8");
    await fs.writeFile(path.join(subAgentsDir, "config.json"), "{}", "utf8");

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);
  });

  // -------------------------------------------------------------------------
  // Tool strategy defaults
  // -------------------------------------------------------------------------

  it("uses all-except-delegates when no tool spec provided", async () => {
    await writeYaml(tmpDir, "agent.yaml", validYaml());

    const declarations = await loadYamlDeclarations();
    assert.equal(declarations.length, 1);

    const tools = declarations[0].allowedTools;
    assert.equal(typeof tools, "function", "no-spec should produce a dynamic resolver");
  });
});
