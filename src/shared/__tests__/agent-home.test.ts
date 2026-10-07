import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  AGENT_HOME_CONFLICT_DIAGNOSTIC,
  getAgentHome,
  getAgentHomePath,
  resolveAgentHome,
} from "../agent-home.js";

const CWD = path.resolve(os.tmpdir(), "agent-home-cwd");
const HOME = path.resolve(os.tmpdir(), "agent-home-user");

function resolveWith(env: Record<string, string | undefined>) {
  return resolveAgentHome({ env, cwd: CWD, userHome: HOME });
}

describe("resolveAgentHome", () => {
  it("uses PI_CODING_AGENT_DIR when only it is set", () => {
    const dir = path.resolve(os.tmpdir(), "official-dir");
    const home = resolveWith({ PI_CODING_AGENT_DIR: dir });
    assert.equal(home.path, dir);
    assert.equal(home.source, "PI_CODING_AGENT_DIR");
    assert.equal(home.conflict, false);
    assert.equal(home.diagnostic, undefined);
  });

  it("uses PI_AGENT_DIR when only it is set (legacy behaviour preserved)", () => {
    const dir = path.resolve(os.tmpdir(), "legacy-dir");
    const home = resolveWith({ PI_AGENT_DIR: dir });
    assert.equal(home.path, dir);
    assert.equal(home.source, "PI_AGENT_DIR");
    assert.equal(home.conflict, false);
  });

  it("prefers PI_CODING_AGENT_DIR and flags a conflict when both differ", () => {
    const official = path.resolve(os.tmpdir(), "official-dir");
    const legacy = path.resolve(os.tmpdir(), "legacy-dir");
    const home = resolveWith({ PI_CODING_AGENT_DIR: official, PI_AGENT_DIR: legacy });
    assert.equal(home.path, official);
    assert.equal(home.source, "PI_CODING_AGENT_DIR");
    assert.equal(home.conflict, true);
    assert.equal(home.diagnostic, AGENT_HOME_CONFLICT_DIAGNOSTIC);
    assert.ok(!home.diagnostic?.includes(official), "diagnostic must not leak paths");
    assert.ok(!home.diagnostic?.includes(legacy), "diagnostic must not leak paths");
  });

  it("does not flag a conflict when both are set to the same directory", () => {
    const dir = path.resolve(os.tmpdir(), "same-dir");
    const home = resolveWith({ PI_CODING_AGENT_DIR: dir, PI_AGENT_DIR: `${dir}${path.sep}` });
    assert.equal(home.path, dir);
    assert.equal(home.conflict, false);
  });

  it("falls back to ~/.pi/agent when neither is set", () => {
    const home = resolveWith({});
    assert.equal(home.path, path.join(HOME, ".pi", "agent"));
    assert.equal(home.source, "default");
    assert.equal(home.conflict, false);
  });

  it("treats the empty string as unset", () => {
    const legacy = path.resolve(os.tmpdir(), "legacy-dir");
    const home = resolveWith({ PI_CODING_AGENT_DIR: "", PI_AGENT_DIR: legacy });
    assert.equal(home.path, legacy);
    assert.equal(home.source, "PI_AGENT_DIR");
  });

  it("expands ~ and resolves relative paths against cwd", () => {
    assert.equal(
      resolveWith({ PI_CODING_AGENT_DIR: "~/custom/agent" }).path,
      path.join(HOME, "custom", "agent"),
    );
    assert.equal(
      resolveWith({ PI_CODING_AGENT_DIR: "rel/agent" }).path,
      path.join(CWD, "rel", "agent"),
    );
  });
});

describe("getAgentHome (process env)", () => {
  const saved = {
    official: process.env.PI_CODING_AGENT_DIR,
    legacy: process.env.PI_AGENT_DIR,
  };

  afterEach(() => {
    if (saved.official === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.official;
    if (saved.legacy === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = saved.legacy;
  });

  it("reads the live environment on every call (no caching)", () => {
    const a = path.resolve(os.tmpdir(), "live-a");
    const b = path.resolve(os.tmpdir(), "live-b");
    delete process.env.PI_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = a;
    assert.equal(getAgentHomePath(), a);
    process.env.PI_CODING_AGENT_DIR = b;
    assert.equal(getAgentHome().path, b);
  });
});
