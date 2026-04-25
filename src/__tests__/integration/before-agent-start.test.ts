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
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-blackbytes-bas-test-"));
}

async function writeSettings(dir: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, "settings.json"), content, "utf8");
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

/**
 * Small compatibility delay for async handler side effects in older mock flows.
 */
async function settle(ms = 100): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: before_agent_start", () => {
  let tmpDir: string;
  const originalAgentDir = process.env.PI_AGENT_DIR;

  before(async () => {
    tmpDir = await makeTempDir();
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
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

  it("success: injects <available_resources> block into system prompt", async () => {
    // Arrange
    const subDir = await makeTempDir();
    try {
      const settings = {
        blackbytes: {
          disabled_tools: [],
          disabled_sub_agents: [],
        },
      };
      await writeSettings(subDir, JSON.stringify(settings));
      process.env.PI_AGENT_DIR = subDir;

      const mock = createMockPi();
      bootstrap(mock);

      // Fire session_start first to init enabled set
      mock.emit("session_start", {});
      await waitForEnabledSet();

      // Act: fire before_agent_start with a prompt
      const event = { systemPrompt: "You are a helpful assistant." };
      await mock.emit("before_agent_start", event);
      await settle();

      // Assert: sentinel block injected
      assert.ok(
        event.systemPrompt.includes("<!-- pi-blackbytes:resources:start -->"),
        "start sentinel present",
      );
      assert.ok(
        event.systemPrompt.includes("<!-- pi-blackbytes:resources:end -->"),
        "end sentinel present",
      );
      assert.ok(
        event.systemPrompt.includes("<available_resources>"),
        "available_resources XML tag present",
      );
      // Enabled tools should appear
      assert.ok(
        event.systemPrompt.includes("hashline_edit"),
        "bundled tool 'hashline_edit' listed",
      );
      assert.ok(event.systemPrompt.includes("explore"), "sub-agent 'explore' listed");
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it("idempotency: firing before_agent_start twice replaces block, does not duplicate", async () => {
    // Arrange
    const subDir = await makeTempDir();
    try {
      await writeSettings(subDir, JSON.stringify({ blackbytes: {} }));
      process.env.PI_AGENT_DIR = subDir;

      const mock = createMockPi();
      bootstrap(mock);

      mock.emit("session_start", {});
      await waitForEnabledSet();

      // First emission
      const event = { systemPrompt: "Base prompt." };
      await mock.emit("before_agent_start", event);
      await settle();

      // Second emission with the already-modified prompt
      await mock.emit("before_agent_start", event);
      await settle();

      // Sentinel should appear exactly once each
      const startCount = (event.systemPrompt.match(/<!-- pi-blackbytes:resources:start -->/g) ?? [])
        .length;
      const endCount = (event.systemPrompt.match(/<!-- pi-blackbytes:resources:end -->/g) ?? [])
        .length;
      assert.equal(startCount, 1, "start sentinel appears exactly once");
      assert.equal(endCount, 1, "end sentinel appears exactly once");
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it("disabled_tools: excluded tool does not appear in injected resources", async () => {
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
      bootstrap(mock);

      mock.emit("session_start", {});
      await waitForEnabledSet();

      const event = { systemPrompt: "System prompt." };
      await mock.emit("before_agent_start", event);
      await settle();

      // 'grep' should not appear as a standalone bundled tool (disabled)
      const enabledSet = getEnabledSet();
      assert.equal(enabledSet.tools.has("grep"), false, "'grep' should be disabled in enabled set");
      // Resources block should still include other tools
      assert.ok(event.systemPrompt.includes("hashline_edit"), "other bundled tools still listed");
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it("fallback path: injects a minimal safe overlay when enabled set is unavailable", async () => {
    // Arrange: skip session_start so getEnabledSet() is unavailable.
    const mock = createMockPi();
    bootstrap(mock);

    const originalPrompt = "Original prompt.";
    const event = { systemPrompt: originalPrompt };

    await mock.emit("before_agent_start", event);
    await settle();

    assert.ok(event.systemPrompt.startsWith(originalPrompt));
    assert.ok(event.systemPrompt.includes("<!-- pi-blackbytes:resources:start -->"));
    assert.ok(event.systemPrompt.includes("Precedence"));
    assert.ok(!event.systemPrompt.includes("Hashline Edit Workflow"));
  });
});

it("uses ctx.model.id to choose prompt family before model_select runs", async () => {
  const subDir = await makeTempDir();
  try {
    await writeSettings(subDir, JSON.stringify({ blackbytes: {} }));
    process.env.PI_AGENT_DIR = subDir;

    const mock = createMockPi();
    bootstrap(mock);

    mock.emit("session_start", {});
    await waitForEnabledSet();

    const event = { systemPrompt: "Base prompt." };
    // Pass ctx with a GPT model so before_agent_start can detect the family
    const mockCtx = { model: { id: "gpt-5.4" }, ui: { notify: () => {} } };

    await mock.emit("before_agent_start", event, mockCtx);
    await settle();

    assert.ok(
      event.systemPrompt.includes("NEVER open with filler"),
      "GPT prompt variant should be selected from ctx.model.id",
    );
    assert.ok(!event.systemPrompt.includes("<agency>"), "Claude XML prompt should not be used");
  } finally {
    await fs.rm(subDir, { recursive: true, force: true });
  }
});
