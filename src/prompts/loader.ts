import { type ModelFamily, resolvePromptModelFamily } from "../shared/model-capability.js";
import { buildBytesDefaultPrompt } from "./bytes/default.js";
import { buildBytesGeminiPrompt } from "./bytes/gemini.js";
import { buildBytesGptPrompt } from "./bytes/gpt.js";
import {
  buildBytesPromptSectionMap,
  createStaticBytesPromptRenderContext,
} from "./bytes/shared.js";
import type {
  BytesPromptRenderContext,
  PromptRenderer,
  PromptSectionMap,
  PromptVariantRenderContext,
} from "./bytes/types.js";

// ---------------------------------------------------------------------------
// Prompt variant selection
// ---------------------------------------------------------------------------

const FAMILY_TO_RENDERER: Record<ModelFamily, PromptRenderer> = {
  claude: buildBytesDefaultPrompt,
  gpt: buildBytesGptPrompt,
  gemini: buildBytesGeminiPrompt,
  other: buildBytesDefaultPrompt,
};

export function createPromptVariantRenderContext(
  family: ModelFamily = resolvePromptModelFamily(),
  hashlineEditEnabled = true,
): PromptVariantRenderContext {
  return {
    modelFamily: family,
    hashlineEditEnabled,
  };
}

export function renderBytesPrompt(
  context: BytesPromptRenderContext,
  sectionMap: PromptSectionMap = buildBytesPromptSectionMap(context),
): string {
  const renderer = FAMILY_TO_RENDERER[context.modelFamily] ?? buildBytesDefaultPrompt;
  return renderer(sectionMap);
}

/**
 * Build the Bytes prompt variant for the current (or specified) model family.
 */
export function loadBytesPrompt(family?: ModelFamily, hashlineEditEnabled = true): string {
  const context = createStaticBytesPromptRenderContext(
    family ?? resolvePromptModelFamily(),
    hashlineEditEnabled,
  );
  return renderBytesPrompt(context);
}
