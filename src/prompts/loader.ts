import { type ModelFamily, getModelFamily } from "../shared/model-capability.js";
import { buildBytesDefaultPrompt } from "./bytes/default.js";
import { buildBytesGeminiPrompt } from "./bytes/gemini.js";
import { buildBytesGptPrompt } from "./bytes/gpt.js";

// ---------------------------------------------------------------------------
// Prompt variant selection
// ---------------------------------------------------------------------------

type PromptBuilder = (hashlineEditEnabled: boolean) => string;

const FAMILY_TO_BUILDER: Record<ModelFamily, PromptBuilder> = {
  claude: buildBytesDefaultPrompt,
  gpt: buildBytesGptPrompt,
  gemini: buildBytesGeminiPrompt,
  other: buildBytesDefaultPrompt,
};

/**
 * Build the Bytes prompt variant for the current (or specified) model family.
 */
export function loadBytesPrompt(family?: ModelFamily, hashlineEditEnabled = true): string {
  const resolved = family ?? getModelFamily();
  const builder = FAMILY_TO_BUILDER[resolved] ?? buildBytesDefaultPrompt;
  return builder(hashlineEditEnabled);
}
