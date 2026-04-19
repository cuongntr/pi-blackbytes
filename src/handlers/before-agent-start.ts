import { getEnabledSet } from "../config/enabled-set.js";
import { BUNDLED_TOOLS, MCP_SERVERS, SUB_AGENTS } from "../config/resource-metadata.js";
import { loadBytesPrompt } from "../prompts/loader.js";

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
    "You have access to a set of tools you can use to answer the user's question.",
    "",
  ];

  // Bundled tools
  const activeBundled = BUNDLED_TOOLS.map((t) => t.name).filter((t) => enabledTools.has(t));
  if (activeBundled.length > 0) {
    lines.push(`Bundled tools: ${activeBundled.join(", ")}`);
  }

  // MCP servers
  for (const server of MCP_SERVERS) {
    const activeTools = server.tools.filter((t) => enabledTools.has(t));
    if (activeTools.length === 0) continue;
    lines.push(`MCP servers: ${server.name} (${server.description})`);
    lines.push(`MCP tools namespaced as {server}_{tool}: ${activeTools.join(", ")}`);
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

export function injectPromptAugmentation(systemPrompt: string): string {
  const { tools, subAgents } = getEnabledSet();
  const resourcesInner = buildResourcesBlock(tools, subAgents);
  const hashlineEditEnabled = tools.has("hashline_edit");
  const bytesPrompt = loadBytesPrompt(undefined, hashlineEditEnabled);

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
