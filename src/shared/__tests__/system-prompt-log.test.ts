import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseBlackbytesConfig } from "../../config/schema.js";
import {
  _resetSystemPromptLogDedupe,
  captureAgentStartSystemPrompt,
  captureProviderSystemPrompts,
  extractProviderSystemPrompts,
  getSystemPromptLogConfig,
  resolveSystemPromptLogPath,
} from "../system-prompt-log.js";

function parseConfig(input: Record<string, unknown>) {
  const result = parseBlackbytesConfig(input);
  if (!result.ok) throw new Error(result.errors.join(", "));
  return result.value;
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-blackbytes-system-prompt-log-test-"));
}

function makeCtx(cwd: string, prompt: string): ExtensionContext {
  return {
    cwd,
    model: { provider: "openai", id: "gpt-5.4" },
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => path.join(cwd, "session.jsonl"),
    },
    getSystemPrompt: () => prompt,
  } as unknown as ExtensionContext;
}

describe("system prompt logging", () => {
  const originalNestedDepth = process.env.PI_NESTED_DEPTH;

  beforeEach(() => {
    _resetSystemPromptLogDedupe();
    delete process.env.PI_NESTED_DEPTH;
  });

  afterEach(() => {
    _resetSystemPromptLogDedupe();
    if (originalNestedDepth === undefined) {
      delete process.env.PI_NESTED_DEPTH;
    } else {
      process.env.PI_NESTED_DEPTH = originalNestedDepth;
    }
  });

  it("normalizes omitted config to disabled safe defaults", () => {
    const config = getSystemPromptLogConfig(parseConfig({}));
    assert.equal(config.enabled, false);
    assert.equal(config.capture_agent_start, true);
    assert.equal(config.capture_provider_system, false);
    assert.equal(config.include_nested, false);
    assert.equal(config.dedupe, true);
  });

  it("resolves relative configured paths against cwd", async () => {
    const tmp = await makeTempDir();
    try {
      assert.equal(
        resolveSystemPromptLogPath("logs/prompts.jsonl", tmp),
        path.join(tmp, "logs/prompts.jsonl"),
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("captures agent_start prompt as JSONL and dedupes identical entries", async () => {
    const tmp = await makeTempDir();
    try {
      const logPath = path.join(tmp, "prompts.jsonl");
      const config = parseConfig({
        system_prompt_log: {
          enabled: true,
          path: logPath,
        },
      });
      const ctx = makeCtx(tmp, "SYSTEM PROMPT");

      await captureAgentStartSystemPrompt(config, ctx);
      await captureAgentStartSystemPrompt(config, ctx);

      const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]) as Record<string, unknown>;
      assert.equal(entry.source, "agent_start");
      assert.equal(entry.prompt, "SYSTEM PROMPT");
      assert.equal(entry.model, "openai/gpt-5.4");
      assert.equal(entry.sessionId, "session-123");
      assert.equal(entry.chars, "SYSTEM PROMPT".length);
      assert.equal(typeof entry.sha256, "string");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("skips nested sessions unless include_nested is enabled", async () => {
    const tmp = await makeTempDir();
    try {
      process.env.PI_NESTED_DEPTH = "1";
      const logPath = path.join(tmp, "prompts.jsonl");
      const config = parseConfig({
        system_prompt_log: {
          enabled: true,
          path: logPath,
        },
      });

      await captureAgentStartSystemPrompt(config, makeCtx(tmp, "NESTED PROMPT"));

      await assert.rejects(() => fs.readFile(logPath, "utf8"), { code: "ENOENT" });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("extracts provider system prompts without user messages", () => {
    const extractions = extractProviderSystemPrompts({
      messages: [
        { role: "system", content: "SYSTEM ONLY" },
        { role: "developer", content: [{ type: "text", text: "DEVELOPER ONLY" }] },
        { role: "user", content: "USER SHOULD NOT BE CAPTURED" },
      ],
    });

    assert.equal(extractions.length, 1);
    assert.equal(extractions[0].providerShape, "payload.messages[role=system|developer]");
    assert.equal(extractions[0].prompt, "SYSTEM ONLY\n\nDEVELOPER ONLY");
  });

  it("extracts common Anthropic and Gemini provider shapes", () => {
    assert.deepEqual(
      extractProviderSystemPrompts({ system: [{ type: "text", text: "ANTHROPIC" }] }),
      [{ providerShape: "payload.system", prompt: "ANTHROPIC" }],
    );

    assert.deepEqual(
      extractProviderSystemPrompts({
        config: { systemInstruction: { parts: [{ text: "GEMINI" }] } },
      }),
      [{ providerShape: "payload.config.systemInstruction", prompt: "GEMINI" }],
    );
  });

  it("captures provider system extraction when explicitly enabled", async () => {
    const tmp = await makeTempDir();
    try {
      const logPath = path.join(tmp, "provider-prompts.jsonl");
      const config = parseConfig({
        system_prompt_log: {
          enabled: true,
          path: logPath,
          capture_agent_start: false,
          capture_provider_system: true,
        },
      });

      await captureProviderSystemPrompts(
        config,
        {
          input: [
            { role: "developer", content: [{ type: "input_text", text: "WIRE SYSTEM" }] },
            { role: "user", content: [{ type: "input_text", text: "WIRE USER" }] },
          ],
        },
        makeCtx(tmp, "PI PROMPT"),
      );

      const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]) as Record<string, unknown>;
      assert.equal(entry.source, "before_provider_request");
      assert.equal(entry.providerShape, "payload.input[role=system|developer]");
      assert.equal(entry.prompt, "WIRE SYSTEM");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
