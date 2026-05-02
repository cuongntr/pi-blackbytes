// Shared resource metadata — single source of truth for enabled-set filtering
// and prompt/resource injection.

import type { PromptFeatureFlags } from "../system-prompt/bytes/types.js";

export type PromptFeatureKey = keyof PromptFeatureFlags;

export const TOOL_NAMES = {
  HASHLINE_EDIT: "hashline_edit",
  AST_SEARCH: "ast_search",
  AST_REPLACE: "ast_replace",
  GREP: "grep",
  GLOB: "glob",
  WEB_SEARCH: "web_search",
  WEB_FETCH: "web_fetch",
  DOCS_RESOLVE: "docs_resolve",
  DOCS_QUERY: "docs_query",
  GH_SEARCH: "gh_search",
  HANDOFF: "handoff",
  LOOK_AT: "look_at",
} as const;

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
  { name: TOOL_NAMES.HASHLINE_EDIT, promptFeatures: ["hashlineEdit"] },
  { name: TOOL_NAMES.AST_SEARCH },
  { name: TOOL_NAMES.AST_REPLACE },
  { name: TOOL_NAMES.GREP },
  { name: TOOL_NAMES.GLOB },
  { name: TOOL_NAMES.HANDOFF, promptFeatures: ["handoffEnabled"] },
  { name: TOOL_NAMES.LOOK_AT },
];

export const TOOL_GROUPS: readonly ToolGroupMeta[] = [
  {
    name: "websearch",
    description: "web search and page fetching",
    tools: [TOOL_NAMES.WEB_SEARCH, TOOL_NAMES.WEB_FETCH],
    promptFeatures: ["webSearch"],
  },
  {
    name: "context7",
    description: "library/framework documentation lookup",
    tools: [TOOL_NAMES.DOCS_RESOLVE, TOOL_NAMES.DOCS_QUERY],
    promptFeatures: ["documentationLookup"],
  },
  {
    name: "grep_app",
    description: "GitHub code search across public repositories",
    tools: [TOOL_NAMES.GH_SEARCH],
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
    description: "External docs/library/API research and open-source examples",
    promptFeatures: ["subagentDelegation"],
  },
  {
    name: "general",
    description: "Implementation executor for heavy multi-file work",
    promptFeatures: ["subagentDelegation"],
  },
  {
    name: "reviewer",
    description: "Read-only code reviewer for diffs, branches, and PRs",
    promptFeatures: ["subagentDelegation"],
  },
  {
    name: "code-tour",
    description: "Read-only code-walkthrough sub-agent for guided file tours",
    promptFeatures: ["subagentDelegation"],
  },
];

// ---------------------------------------------------------------------------
// Runtime sub-agent metadata registry
// ---------------------------------------------------------------------------

let registeredAgents: SubAgentMeta[] = [];

/**
 * Register sub-agent metadata at runtime.
 * Rejects duplicates by name.
 */
export function registerSubAgentMeta(meta: SubAgentMeta): void {
  if (registeredAgents.some((a) => a.name === meta.name)) {
    throw new Error(`Sub-agent metadata already registered: "${meta.name}"`);
  }
  registeredAgents.push(meta);
}

/** Returns all sub-agent metadata registered for this session. */
export function getRegisteredSubAgents(): readonly SubAgentMeta[] {
  return registeredAgents;
}

/** Returns the names of all registered sub-agents. */
export function getRegisteredSubAgentNames(): readonly string[] {
  return registeredAgents.map((a) => a.name);
}

// For testing only
export function _resetSubAgentRegistry(): void {
  registeredAgents = [];
}

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

export function derivePromptFeatureFlags(
  enabledTools: ReadonlySet<string>,
  enabledSubAgents: ReadonlySet<string>,
): PromptFeatureFlags {
  return {
    hashlineEdit: enabledTools.has(TOOL_NAMES.HASHLINE_EDIT),
    subagentDelegation: registeredAgents.some((agent) => enabledSubAgents.has(agent.name)),
    documentationLookup: enabledTools.has(TOOL_NAMES.DOCS_QUERY),
    githubCodeSearch: enabledTools.has(TOOL_NAMES.GH_SEARCH),
    webSearch: enabledTools.has(TOOL_NAMES.WEB_SEARCH) || enabledTools.has(TOOL_NAMES.WEB_FETCH),
    handoffEnabled: enabledTools.has(TOOL_NAMES.HANDOFF),
  };
}
