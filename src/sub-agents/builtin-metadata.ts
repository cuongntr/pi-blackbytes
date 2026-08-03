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
    "Delegate hard reasoning, architecture, or a difficult bounded code review to Oracle. " +
    "It is read-only with no bash/git; provide the diff and verification results for reviews.",
  routing: {
    category: "reasoning",
    cost: "high",
    useWhen: [
      "Hard architecture or debugging decisions",
      "Security or performance trade-off analysis",
      "Difficult or high-risk bounded code review",
      "After 2 failed attempts at solving a problem",
    ],
    avoidWhen: [
      "Simple questions answerable from local code",
      "Tasks that need file writes or bash execution",
    ],
    keyTrigger: "Deep reasoning or difficult high-risk code review",
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
      "Self-contained implementation units from a loaded workflow or skill",
    ],
    avoidWhen: [
      "Ad hoc single-file edits or small focused changes outside a planned set of independent implementation units",
      "Exploratory work or understanding code",
      "Work requiring mid-stream parent feedback",
    ],
    keyTrigger: "Heavy multi-file implementation with verifiable outcome",
  },
} as const satisfies BuiltinSubAgentMetadata;

export const BUILTIN_SUB_AGENT_METADATA = [
  EXPLORE_METADATA,
  ORACLE_METADATA,
  LIBRARIAN_METADATA,
  GENERAL_METADATA,
] as const;
