import { renderXmlPrompt } from "./render.js";
import type { PromptSectionKey, PromptSectionMap } from "./types.js";

/**
 * Default (Claude/Anthropic) prompt variant for the Bytes agent.
 *
 * Uses XML-style wrappers, mirroring the Amp Smart QT4 structure.
 */
const CLAUDE_TAGS: Record<PromptSectionKey, string> = {
  identity: "identity",
  precedence: "precedence",
  autonomy_and_persistence: "autonomy_and_persistence",
  investigate_before_acting: "investigate_before_acting",
  session_capabilities: "capabilities",
  hard_boundaries: "engineering",
  work_defaults: "workflow_defaults",
  tool_use_protocol: "tool_use",
  verification_contract: "verification",
  executing_actions_with_care: "executing_actions_with_care",
  conditional_workflows: "workflow",
  markdown_format: "markdown_format",
  file_references: "file_references",
  completion_contract: "completion",
};

export function buildBytesDefaultPrompt(sections: PromptSectionMap): string {
  return renderXmlPrompt(sections, CLAUDE_TAGS);
}
