import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

// --------------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------------

interface MockModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
}

const CLAUDE_MODEL: MockModel = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  reasoning: true,
  input: ["text", "image"],
};

const GPT_MODEL: MockModel = {
  provider: "openai",
  id: "gpt-5.1",
  name: "GPT 5.1",
  reasoning: true,
  input: ["text"],
};

const COPILOT_MODEL: MockModel = {
  provider: "github-copilot",
  id: "gpt-5-mini",
  name: "GPT 5 Mini (Copilot)",
  reasoning: false,
  input: ["text"],
};

const CLAUDE_LABEL = "anthropic/claude-sonnet-4-5 — Claude Sonnet 4.5 (thinking, image)";
const GPT_LABEL = "openai/gpt-5.1 — GPT 5.1 (thinking)";
const COPILOT_CURRENT_LABEL = "github-copilot/gpt-5-mini — GPT 5 Mini (Copilot) [current]";
const INHERIT_LABEL = "Inherit host model (no override)";

interface MockUI {
  selectResponses: string[];
  inputResponses: string[];
  confirmResponses: boolean[];
  notifications: Array<{ message: string; level?: string }>;
  selectCalls: Array<{ title: string; options: string[] }>;
}

function makeMockCtx(
  ui: MockUI,
  models: MockModel[] = [CLAUDE_MODEL, GPT_MODEL],
  currentModel?: MockModel,
): ExtensionCommandContext {
  return {
    model: currentModel,
    modelRegistry: {
      refresh: () => {},
      getError: () => undefined,
      getAvailable: () => models,
    },
    ui: {
      select: async (title: string, opts: string[]) => {
        ui.selectCalls.push({ title, options: opts });
        const r = ui.selectResponses.shift();
        if (r === undefined) throw new Error("No more select responses");
        return r;
      },
      input: async (_title: string, _placeholder?: string) => {
        const r = ui.inputResponses.shift();
        if (r === undefined) throw new Error("No more input responses");
        return r;
      },
      confirm: async (_title: string, _message: string) => {
        const r = ui.confirmResponses.shift();
        if (r === undefined) throw new Error("No more confirm responses");
        return r;
      },
      notify: (message: string, level?: "info" | "warning" | "error") => {
        ui.notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;
}

interface CapturedCommand {
  name: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function makeMockPi(): { pi: ExtensionAPI; commands: CapturedCommand[] } {
  const commands: CapturedCommand[] = [];
  const pi = {
    on: () => {},
    registerTool: () => {},
    registerProvider: () => {},
    registerCommand: (name: string, handlerOrObj: unknown) => {
      if (typeof handlerOrObj === "object" && handlerOrObj !== null && "handler" in handlerOrObj) {
        commands.push({
          name,
          handler: (
            handlerOrObj as {
              handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
            }
          ).handler,
        });
      }
    },
  } as unknown as ExtensionAPI;
  return { pi, commands };
}

async function invokeSetupModels(
  ui: MockUI,
  settingsPath: string,
  models?: MockModel[],
  currentModel?: MockModel,
): Promise<void> {
  process.env.PI_AGENT_DIR = path.dirname(settingsPath);

  const { registerSetupModelsCommand } = await import("../setup-models.js");
  const { pi, commands } = makeMockPi();
  registerSetupModelsCommand(pi);

  const cmd = commands.find((c) => c.name === "setup-models");
  assert.ok(cmd, "setup-models command should be registered");

  const ctx = makeMockCtx(ui, models, currentModel);
  await cmd.handler("", ctx);
}

function minimalUI(overrides: Partial<MockUI> = {}): MockUI {
  return {
    selectResponses: [
      "Use one model for all sub-agents",
      CLAUDE_LABEL,
      "Skip (keep existing / use defaults)",
    ],
    inputResponses: [],
    confirmResponses: [true], // summary confirm
    notifications: [],
    selectCalls: [],
    ...overrides,
  };
}

function readJson(settingsPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test("setup-models: missing settings file — creates sub-agent model mappings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  const ui = minimalUI();
  await invokeSetupModels(ui, settingsPath);

  assert.ok(fs.existsSync(settingsPath), "settings.json should be created");

  const written = readJson(settingsPath);
  assert.ok("blackbytes" in written, "should have blackbytes key");
  const bb = written.blackbytes as Record<string, unknown>;
  const subAgents = bb.sub_agents as Record<string, Record<string, unknown>>;

  for (const name of ["explore", "oracle", "librarian", "general", "reviewer"]) {
    assert.equal(subAgents[name]?.model, "anthropic/claude-sonnet-4-5");
  }

  assert.equal("anthropic_api_key" in bb, false, "must not write provider keys");
  assert.equal("openai_api_key" in bb, false, "must not write provider keys");
  assert.equal("default_model" in bb, false, "must not write obsolete default_model");
  assert.equal("packages" in bb, false, "must not write provider packages");

  cleanup(dir);
});

test("setup-models: malformed settings file — notifies user and aborts without destroying file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  const badJson = "{ this is not json }";
  fs.writeFileSync(settingsPath, badJson, "utf8");

  const ui: MockUI = {
    selectResponses: [],
    inputResponses: [],
    confirmResponses: [],
    notifications: [],
    selectCalls: [],
  };

  await invokeSetupModels(ui, settingsPath);

  const stillBad = fs.readFileSync(settingsPath, "utf8");
  assert.equal(stillBad, badJson, "malformed file should not be modified");

  const errorNotif = ui.notifications.find((n) => n.level === "error");
  assert.ok(errorNotif, "should emit an error notification");
  assert.ok(
    errorNotif.message.includes("malformed") || errorNotif.message.includes("Setup aborted"),
    `notification: ${errorNotif.message}`,
  );

  cleanup(dir);
});

test("setup-models: preserves existing non-blackbytes and Blackbytes settings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  const existing = {
    other_extension: { foo: "bar" },
    theme: "dark",
    blackbytes: {
      websearch: { provider: "exa", exa_api_key: "exa-secret" },
      context7: { api_key: "ctx7-secret" },
      disabled_tools: ["gh_search"],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(existing), "utf8");

  const ui = minimalUI();
  await invokeSetupModels(ui, settingsPath);

  const written = readJson(settingsPath);
  assert.deepEqual(written.other_extension, existing.other_extension, "other_extension preserved");
  assert.equal(written.theme, "dark", "theme preserved");
  const bb = written.blackbytes as Record<string, unknown>;
  assert.deepEqual(bb.websearch, existing.blackbytes.websearch, "websearch preserved");
  assert.deepEqual(bb.context7, existing.blackbytes.context7, "context7 preserved");
  assert.deepEqual(bb.disabled_tools, ["gh_search"], "disabled_tools preserved");

  cleanup(dir);
});

test("setup-models: atomic write uses .tmp file and private mode for new settings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");
  const tmpPath = `${settingsPath}.tmp`;

  const ui = minimalUI();
  await invokeSetupModels(ui, settingsPath);

  assert.ok(!fs.existsSync(tmpPath), ".tmp file should not remain after atomic write");
  assert.ok(fs.existsSync(settingsPath), "final settings.json should exist");
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600, "new settings should be private");

  cleanup(dir);
});

