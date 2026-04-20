import { getEnabledSet } from "../config/enabled-set.js";
import { BUNDLED_TOOLS, SUB_AGENTS, TOOL_GROUPS } from "../config/resource-metadata.js";
import { createBytesPromptRenderContext } from "../prompts/bytes/shared.js";
import { renderBytesPrompt } from "../prompts/loader.js";
import { resolvePromptModelFamily } from "../shared/model-capability.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SENTINEL_START = "<!-- pi-blackbytes:resources:start -->";
const SENTINEL_END = "<!-- pi-blackbytes:resources:end -->";

// ---------------------------------------------------------------------------
// Block builder
// ---------------------------------------------------------------------------

function buildResourcesBlock(
  enabledTools: ReadonlySet<string>,
  enabledSubAgents: ReadonlySet<string>,
): string {
  const lines: string[] = [
    "The following resources are enabled in this session. Only reference tools, tool groups, and agents listed here \u2014 others may be disabled or unavailable.",
    "",
  ];

  // Bundled tools
  const activeBundled = BUNDLED_TOOLS.map((t) => t.name).filter((t) => enabledTools.has(t));
  if (activeBundled.length > 0) {
    lines.push(`Bundled tools: ${activeBundled.join(", ")}`);
  }

  // External tools by group
  const activeGroups = TOOL_GROUPS.map((group) => ({
    group,
    enabledTools: group.tools.filter((toolName) => enabledTools.has(toolName)),
  })).filter(({ enabledTools }) => enabledTools.length > 0);
  if (activeGroups.length > 0) {
    lines.push("External tools:");
    for (const { group, enabledTools } of activeGroups) {
      lines.push(`- ${group.name} (${group.description}): ${enabledTools.join(", ")}`);
    }
  }

  // Available agents
  const activeAgents = SUB_AGENTS.filter((a) => enabledSubAgents.has(a.name));
  if (activeAgents.length > 0) {
    lines.push("");
    lines.push("Available agents:");
    for (const agent of activeAgents) {
      lines.push(`- ${agent.name}: ${agent.description}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function injectPromptAugmentation(systemPrompt: string, modelId?: string): string {
  let enabledTools = new Set<string>();
  let enabledSubAgents = new Set<string>();

  try {
    const enabledSet = getEnabledSet();
    enabledTools = new Set(enabledSet.tools);
    enabledSubAgents = new Set(enabledSet.subAgents);
  } catch {
    // Fall back to a minimal safe overlay when runtime state is unavailable.
  }

  const resourcesInner = buildResourcesBlock(enabledTools, enabledSubAgents);
  const family = resolvePromptModelFamily(modelId);
  const bytesPrompt = renderBytesPrompt(
    createBytesPromptRenderContext(family, enabledTools, enabledSubAgents),
  );

  const block = [
    SENTINEL_START,
    bytesPrompt,
    "",
    "<available_resources>",
    resourcesInner,
    "</available_resources>",
    SENTINEL_END,
  ].join("\n");

  const startIdx = systemPrompt.indexOf(SENTINEL_START);
  const endIdx = systemPrompt.indexOf(SENTINEL_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing block in-place
    return (
      systemPrompt.slice(0, startIdx) + block + systemPrompt.slice(endIdx + SENTINEL_END.length)
    );
  }

  // Append
  return `${systemPrompt}\n${block}`;
}
