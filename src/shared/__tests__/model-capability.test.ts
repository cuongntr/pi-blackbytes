import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_PROMPT_MODEL_FAMILY,
  _resetModelFamily,
  classifyModel,
  getModelFamily,
  resolvePromptModelFamily,
  setModelFamily,
} from "../model-capability.js";

describe("classifyModel", () => {
  it('classifies claude-3-5-sonnet as "claude"', () => {
    assert.equal(classifyModel("claude-3-5-sonnet"), "claude");
  });

  it('classifies claude-opus-4 as "claude"', () => {
    assert.equal(classifyModel("claude-opus-4"), "claude");
  });

  it('classifies gpt-4o as "gpt"', () => {
    assert.equal(classifyModel("gpt-4o"), "gpt");
  });

  it('classifies o1-preview as "gpt"', () => {
    assert.equal(classifyModel("o1-preview"), "gpt");
  });

  it('classifies gemini-1.5-pro as "gemini"', () => {
    assert.equal(classifyModel("gemini-1.5-pro"), "gemini");
  });

  it('classifies unknown-model as "other"', () => {
    assert.equal(classifyModel("unknown-model"), "other");
  });
});

describe("model family cache", () => {
  beforeEach(() => {
    _resetModelFamily();
  });

  it("updates cache and replaces on successive calls", () => {
    setModelFamily("claude-3");
    assert.equal(getModelFamily(), "claude");

    setModelFamily("gpt-4");
    assert.equal(getModelFamily(), "gpt");
  });

  it("_resetModelFamily resets to other", () => {
    setModelFamily("gemini-1.5-pro");
    assert.equal(getModelFamily(), "gemini");

    _resetModelFamily();
    assert.equal(getModelFamily(), "other");
  });
});

describe("resolvePromptModelFamily", () => {
  beforeEach(() => {
    _resetModelFamily();
  });

  it("prefers an explicit modelId when provided", () => {
    setModelFamily("claude-3");
    assert.equal(resolvePromptModelFamily("gpt-5.4"), "gpt");
  });

  it("uses cached family when available", () => {
    setModelFamily("gemini-1.5-pro");
    assert.equal(resolvePromptModelFamily(), "gemini");
  });

  it("falls back to the documented safe default when cache is unset", () => {
    assert.equal(resolvePromptModelFamily(), DEFAULT_PROMPT_MODEL_FAMILY);
  });
});
