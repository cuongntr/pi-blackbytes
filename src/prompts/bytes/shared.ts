import { derivePromptFeatureFlags } from "../../config/resource-metadata.js";
import type { ModelFamily } from "../../shared/model-capability.js";
import { buildBytesPromptOverlay } from "./overlay.js";
import type { BytesPromptRenderContext, PromptFeatureFlags, PromptSectionMap } from "./types.js";

function toPromptSectionMap(context: BytesPromptRenderContext): PromptSectionMap {
  const sections = buildBytesPromptOverlay(context);
  return Object.fromEntries(sections.map((section) => [section.key, section])) as PromptSectionMap;
}

function createStaticPromptFeatures(hashlineEditEnabled: boolean): PromptFeatureFlags {
  return {
    hashlineEdit: hashlineEditEnabled,
    subagentDelegation: true,
    documentationLookup: true,
    githubCodeSearch: true,
    webSearch: true,
  };
}

export function createBytesPromptRenderContext(
  modelFamily: ModelFamily,
  enabledTools: ReadonlySet<string>,
  enabledSubAgents: ReadonlySet<string>,
): BytesPromptRenderContext {
  return {
    modelFamily,
    enabledTools,
    enabledSubAgents,
    features: derivePromptFeatureFlags(enabledTools, enabledSubAgents),
  };
}

export function createStaticBytesPromptRenderContext(
  modelFamily: ModelFamily,
  hashlineEditEnabled: boolean,
): BytesPromptRenderContext {
  return {
    modelFamily,
    enabledTools: new Set<string>(),
    enabledSubAgents: new Set<string>(),
    features: createStaticPromptFeatures(hashlineEditEnabled),
  };
}

export function buildBytesPromptSectionMap(context: BytesPromptRenderContext): PromptSectionMap {
  return toPromptSectionMap(context);
}

export function buildStaticBytesPromptSectionMap(
  modelFamily: ModelFamily,
  hashlineEditEnabled: boolean,
): PromptSectionMap {
  return buildBytesPromptSectionMap(
    createStaticBytesPromptRenderContext(modelFamily, hashlineEditEnabled),
  );
}
