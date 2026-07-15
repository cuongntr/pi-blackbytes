import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLI_COMMANDS, E_EVAL_CODES, SCHEMA_VERSION } from "../types.js";

describe("types", () => {
  describe("E_EVAL_CODES", () => {
    it("should contain all 7 error codes", () => {
      assert.equal(E_EVAL_CODES.length, 7);
    });

    it("should include E_EVAL_CONFIG", () => {
      assert.ok(E_EVAL_CODES.includes("E_EVAL_CONFIG"));
    });

    it("should include E_EVAL_PRIVACY", () => {
      assert.ok(E_EVAL_CODES.includes("E_EVAL_PRIVACY"));
    });

    it("should include E_EVAL_INTEGRITY", () => {
      assert.ok(E_EVAL_CODES.includes("E_EVAL_INTEGRITY"));
    });

    it("should include E_EVAL_SCHEMA", () => {
      assert.ok(E_EVAL_CODES.includes("E_EVAL_SCHEMA"));
    });

    it("should include E_EVAL_INCOMPLETE", () => {
      assert.ok(E_EVAL_CODES.includes("E_EVAL_INCOMPLETE"));
    });

    it("should include E_EVAL_PROVIDER", () => {
      assert.ok(E_EVAL_CODES.includes("E_EVAL_PROVIDER"));
    });

    it("should include E_EVAL_UNSAFE_PATH", () => {
      assert.ok(E_EVAL_CODES.includes("E_EVAL_UNSAFE_PATH"));
    });
  });

  describe("SCHEMA_VERSION", () => {
    it("should be 1", () => {
      assert.equal(SCHEMA_VERSION, 1);
    });
  });

  describe("CLI_COMMANDS", () => {
    it("should contain all 14 commands", () => {
      assert.equal(CLI_COMMANDS.length, 14);
    });

    it("should include init", () => {
      assert.ok(CLI_COMMANDS.includes("init"));
    });

    it("should include inventory", () => {
      assert.ok(CLI_COMMANDS.includes("inventory"));
    });

    it("should include sample", () => {
      assert.ok(CLI_COMMANDS.includes("sample"));
    });

    it("should include select-target", () => {
      assert.ok(CLI_COMMANDS.includes("select-target"));
    });

    it("should include qualify", () => {
      assert.ok(CLI_COMMANDS.includes("qualify"));
    });

    it("should include adjudicate", () => {
      assert.ok(CLI_COMMANDS.includes("adjudicate"));
    });

    it("should include freeze", () => {
      assert.ok(CLI_COMMANDS.includes("freeze"));
    });

    it("should include replay", () => {
      assert.ok(CLI_COMMANDS.includes("replay"));
    });

    it("should include score", () => {
      assert.ok(CLI_COMMANDS.includes("score"));
    });

    it("should include lifecycle", () => {
      assert.ok(CLI_COMMANDS.includes("lifecycle"));
    });

    it("should include decide", () => {
      assert.ok(CLI_COMMANDS.includes("decide"));
    });

    it("should include report", () => {
      assert.ok(CLI_COMMANDS.includes("report"));
    });

    it("should include verify", () => {
      assert.ok(CLI_COMMANDS.includes("verify"));
    });

    it("should include cleanup", () => {
      assert.ok(CLI_COMMANDS.includes("cleanup"));
    });
  });
});