test("setup-models: preserves symlinked settings.json and target file mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const targetDir = path.join(dir, "target");
  fs.mkdirSync(targetDir);
  const targetPath = path.join(targetDir, "settings.json");
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(targetPath, JSON.stringify({ theme: "dark" }), "utf8");
  fs.chmodSync(targetPath, 0o640);
  fs.symlinkSync(targetPath, settingsPath);

  const ui = minimalUI();
  await invokeSetupModels(ui, settingsPath);

  assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true, "settings symlink is preserved");
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o640, "target mode is preserved");
  const written = readJson(targetPath);
  assert.equal(written.theme, "dark");
  assert.ok((written.blackbytes as Record<string, unknown>).sub_agents);

  cleanup(dir);
});

test("setup-models: confirms before updating existing sub-agent mappings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  const existing = {
    blackbytes: {
      sub_agents: {
        oracle: { model: "openai/old-model", timeoutMs: 12345 },
      },
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(existing), "utf8");

  const ui: MockUI = {
    selectResponses: [],
    inputResponses: [],
    confirmResponses: [false],
    notifications: [],
    selectCalls: [],
  };

  await invokeSetupModels(ui, settingsPath);

  assert.deepEqual(readJson(settingsPath), existing, "settings should remain unchanged");
  const cancelNotif = ui.notifications.find((n) => n.message.toLowerCase().includes("cancel"));
  assert.ok(cancelNotif, "should emit cancellation notification");

  cleanup(dir);
});

