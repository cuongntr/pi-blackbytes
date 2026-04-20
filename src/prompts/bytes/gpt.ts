import { renderMarkdownPrompt } from "./render.js";
import type { PromptSectionMap } from "./types.js";

/**
 * GPT prompt variant for the Bytes agent.
 *
 * Uses flat Markdown headers while sourcing meaning from the canonical overlay builder.
 */
export function buildBytesGptPrompt(sections: PromptSectionMap): string {
  return renderMarkdownPrompt(sections, {
    heading: (_index, title) => `# ${title}`,
    afterFirstSection:
      'NEVER open with filler: "Great question!", "That\'s a great idea!", "Sure!", "Of course!", "Absolutely!", "Let me help with that!", "I\'d be happy to help!", "Let\'s get started!". Start with substance.',
  });
}
