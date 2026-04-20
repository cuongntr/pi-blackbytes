import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { bootstrap } from "../../bootstrap.js";
import { _resetEnabledSet, getEnabledSet } from "../../config/enabled-set.js";
import { _resetSubAgentRegistry } from "../../config/resource-metadata.js";
import { createMockPi } from "../../test-utils/pi-mock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-blackbytes-test-"));
}

async function writeSettings(dir: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, "settings.json"), content, "utf8");
}

/**
 * Poll until EnabledSet is initialized (or timeout).
 * Required because bootstrap wraps handlers with `.catch()` (returns void),
 * so emit() doesn't return a Promise we can await.
 */
async function waitForEnabledSet(timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      getEnabledSet();
      return; // initialized successfully
    } catch {
      await new Promise<void>((r) => setTimeout(r, 20));
    }
  }
  throw new Error("Timed out waiting for EnabledSet to be initialized");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: session_start", () => {
  let tmpDir: string;
  const originalAgentDir = process.env.PI_AGENT_DIR;

  before(async () => {
    tmpDir = await makeTempDir();
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    // Restore env
    if (originalAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = originalAgentDir;
    }
  });

  afterEach(() => {
    _resetEnabledSet();
    _resetSubAgentRegistry();
    delete process.env.PI_AGENT_DIR;
  });

  it("success path: loads valid blackbytes config and initialises enabled-set", async () => {
    // Arrange
    const subDir = await makeTempDir();
    try {
      const settings = {
        blackbytes: {
          disabled_tools: ["grep"],
          disabled_sub_agents: [],
        },
      };
      await writeSettings(subDir, JSON.stringify(settings));
      process.env.PI_AGENT_DIR = subDir;

      const mock = createMockPi();

      // Act
      bootstrap(mock);

      // session_start event should have been registered
      const sessionStartReg = mock.calls.on.find((c) => c.event === "session_start");
      assert.ok(sessionStartReg, "bootstrap should register a session_start handler");

      // Trigger event; wrap() returns void, so we poll for completion
      mock.emit("session_start", {});
      await waitForEnabledSet();

      // Assert: enabled-set was initialised
      const enabledSet = getEnabledSet();
      assert.ok(enabledSet, "enabledSet should be initialised after session_start");

      // "grep" was in disabled_tools, so it must not appear in tools
      assert.equal(enabledSet.tools.has("grep"), false, "'grep' should be disabled");

      // Other tools should still be present
      assert.equal(enabledSet.tools.has("glob"), true, "'glob' should still be enabled");
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it("malformed path: invalid JSON in settings uses defaults and does not throw", async () => {
    // Arrange
    const subDir = await makeTempDir();
    try {
      await writeSettings(subDir, "{ this is not valid JSON }}}");
      process.env.PI_AGENT_DIR = subDir;

      const mock = createMockPi();

      // Act — handler must not throw (errors are swallowed by wrap())
      bootstrap(mock);
      mock.emit("session_start", {});
      await waitForEnabledSet();

      // Assert: handler completed gracefully; enabled-set defaults are used
      const enabledSet = getEnabledSet();
      assert.ok(enabledSet, "enabledSet should be initialised with defaults");

      // With default config all DEFAULT_TOOLS should be present
      assert.equal(enabledSet.tools.has("glob"), true, "'glob' should be in default tool set");
      assert.equal(enabledSet.tools.has("grep"), true, "'grep' should be in default tool set");
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });
});

describe("integration: session_start with YAML sub-agents", () => {
  let tmpDir: string;
  const originalAgentDir = process.env.PI_AGENT_DIR;

  afterEach(async () => {
    _resetEnabledSet();
    _resetSubAgentRegistry();
    if (originalAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = originalAgentDir;
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupWithYaml(
    yamlFiles: Record<string, string>,
    settings: Record<string, unknown> = {},
  ): Promise<{ mock: ReturnType<typeof createMockPi> }> {
    tmpDir = await makeTempDir();
    const subAgentsDir = path.join(tmpDir, "sub-agents");
    await fs.mkdir(subAgentsDir, { recursive: true });
    for (const [name, content] of Object.entries(yamlFiles)) {
      await fs.writeFile(path.join(subAgentsDir, name), content, "utf8");
    }
    await writeSettings(tmpDir, JSON.stringify({ blackbytes: settings }));
    process.env.PI_AGENT_DIR = tmpDir;
    const mock = createMockPi();
    bootstrap(mock);
    return { mock };
  }

  const VALID_YAML = [
    "name: researcher",
    "description: A research specialist",
    "system_prompt: You are a research specialist.",
  ].join("\n");

  it("registers valid YAML sub-agents alongside builtins", async () => {
    const { mock } = await setupWithYaml({ "researcher.yaml": VALID_YAML });
    mock.emit("session_start", {});
    await waitForEnabledSet();

    const enabledSet = getEnabledSet();
    // Builtin agents should be present
    assert.equal(enabledSet.subAgents.has("explore"), true);
    assert.equal(enabledSet.subAgents.has("oracle"), true);
    // YAML agent should also be present
    assert.equal(enabledSet.subAgents.has("researcher"), true);

    // delegate tool should be registered
    const toolNames = mock.calls.registerTool.map((t: any) => t.name ?? t.definition?.name);
    assert.ok(
      toolNames.includes("delegate_researcher"),
      "delegate_researcher tool should be registered",
    );
  });

  it("skips invalid YAML files without crashing startup", async () => {
    const { mock } = await setupWithYaml({
      "bad.yaml": "name: [\ninvalid yaml",
      "good.yaml": VALID_YAML,
    });
    mock.emit("session_start", {});
    await waitForEnabledSet();

    const enabledSet = getEnabledSet();
    // Good agent loaded, bad one skipped
    assert.equal(enabledSet.subAgents.has("researcher"), true);
    // Builtins still work
    assert.equal(enabledSet.subAgents.has("explore"), true);
  });

  it("aborts on duplicate name between YAML and builtin", async () => {
    // 'explore' is a builtin name — YAML agent with same name should cause error
    const dupeYaml = [
      "name: explore",
      "description: Duplicate of builtin",
      "system_prompt: I conflict with the builtin.",
    ].join("\n");

    const { mock } = await setupWithYaml({ "explore.yaml": dupeYaml });

    // session_start should throw (caught by bootstrap's wrap, but assertUniqueNames throws)
    // We need to test that the enabled set is NOT initialized
    mock.emit("session_start", {});

    // The handler throws, so enabled-set should never be initialized
    // Wait a bit then verify it's not set
    await new Promise<void>((r) => setTimeout(r, 200));
    assert.throws(
      () => getEnabledSet(),
      /not initialized/,
      "EnabledSet should not be initialized when duplicate names detected",
    );
  });

  it("disables a YAML agent through config disabled_sub_agents", async () => {
    const { mock } = await setupWithYaml(
      { "researcher.yaml": VALID_YAML },
      { disabled_sub_agents: ["researcher"] },
    );
    mock.emit("session_start", {});
    await waitForEnabledSet();

    const enabledSet = getEnabledSet();
    // YAML agent should be disabled via config
    assert.equal(
      enabledSet.subAgents.has("researcher"),
      false,
      "'researcher' should be disabled via config",
    );
    // Builtins should still be present
    assert.equal(enabledSet.subAgents.has("explore"), true);
  });
});
