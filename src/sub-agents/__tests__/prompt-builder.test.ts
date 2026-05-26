/**
 * Tests for src/sub-agents/prompt-builder.ts
 *
 * Covers:
 *  1. Static mode: byte-for-byte pass-through of each builtin's system prompt.
 *  2. Append mode: throws a clear "not yet supported" error.
 *  3. Default mode (omitted promptMode): behaves identically to static.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import type { BlackbytesConfig } from "../../config/schema.js";
import { exploreDeclaration } from "../explore.js";
import { generalDeclaration } from "../general.js";
import { librarianDeclaration } from "../librarian.js";
import { oracleDeclaration } from "../oracle.js";
import { buildSystemPrompt, resolveSystemPromptBody } from "../prompt-builder.js";

const defaultConfig: BlackbytesConfig = {
  disabled_tools: [],
  disabled_sub_agents: [],
  hashline_edit: true,
  copilot_initiator_header: true,
};

// ---------------------------------------------------------------------------
// static mode & default (omitted) mode
// ---------------------------------------------------------------------------

describe("buildSystemPrompt — static mode", () => {
  it("returns basePrompt unchanged when promptMode is 'static'", () => {
    const prompt = "My system prompt text";
    const result = buildSystemPrompt({
      basePrompt: prompt,
      declaration: { name: "test", promptMode: "static" },
    });
    assert.equal(result, prompt);
  });

  it("returns basePrompt unchanged when promptMode is omitted (default)", () => {
    const prompt = "My system prompt text";
    const result = buildSystemPrompt({
      basePrompt: prompt,
      declaration: { name: "test" },
    });
    assert.equal(result, prompt);
  });

  it("preserves exact byte sequence (no trimming or transformation)", () => {
    const prompt = "  leading\n\ntrailing  ";
    const result = buildSystemPrompt({
      basePrompt: prompt,
      declaration: { name: "test", promptMode: "static" },
    });
    assert.equal(result, prompt);
    assert.equal(result.length, prompt.length);
  });
});

// ---------------------------------------------------------------------------
// append mode — fail loud
// ---------------------------------------------------------------------------

describe("buildSystemPrompt — append mode (deferred)", () => {
  it("throws a clear error when promptMode is 'append'", () => {
    assert.throws(
      () =>
        buildSystemPrompt({
          basePrompt: "some prompt",
          declaration: { name: "my-agent", promptMode: "append" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /append/);
        assert.match(err.message, /not yet supported/);
        assert.match(err.message, /my-agent/);
        return true;
      },
    );
  });

  it("error message mentions pib-vyj.2.3 road-map reference", () => {
    assert.throws(
      () =>
        buildSystemPrompt({
          basePrompt: "x",
          declaration: { name: "a", promptMode: "append" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /pib-vyj\.2\.3/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Snapshot tests: each builtin's static prompt is unchanged
// ---------------------------------------------------------------------------

describe("buildSystemPrompt — builtin snapshot (zero-drift)", () => {
  it("explore: static mode returns systemPrompt byte-for-byte", () => {
    const basePrompt = exploreDeclaration.systemPrompt!;
    const result = buildSystemPrompt({
      basePrompt,
      declaration: exploreDeclaration,
    });
    assert.equal(result, basePrompt, "explore prompt must be byte-for-byte identical");
  });

  it("oracle: static mode returns systemPrompt byte-for-byte", () => {
    const basePrompt = oracleDeclaration.systemPrompt!;
    const result = buildSystemPrompt({
      basePrompt,
      declaration: oracleDeclaration,
    });
    assert.equal(result, basePrompt, "oracle prompt must be byte-for-byte identical");
  });

  it("librarian: static mode returns systemPrompt byte-for-byte", () => {
    const basePrompt = librarianDeclaration.systemPrompt!;
    const result = buildSystemPrompt({
      basePrompt,
      declaration: librarianDeclaration,
    });
    assert.equal(result, basePrompt, "librarian prompt must be byte-for-byte identical");
  });

  it("general: static mode returns systemPrompt byte-for-byte", () => {
    // general.ts uses an inline systemPrompt constant — no IO needed.
    initEnabledSet(defaultConfig);
    const basePrompt = generalDeclaration.systemPrompt!;
    const result = buildSystemPrompt({
      basePrompt,
      declaration: generalDeclaration,
    });
    _resetEnabledSet();
    assert.equal(result, basePrompt, "general prompt must be byte-for-byte identical");
  });

  it("all builtins declare promptMode as undefined (static by default)", () => {
    const builtins = [exploreDeclaration, oracleDeclaration, librarianDeclaration];
    for (const decl of builtins) {
      assert.equal(
        decl.promptMode,
        undefined,
        `${decl.name} must not set promptMode (static is the default)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// register.ts integration: uses builder (structural, not mocked)
// ---------------------------------------------------------------------------

describe("buildSystemPrompt — register.ts contract", () => {
  it("static mode result is identical to raw basePrompt for any non-empty string", () => {
    // This enforces the promise made to register.ts consumers: swapping
    // `systemPrompt` for `buildSystemPrompt({ basePrompt: systemPrompt, declaration })`
    // never changes the value when promptMode is omitted or 'static'.
    const samples = [
      "simple prompt",
      "# Markdown\n\nWith *formatting* and `code`.",
      "Multi\nline\n\n\nprompt",
    ];
    for (const sample of samples) {
      assert.equal(buildSystemPrompt({ basePrompt: sample, declaration: { name: "x" } }), sample);
      assert.equal(
        buildSystemPrompt({ basePrompt: sample, declaration: { name: "x", promptMode: "static" } }),
        sample,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// resolveSystemPromptBody
// ---------------------------------------------------------------------------

describe("resolveSystemPromptBody", () => {
  const DEFAULT_PROMPT = "Default system prompt";
  const GPT_PROMPT = "GPT-optimized system prompt";
  const declWithGpt = {
    systemPrompt: DEFAULT_PROMPT,
    systemPromptByFamily: { gpt: GPT_PROMPT },
  };
  const declWithoutFamily = {
    systemPrompt: DEFAULT_PROMPT,
  };

  it("returns default prompt when modelId is undefined", () => {
    const result = resolveSystemPromptBody(declWithGpt);
    assert.equal(result, DEFAULT_PROMPT);
  });

  it("returns default prompt when modelId is undefined even with systemPromptByFamily", () => {
    const result = resolveSystemPromptBody(declWithGpt, undefined);
    assert.equal(result, DEFAULT_PROMPT);
  });

  it("returns GPT variant when modelId classifies as gpt", () => {
    const result = resolveSystemPromptBody(declWithGpt, "gpt-4o");
    assert.equal(result, GPT_PROMPT);
  });

  it("returns GPT variant for o3-mini model", () => {
    const result = resolveSystemPromptBody(declWithGpt, "o3-mini");
    assert.equal(result, GPT_PROMPT);
  });

  it("returns GPT variant for o4-mini model", () => {
    const result = resolveSystemPromptBody(declWithGpt, "o4-mini");
    assert.equal(result, GPT_PROMPT);
  });

  it("returns default prompt when model family has no variant", () => {
    const result = resolveSystemPromptBody(declWithGpt, "claude-3.5-sonnet");
    assert.equal(result, DEFAULT_PROMPT);
  });

  it("returns default prompt when declaration has no systemPromptByFamily", () => {
    const result = resolveSystemPromptBody(declWithoutFamily, "gpt-4o");
    assert.equal(result, DEFAULT_PROMPT);
  });

  it("returns default prompt for non-GPT model even with GPT variant defined", () => {
    const result = resolveSystemPromptBody(declWithGpt, "gemini-pro");
    assert.equal(result, DEFAULT_PROMPT);
  });
});
