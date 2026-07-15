import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const cliPath = resolve(__dirname, "..", "cli.ts");

/**
 * Run the CLI with given args and return { stdout, stderr, status }.
 */
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const result = execFileSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      encoding: "utf-8",
      cwd: resolve(__dirname, "..", "..", ".."),
    });
    return { stdout: result, stderr: "", status: 0 };
  } catch (err: unknown) {
    const error = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      status: error.status ?? 1,
    };
  }
}

describe("cli", () => {
  describe("--help", () => {
    it("should exit 0 with --help flag", () => {
      const { stdout, stderr, status } = runCli(["--help"]);
      assert.equal(status, 0);
      assert.ok(stdout.includes("Usage:"));
      assert.equal(stderr, "");
    });

    it("should include every confirmation and hard-stop option", () => {
      const { stdout, status } = runCli(["--help"]);
      assert.equal(status, 0);
      for (const option of ["--dry-run", "--confirm", "--decline", "--not-applicable"]) {
        assert.ok(stdout.includes(option), `missing help option ${option}`);
      }
    });
  });

  describe("missing command", () => {
    it("should exit 1 with E_EVAL_CONFIG", () => {
      const { stdout, stderr, status } = runCli([]);
      assert.equal(status, 1);
      assert.equal(stdout, "");
      const err = JSON.parse(stderr.trim());
      assert.equal(err.code, "E_EVAL_CONFIG");
      assert.ok(err.message.includes("command"));
    });
  });

  describe("unknown commands", () => {
    it("should exit 1 with E_EVAL_CONFIG for unknown command", () => {
      const { stdout, stderr, status } = runCli(["unknown-command"]);
      assert.equal(status, 1);
      assert.equal(stdout, "");
      const err = JSON.parse(stderr.trim());
      assert.equal(err.code, "E_EVAL_CONFIG");
      assert.ok(err.message.includes("unknown-command"));
    });

    it("should exit 1 with E_EVAL_CONFIG for gibberish", () => {
      const { stdout, stderr, status } = runCli(["!@#$%"]);
      assert.equal(status, 1);
      assert.equal(stdout, "");
      const err = JSON.parse(stderr.trim());
      assert.equal(err.code, "E_EVAL_CONFIG");
    });
  });

  describe("qualification commands", () => {
    for (const command of ["qualify", "adjudicate"]) {
      it(`requires a content-free input for '${command}'`, () => {
        const { stderr, status } = runCli([command]);
        assert.equal(status, 1);
        const error = JSON.parse(stderr.trim());
        assert.equal(error.code, "E_EVAL_CONFIG");
        assert.ok(error.message.includes("--input"));
      });
    }
  });

  describe("freeze command", () => {
    it("requires private-run and input arguments", () => {
      const { stderr, status } = runCli(["freeze"]);
      assert.equal(status, 1);
      const error = JSON.parse(stderr.trim());
      assert.equal(error.code, "E_EVAL_CONFIG");
      assert.ok(error.message.includes("--run-id"));
    });
  });

  describe("known but unimplemented commands", () => {
    const commands = [
      "init",
      "inventory",
      "sample",
      "select-target",
      "replay",
      "score",
      "lifecycle",
      "decide",
      "report",
      "verify",
      "cleanup",
    ];

    for (const cmd of commands) {
      it(`should exit 1 with E_EVAL_INCOMPLETE for '${cmd}'`, () => {
        const { stdout, stderr, status } = runCli([cmd]);
        assert.equal(status, 1);
        assert.equal(stdout, "");
        const err = JSON.parse(stderr.trim());
        assert.equal(err.code, "E_EVAL_INCOMPLETE");
        assert.ok(err.message.includes(cmd));
      });
    }
  });
});
