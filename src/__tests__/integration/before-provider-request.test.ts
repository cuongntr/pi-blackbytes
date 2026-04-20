import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { bootstrap } from "../../bootstrap.js";
import { _resetEnabledSet, getEnabledSet } from "../../config/enabled-set.js";
import { _resetSubAgentRegistry } from "../../config/resource-metadata.js";
import { _resetModelFamily } from "../../shared/model-capability.js";
import { createMockPi } from "../../test-utils/pi-mock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-blackbytes-bpr-test-"));
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

async function settle(ms = 100): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: before_provider_request", () => {
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
    _resetModelFamily();
    delete process.env.PI_AGENT_DIR;
  });

  it("copilot header: session_start with copilot_initiator_header=true registers provider", async () => {
    // Arrange
    const subDir = await makeTempDir();
    try {
      const settings = {
        blackbytes: {
          copilot_initiator_header: true,
        },
      };
      await writeSettings(subDir, JSON.stringify(settings));
      process.env.PI_AGENT_DIR = subDir;

      const mock = createMockPi();
      bootstrap(mock);

      // Act: session_start triggers registerCopilotHeader
      mock.emit("session_start", {});
      await waitForEnabledSet();
      await settle();

      // Assert: provider was registered
      const providerCall = mock.calls.registerProvider.find((c) => c.name === "github-copilot");
      assert.ok(providerCall, "github-copilot provider should be registered");
      const opts = providerCall!.opts as { headers?: Record<string, string> };
      assert.equal(opts?.headers?.["x-initiator"], "agent", "x-initiator header should be 'agent'");
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it("reasoning effort mapping: model_select + before_provider_request adds thinking param for claude", async () => {
    // Arrange
    const subDir = await makeTempDir();
    let prevEffort: string | undefined;
    try {
      await writeSettings(subDir, JSON.stringify({ blackbytes: {} }));
      process.env.PI_AGENT_DIR = subDir;

      const mock = createMockPi();
      bootstrap(mock);

      mock.emit("session_start", {});
      await waitForEnabledSet();

      // Select a claude model → sets model family
      await mock.emit("model_select", { model: { id: "claude-3-5-sonnet-20241022" } });
      await settle();

      // Fire before_provider_request with reasoningEffort via env var
      prevEffort = process.env.BLACKBYTES_REASONING_EFFORT;
      process.env.BLACKBYTES_REASONING_EFFORT = "high";
      const payload: Record<string, unknown> = { temperature: 0.7 };
      const event = { payload };
      await mock.emit("before_provider_request", event);
      await settle();

      // Assert: thinking param added for claude
      assert.ok(payload.thinking !== undefined, "thinking param should be added for claude model");
      const thinking = payload.thinking as Record<string, unknown>;
      assert.equal(thinking.type, "enabled", "thinking type should be 'enabled'");
      assert.equal(thinking.budget_tokens, 50000, "high effort = 50000 tokens");
    } finally {
      if (prevEffort === undefined) {
        delete process.env.BLACKBYTES_REASONING_EFFORT;
      } else {
        process.env.BLACKBYTES_REASONING_EFFORT = prevEffort;
      }
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it("non-copilot config: copilot_initiator_header=false does not register provider", async () => {
    // Arrange
    const subDir = await makeTempDir();
    try {
      const settings = {
        blackbytes: {
          copilot_initiator_header: false,
        },
      };
      await writeSettings(subDir, JSON.stringify(settings));
      process.env.PI_AGENT_DIR = subDir;

      const mock = createMockPi();
      bootstrap(mock);

      // Act
      mock.emit("session_start", {});
      await waitForEnabledSet();
      await settle();

      // Assert: github-copilot provider should NOT be registered
      const providerCall = mock.calls.registerProvider.find((c) => c.name === "github-copilot");
      assert.equal(
        providerCall,
        undefined,
        "github-copilot provider should NOT be registered when copilot_initiator_header=false",
      );
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it("error resilience: payload forwarded unchanged when handler encounters error (no model selected)", async () => {
    // Arrange: bootstrap but fire before_provider_request WITHOUT model_select
    // → getModelFamily() returns "other" (default), mapReasoningEffort is a no-op
    const subDir = await makeTempDir();
    try {
      await writeSettings(subDir, JSON.stringify({ blackbytes: {} }));
      process.env.PI_AGENT_DIR = subDir;

      const mock = createMockPi();
      bootstrap(mock);

      mock.emit("session_start", {});
      await waitForEnabledSet();

      // No model_select → family defaults to "other"
      const payload: Record<string, unknown> = { temperature: 0.5 };
      const payloadSnapshot = { ...payload };
      const event = { payload, reasoningEffort: "high" };

      // Should not throw
      await mock.emit("before_provider_request", event);
      await settle();

      // For "other" family, mapReasoningEffort is a no-op → payload unchanged
      assert.deepEqual(
        payload,
        payloadSnapshot,
        "payload should be unchanged for 'other' model family",
      );
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it("uses model family cached during before_agent_start before model_select runs", async () => {
    const subDir = await makeTempDir();
    let prevEffort: string | undefined;
    try {
      await writeSettings(subDir, JSON.stringify({ blackbytes: {} }));
      process.env.PI_AGENT_DIR = subDir;

      const mock = createMockPi();
      bootstrap(mock);

      mock.emit("session_start", {});
      await waitForEnabledSet();

      await mock.emit(
        "before_agent_start",
        { systemPrompt: "Base prompt." },
        { model: { id: "gpt-5.4" }, ui: { notify: () => {} } },
      );
      await settle();

      const payload: Record<string, unknown> = {};
      prevEffort = process.env.BLACKBYTES_REASONING_EFFORT;
      process.env.BLACKBYTES_REASONING_EFFORT = "medium";
      await mock.emit("before_provider_request", { payload });
      await settle();
      assert.equal(payload.reasoning_effort, "medium");
    } finally {
      if (prevEffort === undefined) {
        delete process.env.BLACKBYTES_REASONING_EFFORT;
      } else {
        process.env.BLACKBYTES_REASONING_EFFORT = prevEffort;
      }
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });
});
