import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, it, mock } from "node:test";
import { AGENT_HOME_CONFLICT_DIAGNOSTIC, resolveAgentHome } from "../agent-home.js";

const startupCwd = resolve(tmpdir(), "parent");
const userHome = resolve(tmpdir(), "user");
const home = (official?: string, legacy?: string) =>
  resolveAgentHome({
    env: { PI_CODING_AGENT_DIR: official, PI_AGENT_DIR: legacy },
    startupCwd,
    userHome,
  });

describe("agent-home resolution", () => {
  const cases = [
    { name: "default", path: join(userHome, ".pi", "agent"), source: "default" },
    {
      name: "official",
      official: "official",
      path: join(startupCwd, "official"),
      source: "PI_CODING_AGENT_DIR",
    },
    { name: "legacy", legacy: "legacy", path: join(startupCwd, "legacy"), source: "PI_AGENT_DIR" },
    {
      name: "empty official",
      official: "",
      legacy: "legacy",
      path: join(startupCwd, "legacy"),
      source: "PI_AGENT_DIR",
    },
    {
      name: "both empty",
      official: "",
      legacy: "",
      path: join(userHome, ".pi", "agent"),
      source: "default",
    },
    {
      name: "absolute",
      official: join(userHome, "absolute"),
      path: join(userHome, "absolute"),
      source: "PI_CODING_AGENT_DIR",
    },
    {
      name: "relative traversal",
      official: "../home/./nested/..",
      path: resolve(startupCwd, "../home"),
      source: "PI_CODING_AGENT_DIR",
    },
    {
      name: "tilde",
      official: "~/home",
      path: join(userHome, "home"),
      source: "PI_CODING_AGENT_DIR",
    },
    {
      name: "legacy tilde",
      legacy: `~${sep}home`,
      path: join(userHome, "home"),
      source: "PI_AGENT_DIR",
    },
    {
      name: "whitespace",
      official: "  ",
      path: join(startupCwd, "  "),
      source: "PI_CODING_AGENT_DIR",
    },
    {
      name: "surrounding whitespace",
      official: " home ",
      path: join(startupCwd, " home "),
      source: "PI_CODING_AGENT_DIR",
    },
  ];
  for (const row of cases) {
    it(row.name, () => {
      assert.deepEqual(home(row.official, row.legacy), {
        path: row.path,
        source: row.source,
        conflict: false,
      });
    });
  }

  it("compares normalized aliases and freezes the contract", () => {
    const result = home("~/home/../agent", join(userHome, "agent"));
    assert.equal(result.conflict, false);
    assert.equal(result.source, "PI_CODING_AGENT_DIR");
    assert.equal(result.diagnostic, undefined);
    assert.ok(Object.isFrozen(result));
    assert.equal(home("./same/../home", "home").conflict, false);
    assert.equal(home("~//home").path, join(userHome, "home"));
  });

  it("official wins disagreement with exactly one fixed redacted diagnostic", () => {
    const result = home("private-official", "private-legacy");
    assert.equal(result.path, join(startupCwd, "private-official"));
    assert.equal(result.source, "PI_CODING_AGENT_DIR");
    assert.equal(result.conflict, true);
    assert.equal(result.diagnostic, AGENT_HOME_CONFLICT_DIAGNOSTIC);
    assert.doesNotMatch(result.diagnostic ?? "", /private-|parent|user/);
    assert.ok((result.diagnostic?.length ?? 0) < 150);
  });

  it("rejects invalid aliases without leaking values or falling back", () => {
    for (const [official, legacy] of [
      ["private\0bad", "valid"],
      [undefined, "private\0bad"],
      ["valid", "private\0bad"],
    ]) {
      assert.throws(
        () => home(official, legacy),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Invalid agent-home path/);
          assert.doesNotMatch(error.message, /private|\bvalid\b|bad/);
          return true;
        },
      );
    }
    assert.throws(() => resolveAgentHome({ env: {}, startupCwd: "relative", userHome }));
    assert.throws(() => resolveAgentHome({ env: {}, startupCwd, userHome: "relative" }));
  });

  it(
    "rejects Windows drive-relative aliases on same and cross drives",
    { skip: sep !== "\\" },
    () => {
      for (const cwd of ["C:\\startup", "D:\\startup"]) {
        for (const value of ["C:agents", "C:", "c:private-home"]) {
          for (const source of ["PI_CODING_AGENT_DIR", "PI_AGENT_DIR"] as const) {
            assert.throws(
              () =>
                resolveAgentHome({
                  env: { PI_CODING_AGENT_DIR: "valid", [source]: value },
                  startupCwd: cwd,
                  userHome: "C:\\user",
                }),
              { message: `Invalid agent-home path (${source}).` },
            );
          }
        }
      }
    },
  );

  it("preserves Windows absolute drive and UNC paths", { skip: sep !== "\\" }, () => {
    for (const value of [
      "C:\\agents",
      "C:/agents",
      "C:\\",
      "D:\\agents",
      "\\\\server\\share\\agents",
    ]) {
      for (const source of ["PI_CODING_AGENT_DIR", "PI_AGENT_DIR"] as const) {
        assert.equal(
          resolveAgentHome({
            env: { [source]: value },
            startupCwd: "D:\\startup",
            userHome: "C:\\user",
          }).path,
          resolve(value),
        );
      }
    }
  });

  it("preserves drive-like POSIX filenames", { skip: sep === "\\" }, () => {
    for (const value of ["C:agents", "C:", "c:private-home"]) {
      assert.equal(home(value).path, join(startupCwd, value));
      assert.equal(home(undefined, value).path, join(startupCwd, value));
    }
  });

  it("does no filesystem IO, even for nonexistent homes and rejected values", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "agent-home-pure-"));
    try {
      const fail = () => {
        throw new Error("unexpected home IO");
      };
      const spies = [
        mock.method(fs, "readFileSync", fail),
        mock.method(fs, "writeFileSync", fail),
        mock.method(fs, "statSync", fail),
        mock.method(fs, "realpathSync", fail),
        mock.method(fs, "mkdirSync", fail),
        mock.method(fs, "existsSync", fail),
        mock.method(fsp, "readFile", fail),
        mock.method(fsp, "writeFile", fail),
        mock.method(fsp, "stat", fail),
        mock.method(fsp, "realpath", fail),
        mock.method(fsp, "mkdir", fail),
        mock.method(fsp, "access", fail),
      ];
      try {
        const env = Object.freeze({
          PI_CODING_AGENT_DIR: join(dir, "missing"),
          PI_AGENT_DIR: join(dir, "fallback"),
        });
        assert.equal(
          resolveAgentHome({ env, startupCwd: dir, userHome: dir }).path,
          env.PI_CODING_AGENT_DIR,
        );
        assert.equal(
          resolveAgentHome({ env: {}, startupCwd: dir, userHome: dir }).source,
          "default",
        );
        assert.throws(() => home("bad\0path", join(dir, "fallback")));
        for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
      } finally {
        for (const spy of spies) spy.mock.restore();
      }
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("preserves startup cwd across extension module reevaluation", async () => {
  const originalCwd = process.cwd();
  const originalOfficial = process.env.PI_CODING_AGENT_DIR;
  const originalLegacy = process.env.PI_AGENT_DIR;
  const dir = fs.mkdtempSync(join(tmpdir(), "agent-home-reload-"));
  try {
    process.env.PI_CODING_AGENT_DIR = "relative-home";
    delete process.env.PI_AGENT_DIR;
    process.chdir(dir);
    const reloaded = await import(`${new URL("../agent-home.js", import.meta.url).href}?reload`);
    assert.equal(reloaded.resolveStartupAgentHome().path, resolve(originalCwd, "relative-home"));
  } finally {
    process.chdir(originalCwd);
    if (originalOfficial === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalOfficial;
    if (originalLegacy === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = originalLegacy;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
