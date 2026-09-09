import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { type ExtensionCommandContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { handleBlackbytesStatus } from "../../commands/blackbytes-status.js";
import { registerSetupModelsCommand } from "../../commands/setup-models.js";
import { initEnabledSet } from "../../config/enabled-set.js";
import { clearConfigCache, loadBlackbytesConfig } from "../../config/loader.js";
import { getAgentHomeGuidance } from "../../shared/agent-home-guidance.js";
import {
  getAgentHome,
  initSessionAgentHome,
  resetSessionRuntimeState,
} from "../../shared/session-state.js";
import { resolveSystemPromptLogPath } from "../../shared/system-prompt-log.js";
import {
  captureArtifact,
  cleanupArtifacts,
  getArtifactStats,
  resolveArtifactDir,
} from "../../sub-agents/artifacts.js";
import { loadYamlDeclarations } from "../../sub-agents/loader.js";
import { runNestedPi } from "../../sub-agents/runner.js";
import { createMockPi } from "../../test-utils/pi-mock.js";
import { registerCleanReadRenderer } from "../../tools/hashline-edit/read-renderer.js";

const envKeys = [
  "HOME",
  "USERPROFILE",
  "PI_CODING_AGENT_DIR",
  "PI_AGENT_DIR",
  "PI_NESTED_DEPTH",
  "NODE_ENV",
] as const;
let savedEnv: Array<string | undefined>;
let root: string;
let cwd: string;
let fallback: string;

beforeEach(async () => {
  savedEnv = envKeys.map((key) => process.env[key]);
  resetSessionRuntimeState();
  clearConfigCache();
  root = await fsp.mkdtemp(join(tmpdir(), "bb-home-consumers-"));
  cwd = join(root, "child-repository");
  fallback = join(root, ".pi", "agent");
  await fsp.mkdir(cwd);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_AGENT_DIR;
  delete process.env.PI_NESTED_DEPTH;
  // Exercise the actual cache, not its NODE_ENV=test bypass.
  process.env.NODE_ENV = "production";
});

afterEach(async () => {
  mock.restoreAll();
  resetSessionRuntimeState();
  clearConfigCache();
  envKeys.forEach((key, index) => {
    const value = savedEnv[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  await fsp.rm(root, { recursive: true, force: true });
});

async function fixture(home: string, model = "fixture/old"): Promise<void> {
  await fsp.mkdir(join(home, "sub-agents"), { recursive: true });
  await fsp.writeFile(
    join(home, "settings.json"),
    JSON.stringify({
      images: { autoResize: false },
      blackbytes: { sub_agents: { explore: { model } } },
      unrelated: "preserved",
    }),
  );
  await fsp.writeFile(
    join(home, "sub-agents", "local.yaml"),
    "name: local\ndescription: fixture\nsystem_prompt: fixture\nallowed_tools: [read]\n",
  );
}

async function clearWizard(): Promise<string[]> {
  const pi = createMockPi();
  registerSetupModelsCommand(pi);
  const command = pi.calls.registerCommand[0] as {
    options: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };
  };
  const notifications: string[] = [];
  await command.options.handler("", {
    cwd,
    modelRegistry: { refresh: () => {}, getAvailable: () => [], getError: () => undefined },
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async () => "Clear all model overrides (inherit host model)",
      confirm: async () => true,
    },
  } as unknown as ExtensionCommandContext);
  return notifications;
}

async function childHome(): Promise<void> {
  const parent = { ...process.env };
  const result = await runNestedPi(
    {
      systemPrompt: "fixture",
      userPrompt: "fixture",
      allowedTools: ["read"],
      cwd,
    },
    (_command, _args, options) => {
      const forwarded = options.env ?? {};
      const selected = getAgentHome().path;
      assert.equal(forwarded.PI_CODING_AGENT_DIR, selected);
      assert.equal(forwarded.PI_AGENT_DIR, selected);
      assert.equal(options.cwd, cwd);
      assert.notEqual(selected, cwd);
      const allowed = new Set([
        "PATH",
        "HOME",
        "USER",
        "SHELL",
        "TERM",
        "NODE_ENV",
        "PI_CODING_AGENT_DIR",
        "PI_AGENT_DIR",
        "PI_NESTED_DEPTH",
      ]);
      assert.ok(Object.keys(forwarded).every((key) => allowed.has(key)));
      assert.equal(forwarded.PI_NESTED_DEPTH, "1");
      // No Pi/model execution: real child process proves the received env/cwd.
      return spawn(
        process.execPath,
        [
          "-e",
          `console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:JSON.stringify({home:process.env.PI_CODING_AGENT_DIR,legacy:process.env.PI_AGENT_DIR,cwd:process.cwd()})}]}]}))`,
        ],
        options,
      );
    },
  );
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.content), {
    home: getAgentHome().path,
    legacy: getAgentHome().path,
    cwd,
  });
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(parent), "parent env unchanged");
}

