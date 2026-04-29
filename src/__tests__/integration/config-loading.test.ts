import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { registerSetupModelsCommand } from "../../commands/setup-models.js";
import { loadBlackbytesConfig } from "../../config/loader.js";

const CLAUDE_MODEL = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  reasoning: true,
  input: ["text", "image"],
};
const CLAUDE_LABEL = "anthropic/claude-sonnet-4-5 — Claude Sonnet 4.5 (thinking, image)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDirSync(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-cfg-test-"));
}

function writeSettingsSync(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, "settings.json"), content, "utf8");
}

function readSettingsJson(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * Minimal ExtensionAPI that captures registerCommand's second argument (the handler object).
 * The built-in MockPi only records the first arg (command name), so we need our own here.
 */
function createCommandCapturePi(): {
  pi: ExtensionAPI;
  getHandler: () => (args: string, ctx: ExtensionCommandContext) => Promise<void>;
} {
  let capturedHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;

  const pi = {
    on() {},
    registerTool() {},
    registerProvider() {},
    registerCommand(_name: string, options: unknown) {
      if (typeof options === "object" && options !== null && "handler" in options) {
        capturedHandler = (
          options as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
        ).handler;
      }
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    getHandler() {
      if (!capturedHandler) throw new Error("No command handler captured");
      return capturedHandler;
    },
  };
}

/**
 * Build a mock ExtensionCommandContext with pre-programmed queue-based responses.
 * Each ui method pops from its own queue. Extra calls beyond the queue return safe defaults.
 */
function buildMockCtx(responses: {
  selects?: string[];
  inputs?: string[];
  confirms?: boolean[];
}): { ctx: ExtensionCommandContext; notifications: Array<{ msg: string; level: string }> } {
  const selects = [...(responses.selects ?? [])];
  const inputs = [...(responses.inputs ?? [])];
  const confirms = [...(responses.confirms ?? [])];
  const notifications: Array<{ msg: string; level: string }> = [];

  const ctx = {
    modelRegistry: {
      refresh: () => {},
      getError: () => undefined,
      getAvailable: () => [CLAUDE_MODEL],
    },
    ui: {
      select: async (_title: string, _opts: string[]) => {
        const v = selects.shift();
        if (v === undefined) throw new Error("Unexpected ctx.ui.select() — queue exhausted");
        return v;
      },
      input: async (_title: string, _placeholder?: string) => inputs.shift() ?? "",
      confirm: async (_title: string, _message: string) => confirms.shift() ?? false,
      notify: (msg: string, level = "info") => notifications.push({ msg, level }),
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, notifications };
}

/**
 * Register and run the setup-models wizard with the given pre-programmed UI responses.
 * PI_AGENT_DIR must already be set before calling.
 */
async function runWizard(responses: {
  selects?: string[];
  inputs?: string[];
  confirms?: boolean[];
}): Promise<{ notifications: Array<{ msg: string; level: string }> }> {
  const { pi, getHandler } = createCommandCapturePi();
  registerSetupModelsCommand(pi);
  const handler = getHandler();
  const { ctx, notifications } = buildMockCtx(responses);
  await handler("", ctx);
  return { notifications };
}

// ---------------------------------------------------------------------------
// loadBlackbytesConfig — loader tests
// ---------------------------------------------------------------------------

describe("integration: config loading — loadBlackbytesConfig()", () => {
  let tmpDir: string;
  const origAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    tmpDir = makeTempDirSync();
    process.env.PI_AGENT_DIR = tmpDir;
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
    if (origAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = origAgentDir;
    }
  });

  it("1. valid blackbytes block parsed and returned correctly", async () => {
    writeSettingsSync(
      tmpDir,
      JSON.stringify({
        blackbytes: {
          disabled_tools: ["grep"],
          disabled_sub_agents: ["oracle"],
          hashline_edit: false,
          copilot_initiator_header: false,
        },
      }),
    );

    const cfg = await loadBlackbytesConfig();

    assert.deepEqual(cfg.disabled_tools, ["grep"]);
    assert.deepEqual(cfg.disabled_sub_agents, ["oracle"]);
    assert.equal(cfg.hashline_edit, false);
    assert.equal(cfg.copilot_initiator_header, false);
  });

  it("2. settings.json with no blackbytes block returns defaults without error", async () => {
    writeSettingsSync(tmpDir, JSON.stringify({ other_plugin: { foo: "bar" } }));

    const cfg = await loadBlackbytesConfig();

    assert.deepEqual(cfg.disabled_tools, []);
    assert.deepEqual(cfg.disabled_sub_agents, []);
    assert.equal(cfg.hashline_edit, true);
    assert.equal(cfg.copilot_initiator_header, true);
  });

  it("3. missing settings.json — defaults used, no throw", async () => {
    // No file written
    const cfg = await loadBlackbytesConfig();

    assert.deepEqual(cfg.disabled_tools, []);
    assert.deepEqual(cfg.disabled_sub_agents, []);
    assert.equal(cfg.hashline_edit, true);
  });

  it("4. malformed JSON — defaults used, no throw", async () => {
    writeSettingsSync(tmpDir, "{ this is NOT valid json }}}");

    const cfg = await loadBlackbytesConfig();

    assert.deepEqual(cfg.disabled_tools, []);
    assert.equal(cfg.hashline_edit, true);
  });

  it("5. invalid blackbytes block (wrong types) — defaults used, no throw", async () => {
    writeSettingsSync(
      tmpDir,
      JSON.stringify({
        blackbytes: {
          disabled_tools: "should-be-an-array",
          hashline_edit: "should-be-boolean",
          disabled_sub_agents: ["not-a-valid-sub-agent-name"],
        },
      }),
    );

    const cfg = await loadBlackbytesConfig();

    // Zod validation fails → falls back to defaults
    assert.deepEqual(cfg.disabled_tools, []);
    assert.equal(cfg.hashline_edit, true);
  });
});

// ---------------------------------------------------------------------------
// setup-models wizard — integration tests
// ---------------------------------------------------------------------------

describe("integration: setup-models wizard", () => {
  let tmpDir: string;
  const origAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    tmpDir = makeTempDirSync();
    process.env.PI_AGENT_DIR = tmpDir;
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
    if (origAgentDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = origAgentDir;
    }
  });

  it("6. existing non-blackbytes keys preserved after wizard write", async () => {
    const existing = {
      other_plugin: { foo: "bar", nested: [1, 2, 3] },
      another_key: "hello",
    };
    writeSettingsSync(tmpDir, JSON.stringify(existing));

    // No existing blackbytes.sub_agents block → no overwrite confirm.
    await runWizard({
      selects: [
        "Use one model for all sub-agents",
        CLAUDE_LABEL,
        "Skip (keep existing / use defaults)",
      ],
      confirms: [true], // summary confirm
    });

    const written = readSettingsJson(tmpDir);
    assert.deepEqual(written.other_plugin, existing.other_plugin, "other_plugin preserved");
    assert.equal(written.another_key, "hello", "another_key preserved");
    assert.ok("blackbytes" in written, "blackbytes block written");
  });

  it("7. atomic write — final file is valid JSON, no .tmp file left behind", async () => {
    await runWizard({
      selects: [
        "Use one model for all sub-agents",
        CLAUDE_LABEL,
        "Skip (keep existing / use defaults)",
      ],
      confirms: [true], // summary confirm
    });

    const settingsPath = path.join(tmpDir, "settings.json");
    assert.ok(fs.existsSync(settingsPath), "settings.json must exist after wizard");

    // Must be valid JSON object
    const content = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(content);
    assert.ok(
      typeof parsed === "object" && parsed !== null,
      "settings.json is a valid JSON object",
    );

    // Temp file must not linger
    assert.equal(fs.existsSync(`${settingsPath}.tmp`), false, ".tmp file must not remain");
  });

  it("8. wizard maps models without writing provider/package configuration", async () => {
    writeSettingsSync(
      tmpDir,
      JSON.stringify({
        blackbytes: { packages: ["custom-pass-through", "custom-pass-through"] },
      }),
    );

    await runWizard({
      selects: [
        "Use one model for all sub-agents",
        CLAUDE_LABEL,
        "Skip (keep existing / use defaults)",
      ],
      confirms: [true], // summary confirm
    });

    const written = readSettingsJson(tmpDir);
    const bb = written.blackbytes as Record<string, unknown>;
    const subAgents = bb.sub_agents as Record<string, Record<string, unknown>>;

    assert.equal(subAgents.oracle.model, "anthropic/claude-sonnet-4-5");
    assert.deepEqual(
      bb.packages,
      ["custom-pass-through", "custom-pass-through"],
      "unknown passthrough keys are preserved, not managed as provider packages",
    );
    assert.equal("anthropic_api_key" in bb, false, "provider keys are not written");
    assert.equal("openai_api_key" in bb, false, "provider keys are not written");
    assert.equal("default_model" in bb, false, "top-level default_model is not written");
  });
});
