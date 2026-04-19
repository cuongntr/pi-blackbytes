// Shared resource metadata — single source of truth for enabled-set filtering
// and prompt/resource injection.

export interface ToolMeta {
  readonly name: string;
}

export interface ToolGroupMeta {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
}

export interface SubAgentMeta {
  readonly name: string;
  readonly description: string;
}

export const BUNDLED_TOOLS: readonly ToolMeta[] = [
  { name: "hashline_edit" },
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
  },
  {
    name: "context7",
    description: "library/framework documentation lookup",
    tools: ["context7_resolve_library_id", "context7_query_docs"],
  },
  {
    name: "grep_app",
    description: "GitHub code search across public repositories",
    tools: ["grep_app_search_github"],
  },
];

export const SUB_AGENTS: readonly SubAgentMeta[] = [
  { name: "explore", description: "Contextual grep for codebases" },
  { name: "oracle", description: "Read-only consultation agent for debugging and architecture" },
  { name: "librarian", description: "Multi-repo analysis, documentation lookup" },
  { name: "general", description: "Implementation executor for heavy multi-file work" },
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
