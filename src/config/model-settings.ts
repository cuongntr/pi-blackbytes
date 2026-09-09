/** Existing Blackbytes-supported Pi thinking levels; no capability clamping here. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof THINKING_LEVELS)[number];

export function normalizeModelSelector(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** Preserve legacy behavior for unsupported reasoning values. */
export function normalizeReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  const trimmed = value?.trim();
  return THINKING_LEVELS.find((level) => level === trimmed);
}

/** Also validates direct internal callers which bypass JSON/YAML schemas. */
export function normalizeFallbackModels(
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > 5) {
    throw new Error("fallbackModels must be an array of at most 5 exact model IDs");
  }
  const normalized = Array.from(values, (value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("fallbackModels entries must be non-empty exact model IDs");
    }
    return value.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("fallbackModels must not contain duplicate entries");
  }
  return Object.freeze(normalized);
}
