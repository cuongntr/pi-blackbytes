// Shared resource metadata — single source of truth for enabled-set filtering
// and prompt/resource injection.

import type { PromptFeatureFlags } from "../prompts/bytes/types.js";

export type PromptFeatureKey = keyof PromptFeatureFlags;

export interface ToolMeta {
  readonly name: string;
  readonly promptFeatures?: readonly PromptFeatureKey[];
}

export interface ToolGroupMeta {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly promptFeatures?: readonly PromptFeatureKey[];
}

export interface SubAgentMeta {
  readonly name: string;
  readonly description: string;
  readonly promptFeatures?: readonly PromptFeatureKey[];
}

export const BUNDLED_TOOLS: readonly ToolMeta[] = [
  { name: "hashline_edit", promptFeatures: ["hashlineEdit"] },
  { name: "ast_grep_search" },
  { name: "ast_grep_replace" },
  { name: "grep" },
  { name: "glob" },
];

export const TOOL_GROUPS: readonly ToolGroupMeta[] = [
  {
    name: "websearch",
    description: "web search and page fetching",
    tools: ["websearch_search", "websearch_fetch"],
    promptFeatures: ["webSearch"],
  },
  {
    name: "context7",
    description: "library/framework documentation lookup",
    tools: ["context7_resolve_library_id", "context7_query_docs"],
    promptFeatures: ["documentationLookup"],
  },
  {
    name: "grep_app",
    description: "GitHub code search across public repositories",
    tools: ["grep_app_search_github"],
    promptFeatures: ["githubCodeSearch"],
  },
];

export const SUB_AGENTS: readonly SubAgentMeta[] = [
  {
    name: "explore",
    description: "Contextual grep for codebases",
    promptFeatures: ["subagentDelegation"],
  },
  {
    name: "oracle",
    description: "Read-only consultation agent for debugging and architecture",
    promptFeatures: ["subagentDelegation"],
  },
  {
    name: "librarian",
    description: "Multi-repo analysis, documentation lookup",
    promptFeatures: ["subagentDelegation"],
  },
  {
    name: "general",
    description: "Implementation executor for heavy multi-file work",
    promptFeatures: ["subagentDelegation"],
  },
];

export const DEFAULT_SKILLS: readonly string[] = [
  "implementing-beads",
  "planning-from-spec",
  "reviewing-plan",
  "converting-plan-to-beads",
  "polishing-beads",
  "doc-coauthoring",
  "skill-creator",
  "find-skills",
  "swarm-beads",
];

// Derived lists for enabled-set filtering
export const ALL_TOOL_NAMES: readonly string[] = [
  ...BUNDLED_TOOLS.map((t) => t.name),
  ...TOOL_GROUPS.flatMap((s) => s.tools),
];

export const ALL_SUB_AGENT_NAMES: readonly string[] = SUB_AGENTS.map((a) => a.name);

// Quick lookup: is this tool name a bundled tool?
const bundledSet = new Set(BUNDLED_TOOLS.map((t) => t.name));
export function isBundledTool(name: string): boolean {
  return bundledSet.has(name);
}

function createEmptyPromptFeatureFlags(): PromptFeatureFlags {
  return {
    hashlineEdit: false,
    subagentDelegation: false,
    documentationLookup: false,
    githubCodeSearch: false,
    webSearch: false,
  };
}

export function derivePromptFeatureFlags(
  enabledTools: ReadonlySet<string>,
  enabledSubAgents: ReadonlySet<string>,
): PromptFeatureFlags {
  return {
    hashlineEdit: enabledTools.has("hashline_edit"),
    subagentDelegation: SUB_AGENTS.some((agent) => enabledSubAgents.has(agent.name)),
    documentationLookup: enabledTools.has("context7_query_docs"),
    githubCodeSearch: enabledTools.has("grep_app_search_github"),
    webSearch: enabledTools.has("websearch_search") || enabledTools.has("websearch_fetch"),
  };
}
