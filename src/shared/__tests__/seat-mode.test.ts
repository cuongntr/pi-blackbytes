import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveDefaultLogDir } from "../logger.js";
import { getSeatRole, isSeatMode } from "../seat-mode.js";
import { resolveSystemPromptLogPath } from "../system-prompt-log.js";

const saved = {
  role: process.env.PASEO_ROOM_ROLE,
  official: process.env.PI_CODING_AGENT_DIR,
  legacy: process.env.PI_AGENT_DIR,
};

function restore(key: "PASEO_ROOM_ROLE" | "PI_CODING_AGENT_DIR" | "PI_AGENT_DIR", v?: string) {
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
}

afterEach(() => {
  restore("PASEO_ROOM_ROLE", saved.role);
  restore("PI_CODING_AGENT_DIR", saved.official);
  restore("PI_AGENT_DIR", saved.legacy);
});

describe("seat mode detection", () => {
  it("is off when PASEO_ROOM_ROLE is unset or blank", () => {
    assert.equal(isSeatMode({}), false);
    assert.equal(isSeatMode({ PASEO_ROOM_ROLE: "" }), false);
    assert.equal(isSeatMode({ PASEO_ROOM_ROLE: "   " }), false);
    assert.equal(getSeatRole({ PASEO_ROOM_ROLE: "" }), undefined);
  });

  it("is on for any non-empty role, all roles treated alike", () => {
    for (const role of ["lead", "worker", "reviewer", "anything-else"]) {
      assert.equal(isSeatMode({ PASEO_ROOM_ROLE: role }), true);
      assert.equal(getSeatRole({ PASEO_ROOM_ROLE: role }), role);
    }
  });
});

describe("seat mode log locations", () => {
  it("places logs under <agent dir>/logs in seat mode", () => {
    const agentDir = path.resolve(os.tmpdir(), "seat-agent-dir");
    process.env.PASEO_ROOM_ROLE = "lead";
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_AGENT_DIR;

    assert.equal(resolveDefaultLogDir(), path.join(agentDir, "logs"));
    assert.equal(
      resolveSystemPromptLogPath(undefined, process.cwd()),
      path.join(agentDir, "logs", "pi-blackbytes-system-prompts.jsonl"),
    );
    assert.ok(
      !resolveDefaultLogDir().startsWith(path.join(os.homedir(), ".pi")),
      "must not point at ~/.pi in seat mode",
    );
  });

  it("keeps ~/.pi/logs outside seat mode", () => {
    delete process.env.PASEO_ROOM_ROLE;
    process.env.PI_CODING_AGENT_DIR = path.resolve(os.tmpdir(), "non-seat-agent-dir");
    assert.equal(resolveDefaultLogDir(), path.join(os.homedir(), ".pi", "logs"));
  });
});
