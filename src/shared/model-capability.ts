export type ModelFamily = "claude" | "gpt" | "gemini" | "other";

export const DEFAULT_PROMPT_MODEL_FAMILY: ModelFamily = "claude";

export function classifyModel(modelId: string): ModelFamily {
  const id = modelId.toLowerCase();
  if (id.includes("claude")) return "claude";
  if (id.includes("gpt") || id.includes("o1") || id.includes("o3") || id.includes("o4")) {
    return "gpt";
  }
  if (id.includes("gemini")) return "gemini";
  return "other";
}

// Module-level cache
let _cachedFamily: ModelFamily = "other";

export function setModelFamily(modelId: string): ModelFamily {
  _cachedFamily = classifyModel(modelId);
  return _cachedFamily;
}

export function getModelFamily(): ModelFamily {
  return _cachedFamily;
}

export function resolvePromptModelFamily(modelId?: string): ModelFamily {
  if (modelId) {
    return classifyModel(modelId);
  }

  const cachedFamily = getModelFamily();
  return cachedFamily === "other" ? DEFAULT_PROMPT_MODEL_FAMILY : cachedFamily;
}

// For testing
export function _resetModelFamily(): void {
  _cachedFamily = "other";
}
