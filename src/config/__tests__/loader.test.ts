import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Helper: create a temp dir with optional settings.json content
async function withTempSettings(
  content: string | null,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-blackbytes-test-"));
  try {
    if (content !== null) {
      await fs.writeFile(path.join(dir, "settings.json"), content, "utf8");
    }
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Helper: run loadBlackbytesConfig with PI_AGENT_DIR set to dir
async function loadWith(dir: string) {
  // Bypass module cache by using dynamic import with a cache-buster isn't
  // reliable in ESM. Instead, set the env var and re-import the function.
  const origDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = dir;
  try {
    // Dynamic import with cache-bust so env var is read fresh each time
    const { loadBlackbytesConfig } = await import("../loader.js");
    return await loadBlackbytesConfig();
  } finally {
    if (origDir === undefined) {
      delete process.env.PI_AGENT_DIR;
    } else {
      process.env.PI_AGENT_DIR = origDir;
    }
  }
}

test("missing settings file returns defaults", async () => {
  await withTempSettings(null, async (dir) => {
    const config = await loadWith(dir);
    // defaults: disabled_tools=[], disabled_sub_agents=[], hashline_edit=true
    assert.deepEqual(config.disabled_tools, []);
    assert.deepEqual(config.disabled_sub_agents, []);
    assert.equal(config.hashline_edit, true);
  });
});

test("malformed JSON returns defaults", async () => {
  await withTempSettings("{ not valid json }", async (dir) => {
    const config = await loadWith(dir);
    assert.deepEqual(config.disabled_tools, []);
  });
});

test("missing blackbytes key returns defaults", async () => {
  await withTempSettings(JSON.stringify({ other: "stuff" }), async (dir) => {
    const config = await loadWith(dir);
    assert.deepEqual(config.disabled_tools, []);
  });
});

test("invalid blackbytes data returns defaults", async () => {
  const settings = { blackbytes: { disabled_tools: "not-an-array" } };
  await withTempSettings(JSON.stringify(settings), async (dir) => {
    const config = await loadWith(dir);
    assert.deepEqual(config.disabled_tools, []);
  });
});

test("valid config returns parsed config", async () => {
  const blackbytes = {
    disabled_tools: ["tool1", "tool2"],
    disabled_sub_agents: ["explore"],
    hashline_edit: false,
  };
  const settings = { blackbytes };
  await withTempSettings(JSON.stringify(settings), async (dir) => {
    const config = await loadWith(dir);
    assert.deepEqual(config.disabled_tools, ["tool1", "tool2"]);
    assert.deepEqual(config.disabled_sub_agents, ["explore"]);
    assert.equal(config.hashline_edit, false);
  });
});
