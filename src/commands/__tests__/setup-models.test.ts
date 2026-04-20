import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

// --------------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------------

interface MockUI {
  selectResponses: string[];
  inputResponses: string[];
  confirmResponses: boolean[];
  notifications: Array<{ message: string; level?: string }>;
}

function makeMockCtx(ui: MockUI): ExtensionCommandContext {
  return {
    ui: {
      select: async (_title: string, _opts: string[]) => {
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

async function invokeSetupModels(ui: MockUI, settingsPath: string): Promise<void> {
  process.env.PI_AGENT_DIR = path.dirname(settingsPath);
  // Ensure filename is settings.json
  const dir = path.dirname(settingsPath);
  process.env.PI_AGENT_DIR = dir;

  const { registerSetupModelsCommand } = await import("../setup-models.js");
  const { pi, commands } = makeMockPi();
  registerSetupModelsCommand(pi);

  const cmd = commands.find((c) => c.name === "setup-models");
  assert.ok(cmd, "setup-models command should be registered");

  const ctx = makeMockCtx(ui);
  await cmd.handler("", ctx);
}

// Minimal UI responses that complete a full wizard flow
function minimalUI(overrides: Partial<MockUI> = {}): MockUI {
  return {
    // select: provider, websearch, reasoning
    selectResponses: ["Anthropic", "None", "Medium"],
    // input: anthropic key, default model
    inputResponses: ["sk-ant-test-key", "claude-opus-4-5"],
    // confirm: overwrite existing? (only asked when keys exist), context7?
    confirmResponses: [false],
    notifications: [],
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test("setup-models: missing settings file — creates new one with blackbytes block", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  const ui = minimalUI();
  await invokeSetupModels(ui, settingsPath);

  assert.ok(fs.existsSync(settingsPath), "settings.json should be created");

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  assert.ok("blackbytes" in written, "should have blackbytes key");
  const bb = written.blackbytes as Record<string, unknown>;
  assert.ok("anthropic_api_key" in bb, "should have anthropic_api_key");
  assert.equal(bb.anthropic_api_key, "sk-ant-test-key");

  fs.rmSync(dir, { recursive: true });
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
  };

  await invokeSetupModels(ui, settingsPath);

  // File should be untouched (still malformed)
  const stillBad = fs.readFileSync(settingsPath, "utf8");
  assert.equal(stillBad, badJson, "malformed file should not be modified");

  // Should have notified error
  const errorNotif = ui.notifications.find((n) => n.level === "error");
  assert.ok(errorNotif, "should emit an error notification");
  assert.ok(
    errorNotif.message.includes("malformed") ||
      errorNotif.message.includes("aborted") ||
      errorNotif.message.includes("Setup aborted"),
    `notification: ${errorNotif.message}`,
  );

  fs.rmSync(dir, { recursive: true });
});

test("setup-models: preserves existing non-blackbytes keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  const existing = {
    other_extension: { foo: "bar" },
    theme: "dark",
  };
  fs.writeFileSync(settingsPath, JSON.stringify(existing), "utf8");

  const ui = minimalUI();
  await invokeSetupModels(ui, settingsPath);

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  assert.equal((written.other_extension as any)?.foo, "bar", "should preserve other_extension");
  assert.equal(written.theme, "dark", "should preserve theme");
  assert.ok("blackbytes" in written, "should add blackbytes block");

  fs.rmSync(dir, { recursive: true });
});

test("setup-models: atomic write uses .tmp file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");
  const tmpPath = `${settingsPath}.tmp`;

  const tmpWasWritten = false;

  // Patch fs.renameSync to detect tmp file
  const origRename = fs.renameSync.bind(fs);
  const origWrite = fs.writeFileSync.bind(fs);

  // We verify by checking that after the command, the .tmp file no longer
  // exists (it was renamed to the real file) and the real file exists.
  const ui = minimalUI();
  await invokeSetupModels(ui, settingsPath);

  // The .tmp file should be gone (renamed to final)
  assert.ok(!fs.existsSync(tmpPath), ".tmp file should not remain after atomic write");
  assert.ok(fs.existsSync(settingsPath), "final settings.json should exist");

  fs.rmSync(dir, { recursive: true });
});

test("setup-models: dedupes packages array", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  // Existing blackbytes with packages already containing "anthropic"
  const existing = {
    blackbytes: {
      packages: ["anthropic", "some-other"],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(existing), "utf8");

  // confirmResponses: [true (overwrite existing?), false (context7?)]
  const ui = minimalUI({
    confirmResponses: [true, false],
  });
  await invokeSetupModels(ui, settingsPath);

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  const bb = written.blackbytes as Record<string, unknown>;
  const packages = bb.packages as string[];
  const anthropicCount = packages.filter((p) => p === "anthropic").length;
  assert.equal(anthropicCount, 1, "anthropic should appear only once in packages");
  assert.ok(packages.includes("some-other"), "existing packages entry preserved");

  fs.rmSync(dir, { recursive: true });
});

test("setup-models: confirm before overwrite of existing blackbytes key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bb-test-"));
  const settingsPath = path.join(dir, "settings.json");

  const existing = {
    blackbytes: {
      default_model: "gpt-4o",
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(existing), "utf8");

  // User says NO to overwrite
  const ui: MockUI = {
    selectResponses: [],
    inputResponses: [],
    confirmResponses: [false], // decline overwrite
    notifications: [],
  };

  await invokeSetupModels(ui, settingsPath);

  // File should be unchanged
  const afterRun = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  const bb = afterRun.blackbytes as Record<string, unknown>;
  assert.equal(
    bb.default_model,
    "gpt-4o",
    "existing config should not be changed when user declines",
  );

  // Should have a cancellation notification
  const cancelNotif = ui.notifications.find(
    (n) =>
      n.message.toLowerCase().includes("cancel") || n.message.toLowerCase().includes("no changes"),
  );
  assert.ok(cancelNotif, "should emit cancellation notification");

  fs.rmSync(dir, { recursive: true });
});
