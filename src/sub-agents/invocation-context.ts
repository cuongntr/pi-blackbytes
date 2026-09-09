import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type ReasoningEffort,
  normalizeFallbackModels,
  normalizeModelSelector,
  normalizeReasoningEffort,
} from "../config/model-settings.js";
import type { AgentSnapshot } from "./snapshot.js";

export type ModelIdentity = Readonly<
  Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">
>;
export type InvocationEntryContext = {
  readonly model: ModelIdentity | undefined;
  readonly cwd: ExtensionContext["cwd"];
};
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

export interface InvocationContext {
  readonly parentModel: ModelIdentity | undefined;
  readonly cwd: string;
  readonly snapshot: Immutable<AgentSnapshot>;
}

function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const seen = new WeakSet<object>();
  function freeze(value: unknown): void {
    if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  freeze(copy);
  return copy;
}

/**
 * Call synchronously at execute entry, BEFORE any await, overlay, or admission queue.
 * Reads ctx.model once and copies only identity, never credentials or parent thinking.
 * No registration/runner adoption here: callers own the execute-entry placement.
 */
export function captureInvocationContext(
  ctx: InvocationEntryContext,
  snapshot: AgentSnapshot,
): InvocationContext {
  const model = ctx.model;
  const parentModel = model ? Object.freeze({ provider: model.provider, id: model.id }) : undefined;
  const cwd = ctx.cwd;
  return Object.freeze({ parentModel, cwd, snapshot: freezeCopy(snapshot) });
}

export type ExactModelIntent =
  | {
      readonly ok: true;
      readonly model: ModelIdentity;
      readonly selector: string;
      /** Requested effort only, not evidence that Pi/provider honored it. */
      readonly reasoningEffort: ReasoningEffort | undefined;
    }
  | {
      readonly ok: false;
      readonly failureKind: "provider_or_model_unavailable";
      readonly content: string;
    };

/** Narrow catalogue seam is structurally compatible with Pi's ModelRegistry. */
export interface ModelCatalogue {
  getAll(): readonly ModelIdentity[];
}

function unavailable(): ExactModelIntent {
  // Fixed diagnostic: never echo selectors, registry objects, or thrown provider errors.
  return Object.freeze({
    ok: false,
    failureKind: "provider_or_model_unavailable",
    content:
      "Model intent unavailable. Configure an exact provider/id from the parent model catalogue (or a unique exact model id); blank fallbacks, ambiguous IDs, fuzzy names and wildcard selectors are not supported.",
  });
}

/**
 * Pure catalogue resolution; no auth, refresh, network, provider loading or default calls.
 * An explicit attempt selector is never allowed to inherit when blank.
 */
export function resolveInvocationIntent(
  invocation: InvocationContext,
  registry: ModelCatalogue,
  attemptSelector?: string,
): ExactModelIntent {
  try {
    normalizeFallbackModels(invocation.snapshot.fallbackModels);
    const explicit = attemptSelector !== undefined;
    let selector = normalizeModelSelector(explicit ? attemptSelector : invocation.snapshot.model);
    const parent = invocation.parentModel;
    const inherited = !explicit && !selector;
    if ((explicit && !selector) || (inherited && !parent)) return unavailable();
    const models = registry.getAll();
    let thinking = normalizeReasoningEffort(invocation.snapshot.reasoningEffort);
    let matches: readonly ModelIdentity[];
    if (inherited && parent) {
      matches = models.filter((m) => m.provider === parent.provider && m.id === parent.id);
    } else {
      if (!selector || /[*?\[\]{}]/.test(selector)) return unavailable();
      const match = (value: string): readonly ModelIdentity[] => {
        const full = models.filter((m) => `${m.provider}/${m.id}` === value);
        return full.length ? full : models.filter((m) => m.id === value);
      };
      matches = match(selector);
      // Entire slash/colon IDs win, including IDs that end in a thinking-level word.
      if (matches.length === 0) {
        const colon = selector.lastIndexOf(":");
        const suffix = colon < 0 ? undefined : normalizeReasoningEffort(selector.slice(colon + 1));
        if (suffix) {
          selector = selector.slice(0, colon);
          matches = match(selector);
          thinking ??= suffix;
        }
      }
    }
    if (matches.length !== 1) return unavailable();
    const model = Object.freeze({ provider: matches[0].provider, id: matches[0].id });
    return Object.freeze({
      ok: true,
      model,
      selector: `${model.provider}/${model.id}`,
      reasoningEffort: thinking,
    });
  } catch {
    return unavailable();
  }
}
