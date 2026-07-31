import { renderMarkdownPrompt } from "./render.js";
import type { PromptSectionMap } from "./types.js";

/**
 * Kimi (Moonshot) prompt variant for the Bytes agent.
 *
 * Style: terse, instruction-dense, no worked examples. Kimi-class models
 * respond well to compact rule lists with explicit verbs and minimal
 * decoration. Headings use plain `##` without numbering.
 */
export function buildBytesKimiPrompt(sections: PromptSectionMap): string {
  return renderMarkdownPrompt(sections, {
    heading: (_index, title) => `## ${title}`,
    afterFirstSection:
      "Be terse and direct. No filler or flattery. For non-trivial work, state the intended outcome first; then report only meaningful progress, discoveries, blockers, and results.",
  });
}
