import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { bootstrap } from "../../bootstrap.js";
import { _resetEnabledSet, getEnabledSet } from "../../config/enabled-set.js";
import { type ToolResultEvent, processToolResult } from "../../handlers/tool-result.js";
import { createMockPi } from "../../test-utils/pi-mock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-blackbytes-tr-test-"));
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

describe("integration: tool_result", () => {
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
    delete process.env.PI_AGENT_DIR;
  });

  it("read tool result gets LINE#ID anchors injected into each line", async () => {
    // processToolResult is the core logic used by handleToolResult
    const event: ToolResultEvent = {
      toolName: "read",
      content: [{ type: "text", text: "first line\nsecond line\nthird line" }],
    };

    const result = processToolResult(event, { hashline_edit: true });

    assert.ok(result !== null, "processToolResult should return a result for 'read'");
    const text = result!.content![0].text!;
    const lines = text.split("\n");
    assert.equal(lines.length, 3, "should have 3 lines");

    // Each line should have LINE#CID| prefix pattern
    for (let i = 0; i < lines.length; i++) {
      assert.match(lines[i], /^\d+#[A-Z]{2}\|/, `line ${i + 1} should have LINE#CID| prefix`);
    }
    assert.ok(lines[0].startsWith("1#"), "first line prefix starts with '1#'");
    assert.ok(lines[1].startsWith("2#"), "second line prefix starts with '2#'");
    assert.ok(lines[2].startsWith("3#"), "third line prefix starts with '3#'");
  });

  it("write tool result normalized to 'File written successfully. N lines written.'", async () => {
    const originalText = "line one\nline two\nline three";
    const event: ToolResultEvent = {
      toolName: "write",
      content: [{ type: "text", text: originalText }],
    };

    const result = processToolResult(event, { hashline_edit: true });

    assert.ok(result !== null, "processToolResult should return a result for 'write'");
    const text = result!.content![0].text!;
    assert.equal(text, "File written successfully. 3 lines written.");
  });

  it("hashline_edit=false: read tool result content unchanged (returns null)", async () => {
    const originalText = "line one\nline two";
    const event: ToolResultEvent = {
      toolName: "read",
      content: [{ type: "text", text: originalText }],
    };

    const result = processToolResult(event, { hashline_edit: false });

    assert.equal(result, null, "processToolResult should return null when hashline_edit=false");
    // Original event content unmodified
    assert.equal(event.content![0].text, originalText, "original content should be unchanged");
  });

  it("isError=true: tool result is not rewritten", async () => {
    const originalText = "Error: something went wrong";
    const event: ToolResultEvent = {
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: originalText }],
    };

    const result = processToolResult(event, { hashline_edit: true });

    assert.equal(result, null, "processToolResult should return null for error results");
    assert.equal(event.content![0].text, originalText, "original content should be preserved");
  });

  it("non-target tool (bash): content is not rewritten", async () => {
    const originalText = "$ echo hello\nhello";
    const event: ToolResultEvent = {
      toolName: "bash",
      content: [{ type: "text", text: originalText }],
    };

    const result = processToolResult(event, { hashline_edit: true });

    assert.equal(result, null, "processToolResult should return null for non-target tools");
    assert.equal(event.content![0].text, originalText, "bash output should be unchanged");
  });

  it("full integration: tool_result event fired through bootstrap does not crash", async () => {
    // Arrange: write settings and bootstrap
    const subDir = await makeTempDir();
    try {
      await writeSettings(subDir, JSON.stringify({ blackbytes: { hashline_edit: true } }));
      process.env.PI_AGENT_DIR = subDir;

      const mock = createMockPi();
      bootstrap(mock);

      mock.emit("session_start", {});
      await waitForEnabledSet();

      // Act: fire tool_result — should not crash even through the handler chain
      const event: ToolResultEvent = {
        toolName: "read",
        content: [{ type: "text", text: "line A\nline B" }],
      };
      await mock.emit("tool_result", event);
      await settle();

      // Handler is wired, mutates the mock event for local compatibility, and returns
      // the rewritten result for Pi's return-based tool_result contract.
      const toolResultReg = mock.calls.on.find((c) => c.event === "tool_result");
      assert.ok(toolResultReg, "bootstrap should register a tool_result handler");
      assert.match(event.content![0].text!, /^1#[A-Z]{2}\|line A/);
    } finally {
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });
});
