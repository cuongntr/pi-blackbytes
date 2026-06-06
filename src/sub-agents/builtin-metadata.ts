import type { SubAgentRoutingMetadata } from "./declaration.js";

interface BuiltinSubAgentMetadata {
  readonly name: string;
  readonly description: string;
  readonly routing: SubAgentRoutingMetadata;
}

export const EXPLORE_METADATA = {
  name: "explore",
  description:
    "Delegate a codebase exploration or flow walk-through to a specialized " +
    "Explore sub-agent. The sub-agent has read/search access only " +
    "(no writes, no bash).",
  routing: {
    category: "exploration",
    cost: "medium",
    useWhen: [
      "Broad or unfamiliar codebase search",
      "Cross-file discovery or tracing a flow",
      "Answering 'Where is X?' or 'How does Y work?'",
    ],
    avoidWhen: ["Simple grep or single-file lookup", "Tasks that need writes or bash execution"],
    keyTrigger: "Deep contextual grep across multiple files",
  },
} as const satisfies BuiltinSubAgentMetadata;

export const ORACLE_METADATA = {
  name: "oracle",
  description:
    "Delegate a hard reasoning or architecture problem to the Oracle " +
    "sub-agent — a high-IQ read-only consultation specialist. " +
    "The sub-agent has read-only access and uses elevated reasoning effort.",
  routing: {
    category: "reasoning",
    cost: "high",
    useWhen: [
      "Hard architecture or debugging decisions",
      "Security or performance trade-off analysis",
      "After 2 failed attempts at solving a problem",
    ],
    avoidWhen: [
      "Simple questions answerable from local code",
      "Tasks that need file writes or bash execution",
    ],
    keyTrigger: "Deep analytical reasoning on hard problems",
  },
} as const satisfies BuiltinSubAgentMetadata;

export const LIBRARIAN_METADATA = {
  name: "librarian",
  description:
    "Delegate to the Librarian ONLY when ALL of these hold: " +
    "(a) needs EXTERNAL info; " +
    "(b) needs MULTIPLE sources or current-year authoritative answer; (c) direct tools " +
    "would each be insufficient alone. DO NOT use for single URL fetch, single docs " +
    "lookup, single GitHub search, or local-codebase questions. " +
    "Cost signal: ~5–10× more tokens and latency.",
  routing: {
    category: "research",
    cost: "high",
    useWhen: [
      "Needs 3+ external sources to answer confidently",
      "Official docs + changelog + real-world examples needed",
      "Current-year authoritative answer that may have changed",
    ],
    avoidWhen: [
      "Single URL fetch or single docs lookup suffices",
      "Local-codebase questions",
      "Trivial facts or restating known information",
    ],
    keyTrigger: "Multi-source external research requiring triangulation",
  },
} as const satisfies BuiltinSubAgentMetadata;

export const GENERAL_METADATA = {
  name: "general",
  description:
    "Implementation executor agent. Handles heavy multi-file implementations, " +
    "cross-layer refactors, mass migrations, and boilerplate generation. " +
    "Full write access — operates as a fire-and-forget executor for well-defined tasks.",
  routing: {
    category: "implementation",
    cost: "high",
    useWhen: [
      "Heavy implementation across 3+ files after plan is clear",
      "Cross-layer refactors with disjoint write targets",
      "Mass migrations, boilerplate generation, repetitive pattern changes",
      "Scaffolding new modules, components, or test suites",
    ],
    avoidWhen: [
      "Single-file edits or small focused changes",
      "Exploratory work or understanding code",
      "Work requiring mid-stream parent feedback",
    ],
    keyTrigger: "Heavy multi-file implementation with verifiable outcome",
  },
} as const satisfies BuiltinSubAgentMetadata;

export const REVIEWER_METADATA = {
  name: "reviewer",
  description:
    "Delegate a code review to a read-only Reviewer that produces " +
    "severity-classified findings (High/Medium/Low) and a verdict. " +
    "Caller MUST include diff, patch, or changed-file list in `context`.",
  routing: {
    category: "review",
    cost: "medium",
    useWhen: [
      "After significant implementation, before commits/PRs",
      "When user asks for fresh eyes on changes",
      "Pre-merge code quality and correctness check",
    ],
    avoidWhen: ["Trivial or single-line changes", "When no diff or change context is available"],
    keyTrigger: "Severity-classified code review with verdict",
  },
} as const satisfies BuiltinSubAgentMetadata;

export const BUILTIN_SUB_AGENT_METADATA = [
  EXPLORE_METADATA,
  ORACLE_METADATA,
  LIBRARIAN_METADATA,
  GENERAL_METADATA,
  REVIEWER_METADATA,
] as const;