describe("selected home consumer matrix", () => {
  for (const mode of [
    "default",
    "official",
    "legacy",
    "equal",
    "conflicting",
    "empty",
    "empty official",
    "relative",
    "tilde",
    "whitespace",
  ] as const) {
    it(mode, async () => {
      const selected =
        mode === "default" || mode === "empty"
          ? fallback
          : join(root, mode === "whitespace" ? "  " : " selected home ");
      await fixture(selected);
      if (selected !== fallback) await fixture(fallback, "trap/default");
      const ignored = join(root, "ignored-home");
      await fixture(ignored, "trap/ignored");
      if (mode !== "default" && mode !== "empty") process.env.PI_CODING_AGENT_DIR = selected;
      if (mode === "legacy" || mode === "empty official") {
        process.env.PI_CODING_AGENT_DIR = "";
        process.env.PI_AGENT_DIR = selected;
      }
      if (mode === "equal") process.env.PI_AGENT_DIR = join(selected, "..", " selected home ");
      if (mode === "conflicting") process.env.PI_AGENT_DIR = ignored;
      if (mode === "relative") process.env.PI_CODING_AGENT_DIR = relative(process.cwd(), selected);
      if (mode === "tilde") process.env.PI_CODING_AGENT_DIR = "~/ selected home ";
      if (mode === "empty") {
        process.env.PI_CODING_AGENT_DIR = "";
        process.env.PI_AGENT_DIR = "";
      }
      const snapshot = initSessionAgentHome();
      assert.equal(snapshot.path, selected);
      // Drift must not retarget any consumer or its cache key during this session.
      process.env.PI_CODING_AGENT_DIR = ignored;
      process.env.PI_AGENT_DIR = ignored;
      const reads: string[] = [];
      const readAsync = fsp.readFile;
      const readSync = fs.readFileSync;
      mock.method(fsp, "readFile", (...args: Parameters<typeof fsp.readFile>) => {
        reads.push(String(args[0]));
        return readAsync(...args);
      });
      mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        reads.push(String(args[0]));
        return readSync(...args);
      });
      const config = await loadBlackbytesConfig();
      assert.equal(config.sub_agents?.explore?.model, "fixture/old");
      assert.strictEqual(await loadBlackbytesConfig(), config);
      initEnabledSet(config);
      const yaml = await loadYamlDeclarations();
      assert.equal(yaml.diagnostics.directory, join(selected, "sub-agents"));
      assert.equal(yaml.declarations[0]?.name, "local");
      assert.equal(yaml.declarations[0]?.sourcePath, join(selected, "sub-agents", "local.yaml"));
      const createSettings = mock.method(SettingsManager, "create");
      let autoResize: boolean | undefined;
      registerCleanReadRenderer(createMockPi(), cwd, {
        factory: (_cwd, options) => {
          autoResize = options?.autoResizeImages;
          return {};
        },
      });
      assert.equal(createSettings.mock.calls[0]?.arguments[1], selected);
      assert.equal(autoResize, false);
      await childHome();
      const artifact = await captureArtifact({
        agent: "explore",
        content: "fixture ".repeat(200),
        startedAt: 0,
        durationMs: 1,
      });
      assert.ok(artifact?.path.startsWith(resolveArtifactDir()));
      const stats = await getArtifactStats();
      assert.equal(stats.directory, join(selected, "blackbytes", "artifacts", "sub-agents"));
      assert.equal(stats.status, "ok");
      if (stats.status === "ok") assert.equal(stats.count, 1);
      assert.equal(await cleanupArtifacts(), 0);
      assert.ok(artifact);
      await fsp.utimes(artifact.path, new Date(0), new Date(0));
      assert.equal(await cleanupArtifacts(), 1);
      const notifications = await clearWizard();
      assert.ok(notifications.some((line) => line.startsWith("Model mappings saved")));
      assert.equal((await loadBlackbytesConfig()).sub_agents?.explore?.model, undefined);
      assert.equal(
        JSON.parse(await fsp.readFile(join(selected, "settings.json"), "utf8")).unrelated,
        "preserved",
      );
      const status = await handleBlackbytesStatus();
      assert.ok(
        status.includes(
          `Agent home source: ${snapshot.source}; alias conflict: ${snapshot.conflict ? "yes" : "no"}.`,
        ),
      );
      const guidance = getAgentHomeGuidance(snapshot);
      if (guidance) assert.ok(status.includes(guidance));
      assert.equal(
        resolveSystemPromptLogPath("./custom-log.jsonl", cwd),
        join(cwd, "custom-log.jsonl"),
      );
      assert.ok(reads.every((file) => !file.startsWith(ignored)));
      if (selected !== fallback) assert.ok(reads.every((file) => !file.startsWith(fallback)));
      assert.ok(
        reads.every((file) => !file.endsWith("auth.json") && !file.endsWith("models.json")),
      );
      mock.restoreAll();
      assert.equal(
        JSON.parse(await fsp.readFile(join(ignored, "settings.json"), "utf8")).blackbytes.sub_agents
          .explore.model,
        "trap/ignored",
      );
      assert.deepEqual(await fsp.readdir(ignored), ["settings.json", "sub-agents"]);
      if (selected !== fallback)
        assert.deepEqual(await fsp.readdir(fallback), ["settings.json", "sub-agents"]);
    });
  }
});

