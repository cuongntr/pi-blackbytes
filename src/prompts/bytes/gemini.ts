import { renderMarkdownPrompt } from "./render.js";
import type { PromptSectionMap } from "./types.js";

/**
 * Gemini prompt variant for the Bytes agent.
 *
 * Uses numbered Markdown headers while sourcing meaning from the canonical overlay builder.
 */
export function buildBytesGeminiPrompt(sections: PromptSectionMap): string {
  return renderMarkdownPrompt(sections, {
    heading: (index, title) => `## ${index}. ${title}`,
    afterFirstSection: "Do not use filler phrases. Start with substance directly.",
  });
}