test("setup-models: per-agent mode maps different Pi models and can clear one override", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  const ui = minimalUI({
    selectResponses: [
      "Choose model for each sub-agent",
      CLAUDE_LABEL, // explore model
      "\u23ED Skip thinking for all remaining agents", // explore thinking — skip all
      GPT_LABEL, // oracle model
      INHERIT_LABEL, // librarian model
      CLAUDE_LABEL, // general model
      INHERIT_LABEL, // reviewer model
    ],
    confirmResponses: [true], // summary confirm
  });
  await invokeSetupModels(ui, settingsPath);

  const bb = readJson(settingsPath).blackbytes as Record<string, unknown>;
  const subAgents = bb.sub_agents as Record<string, Record<string, unknown>>;

  assert.equal(subAgents.explore.model, "anthropic/claude-sonnet-4-5");
  assert.equal(subAgents.oracle.model, "openai/gpt-5.1");
  assert.equal(subAgents.librarian, undefined, "inherit should remove empty agent override");
  assert.equal(subAgents.general.model, "anthropic/claude-sonnet-4-5");

  cleanup(dir);
});

test("setup-models: optional reasoning setup writes per-agent reasoningEffort", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  const ui = minimalUI({
    selectResponses: [
      "Use one model for all sub-agents",
      CLAUDE_LABEL,
      "Configure thinking per agent", // reasoning mode
      "minimal", // explore
      "high", // oracle
      "medium", // librarian
      "off", // general
      "off", // reviewer
    ],
    confirmResponses: [true], // summary confirm
  });
  await invokeSetupModels(ui, settingsPath);

  const bb = readJson(settingsPath).blackbytes as Record<string, unknown>;
  const subAgents = bb.sub_agents as Record<string, Record<string, unknown>>;

  assert.equal(subAgents.explore.reasoningEffort, "minimal");
  assert.equal(subAgents.oracle.reasoningEffort, "high");
  assert.equal(subAgents.librarian.reasoningEffort, "medium");
  assert.equal(subAgents.general.reasoningEffort, "off");

  cleanup(dir);
});

test("setup-models: includes the current Pi model even when getAvailable() is empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  const ui = minimalUI({
    selectResponses: [
      "Use one model for all sub-agents",
      COPILOT_CURRENT_LABEL,
      "Skip (keep existing / use defaults)",
    ],
    confirmResponses: [true], // summary confirm
  });
  await invokeSetupModels(ui, settingsPath, [], COPILOT_MODEL);

  const bb = readJson(settingsPath).blackbytes as Record<string, unknown>;
  const subAgents = bb.sub_agents as Record<string, Record<string, unknown>>;
  assert.equal(subAgents.oracle.model, "github-copilot/gpt-5-mini");

  cleanup(dir);
});

test("setup-models: can remove legacy provider/default keys from the old wizard", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      blackbytes: {
        anthropic_api_key: "sk-ant-old",
        openai_api_key: "sk-old",
        default_model: "claude-opus-4-5",
        reasoning_effort: "medium",
        packages: ["anthropic", "custom"],
        websearch: { provider: "exa", exa_api_key: "exa-secret" },
      },
    }),
    "utf8",
  );

  const ui = minimalUI({
    confirmResponses: [true, true], // summary confirm + remove legacy keys
  });
  await invokeSetupModels(ui, settingsPath);

  const bb = readJson(settingsPath).blackbytes as Record<string, unknown>;
  assert.equal("anthropic_api_key" in bb, false);
  assert.equal("openai_api_key" in bb, false);
  assert.equal("default_model" in bb, false);
  assert.equal("reasoning_effort" in bb, false);
  assert.deepEqual(bb.packages, ["custom"], "custom passthrough package entries are preserved");
  assert.deepEqual(bb.websearch, { provider: "exa", exa_api_key: "exa-secret" });

  cleanup(dir);
});

test("setup-models: no available models still allows clearing all model overrides", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      blackbytes: {
        sub_agents: {
          oracle: { model: "openai/old", timeoutMs: 12345 },
          stale_yaml_agent: { model: "anthropic/old" },
        },
      },
    }),
    "utf8",
  );

  const ui = minimalUI({
    selectResponses: ["Clear all model overrides (inherit host model)"],
    confirmResponses: [true, true], // update existing + summary
  });
  await invokeSetupModels(ui, settingsPath, []);

  const bb = readJson(settingsPath).blackbytes as Record<string, unknown>;
  const subAgents = bb.sub_agents as Record<string, Record<string, unknown>>;
  assert.deepEqual(subAgents, { oracle: { timeoutMs: 12345 } });
  assert.deepEqual(ui.selectCalls[0]?.options, ["Clear all model overrides (inherit host model)"]);
  assert.ok(ui.notifications.some((n) => n.level === "warning"));

  cleanup(dir);
});