it("missing, malformed and unreadable selected files never fall back; artifact failures remain contained", async () => {
  await fixture(fallback, "trap/default");
  const selected = join(root, "new-home");
  process.env.PI_CODING_AGENT_DIR = selected;
  initSessionAgentHome();
  assert.equal((await loadBlackbytesConfig()).sub_agents?.explore, undefined);
  assert.deepEqual((await loadYamlDeclarations()).declarations, []);
  assert.equal((await getArtifactStats()).status, "unavailable");
  assert.equal(await cleanupArtifacts(), 0);
  await fixture(selected);
  clearConfigCache();
  await fsp.writeFile(join(selected, "settings.json"), "{malformed");
  await fsp.writeFile(join(selected, "sub-agents", "local.yaml"), "[malformed");
  assert.equal((await loadBlackbytesConfig()).sub_agents?.explore, undefined);
  assert.match(
    (await loadYamlDeclarations()).diagnostics.skippedFiles[0]?.reason ?? "",
    /YAML syntax/,
  );
  assert.ok((await clearWizard()).some((line) => line.includes("malformed JSON")));
  assert.equal(await fsp.readFile(join(selected, "settings.json"), "utf8"), "{malformed");
  // Directory-as-file is deterministically unreadable even when tests run as root.
  await fsp.rm(join(selected, "settings.json"));
  await fsp.mkdir(join(selected, "settings.json"));
  clearConfigCache();
  assert.equal((await loadBlackbytesConfig()).sub_agents?.explore, undefined);
  assert.ok((await clearWizard()).some((line) => line.includes("Cannot read settings file")));
  await fsp.rm(join(selected, "sub-agents"), { recursive: true });
  await fsp.writeFile(join(selected, "sub-agents"), "not a directory");
  assert.match(
    (await loadYamlDeclarations()).diagnostics.skippedFiles[0]?.reason ?? "",
    /Failed to read directory/,
  );
  await fsp.writeFile(join(selected, "blackbytes"), "not a directory");
  await assert.rejects(
    captureArtifact({ agent: "explore", content: "x".repeat(2000), startedAt: 0, durationMs: 1 }),
  );
  assert.equal((await getArtifactStats()).status, "unavailable");
  assert.equal(await cleanupArtifacts(), 0);
  assert.deepEqual(await fsp.readdir(fallback), ["settings.json", "sub-agents"]);
});

it("pre-session cache follows selected home and guidance is fixed, bounded and path-free", async () => {
  const first = join(root, "first");
  const second = join(root, "second");
  await fixture(first, "fixture/first");
  await fixture(second, "fixture/second");
  process.env.PI_AGENT_DIR = first;
  assert.equal((await loadBlackbytesConfig()).sub_agents?.explore?.model, "fixture/first");
  await childHome();
  process.env.PI_AGENT_DIR = second;
  assert.equal((await loadBlackbytesConfig()).sub_agents?.explore?.model, "fixture/second");
  await childHome();
  const legacy = getAgentHomeGuidance(getAgentHome());
  assert.match(legacy ?? "", /Parent Pi auth\/model registry may already/);
  assert.match(legacy ?? "", /Restart Pi with PI_CODING_AGENT_DIR/);
  assert.ok(!legacy?.includes(root));
  assert.ok((legacy?.length ?? 0) < 400);
  process.env.PI_CODING_AGENT_DIR = first;
  const conflict = getAgentHomeGuidance(getAgentHome());
  assert.match(conflict ?? "", /remove PI_AGENT_DIR/);
  assert.ok(!conflict?.includes(root));
  assert.ok((conflict?.length ?? 0) < 400);
});

it("invalid selected home rejects consumers before any fallback I/O or child spawn", async () => {
  // Node's native env setter truncates NUL; use an ordinary env object to exercise
  // the delivered resolver's invalid-input contract without changing that contract.
  const originalEnv = process.env;
  const readAsync = mock.method(fsp, "readFile");
  const readDirectory = mock.method(fsp, "readdir");
  const settings = mock.method(SettingsManager, "create");
  try {
    process.env = { PI_CODING_AGENT_DIR: "invalid\0home" };
    await assert.rejects(loadBlackbytesConfig(), /Invalid agent-home path/);
    await assert.rejects(loadYamlDeclarations(), /Invalid agent-home path/);
    await assert.rejects(clearWizard(), /Invalid agent-home path/);
    assert.throws(() => resolveArtifactDir(), /Invalid agent-home path/);
    await assert.rejects(
      runNestedPi(
        {
          systemPrompt: "fixture",
          userPrompt: "fixture",
          allowedTools: ["read"],
          cwd,
        },
        () => {
          throw new Error("must not spawn");
        },
      ),
      /Invalid agent-home path/,
    );
    registerCleanReadRenderer(createMockPi(), cwd, { factory: () => ({}) });
    assert.equal(settings.mock.callCount(), 0);
    assert.equal(readAsync.mock.callCount(), 0);
    assert.equal(readDirectory.mock.callCount(), 0);
  } finally {
    process.env = originalEnv;
  }
});
