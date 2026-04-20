import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _resetModelFamily, setModelFamily } from "../../shared/model-capability.js";
import { buildStaticBytesPromptSectionMap } from "../bytes/shared.js";
import { loadBytesPrompt } from "../loader.js";

describe("loadBytesPrompt", () => {
  afterEach(() => {
    _resetModelFamily();
  });

  it("loads default variant for claude family", () => {
    setModelFamily("claude-sonnet-4-20250514");
    const prompt = loadBytesPrompt();
    assert.ok(prompt.includes("Simple-first"));
    assert.ok(prompt.length > 0);
  });

  it("loads gpt variant for GPT family", () => {
    const prompt = loadBytesPrompt("gpt");
    assert.ok(prompt.includes("Simple-first"));
    assert.ok(prompt.length > 0);
  });

  it("loads gemini variant for Gemini family", () => {
    const prompt = loadBytesPrompt("gemini");
    assert.ok(prompt.includes("Simple-first"));
    assert.ok(prompt.length > 0);
  });

  it("falls back to default for 'other' family", () => {
    const defaultPrompt = loadBytesPrompt("claude");
    const otherPrompt = loadBytesPrompt("other");
    assert.equal(otherPrompt, defaultPrompt);
  });

  it("uses current model family when no argument provided", () => {
    setModelFamily("gpt-4o");
    const prompt = loadBytesPrompt();
    const gptPrompt = loadBytesPrompt("gpt");
    assert.equal(prompt, gptPrompt);
  });

  it("produces structurally different prompts per family", () => {
    const claude = loadBytesPrompt("claude");
    const gpt = loadBytesPrompt("gpt");
    const gemini = loadBytesPrompt("gemini");
    // Claude uses XML tags
    assert.ok(claude.includes("<agency>"));
    assert.ok(!gpt.includes("<agency>"));
    assert.ok(!gemini.includes("<agency>"));
    // GPT uses filler blacklist
    assert.ok(gpt.includes("NEVER open with filler"));
    // Gemini uses numbered sections
    assert.ok(gemini.includes("## 1."));
  });

  it("conditionally includes hashline workflow", () => {
    const withHashline = loadBytesPrompt("claude", true);
    const withoutHashline = loadBytesPrompt("claude", false);
    assert.ok(withHashline.includes("Hashline Edit Workflow"));
    assert.ok(!withoutHashline.includes("Hashline Edit Workflow"));
  });

  it("renders the same canonical section titles across model families", () => {
    const sections = buildStaticBytesPromptSectionMap("claude", true);
    const sectionTitles = Object.values(sections).map((section) => section.title);

    for (const family of ["claude", "gpt", "gemini"] as const) {
      const prompt = loadBytesPrompt(family, true);
      for (const title of sectionTitles) {
        assert.ok(prompt.includes(title));
      }
    }
  });
});

describe("createPromptVariantRenderContext fallback behavior", () => {
  afterEach(() => {
    _resetModelFamily();
  });

  it("uses the deterministic safe default when no family is provided and cache is unset", () => {
    const defaultPrompt = loadBytesPrompt("claude");
    const fallbackPrompt = loadBytesPrompt();
    assert.equal(fallbackPrompt, defaultPrompt);
  });
});
