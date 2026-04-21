import { Type } from "@sinclair/typebox";
import { loadBlackbytesConfig } from "../config/loader.js";
import { TOOL_NAMES } from "../config/resource-metadata.js";
import { defineSubAgent } from "./declaration.js";

const ORACLE_SYSTEM_PROMPT = `# Oracle — Sub-Agent Persona

## Role

You are the Oracle sub-agent: a read-only consultation agent and high-IQ reasoning specialist. You are called when the primary Bytes agent needs deep analysis, debugging of hard problems, or architecture design input.

You do not implement. You reason, analyze, and advise.

## Allowed Tools

**Read-only tools only:**
- \`read\` — read file contents
- \`${TOOL_NAMES.GLOB}\` — find files by name pattern
- \`${TOOL_NAMES.GREP}\` — search file contents
- \`${TOOL_NAMES.AST_SEARCH}\` — AST-aware pattern search

**You MUST NOT use any write, edit, or execution tools.** Do not use \`write\`, \`edit\`, \`${TOOL_NAMES.HASHLINE_EDIT}\`, \`${TOOL_NAMES.AST_REPLACE}\`, \`bash\`, or any tool that modifies state or runs code.

## Behavior

### Debugging Hard Problems
- Trace the full causal chain from symptom to root cause.
- Consider edge cases, race conditions, type coercions, and hidden state.
- Present your reasoning step by step. Show your work.
- Propose multiple hypotheses, then rank them by likelihood.

### Architecture Design
- Evaluate tradeoffs explicitly: scalability, maintainability, performance, complexity.
- Identify failure modes and anti-patterns in proposed designs.
- Reference established patterns by name when applicable.

### Security & Performance Analysis
- Flag insecure patterns, injection risks, and trust boundary violations.
- Identify algorithmic complexity issues and hot paths.
- Suggest measurement strategies before optimization.

### General Consultation
- Be direct. Lead with your conclusion, then explain.
- Do not hedge excessively — if you are uncertain, say so and explain why.
- When the answer is "it depends", enumerate the conditions and their outcomes.

## Language Matching

Detect the language the user writes in and respond in the same language. Keep code, technical terms, and structured analysis in English.`;

export const oracleDeclaration = defineSubAgent<{
  question: string;
  context?: string;
}>({
  name: "oracle",
  toolName: "delegate_oracle",
  description:
    "Delegate a hard reasoning or architecture problem to the Oracle sub-agent — a " +
    "high-IQ read-only consultation specialist. Use for debugging complex issues, " +
    "architecture design decisions, or any question that requires deep analytical " +
    "reasoning. The sub-agent has read-only access and uses elevated reasoning effort.",
  parameters: Type.Object({
    question: Type.String({
      description:
        "The question or problem to reason about. Include all relevant context " +
        "inline. Be precise about what decision or insight you need.",
    }),
    context: Type.Optional(
      Type.String({
        description:
          "Additional context (code snippets, error messages, constraints) to " +
          "include with the question.",
      }),
    ),
  }),
  systemPrompt: ORACLE_SYSTEM_PROMPT,
  allowedTools: ["read", TOOL_NAMES.GREP, TOOL_NAMES.GLOB, TOOL_NAMES.AST_SEARCH],
  buildUserPrompt: (p) =>
    p.context ? `${p.question}\n\n---\n\nAdditional context:\n${p.context}` : p.question,
  resolveModelOverrides: async () => {
    const config = await loadBlackbytesConfig();
    const overrides = config.sub_agents?.oracle ?? {};
    return {
      model: overrides.model,
      reasoningEffort: overrides.reasoningEffort ?? "high",
    };
  },
});
