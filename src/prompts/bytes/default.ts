import { renderXmlPrompt } from "./render.js";
import type { PromptSectionMap } from "./types.js";

/**
 * Default (Claude/Anthropic) prompt variant for the Bytes agent.
 *
 * Uses XML-style wrappers while sourcing meaning from the canonical overlay builder.
 */
export function buildBytesDefaultPrompt(sections: PromptSectionMap): string {
  return renderXmlPrompt(sections, {
    precedence: "agency",
    session_capabilities: "capabilities",
    hard_boundaries: "engineering",
    work_defaults: "workflow_defaults",
    conditional_workflows: "workflow",
    completion_contract: "completion",
  });
}
