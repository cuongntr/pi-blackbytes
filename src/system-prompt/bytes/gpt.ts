import { renderMarkdownPrompt } from "./render.js";
import type { PromptSectionMap } from "./types.js";

/**
 * GPT prompt variant for the Bytes agent.
 *
 * Markdown headings, with a verification-gate and parallel-execution emphasis
 * tuned for GPT models that respond well to explicit ordered checklists.
 */
const GPT_FOOTER = [
  "## Parallel Execution Policy",
  "",
  "- ALWAYS issue independent reads, searches, and tool calls in a single turn.",
  "- Serialize ONLY when later work strictly depends on earlier results.",
  "- Treat sequential single-tool turns as a smell unless dependency-justified.",
].join("\n");

const GPT_AFTER_FIRST =
  'NEVER open with filler: "Great question!", "Sure!", "Of course!", "Absolutely!", "Let me help with that!", "I\'d be happy to help!". For non-trivial work, start with the intended outcome and immediate approach; otherwise start with the answer.';

export function buildBytesGptPrompt(sections: PromptSectionMap): string {
  const body = renderMarkdownPrompt(sections, {
    heading: (_index, title) => `# ${title}`,
    afterFirstSection: GPT_AFTER_FIRST,
  });
  return `${body}\n\n${GPT_FOOTER}`;
}
