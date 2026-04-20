import { initEnabledSet } from "../config/enabled-set.js";
// Handler functions wired to pi extension events.
import { loadBlackbytesConfig } from "../config/loader.js";
import { registerSubAgentMeta } from "../config/resource-metadata.js";
import { getLogger } from "../shared/logger.js";
import { setModelFamily } from "../shared/model-capability.js";
import { getModelFamily } from "../shared/model-capability.js";
import { declarationToMeta } from "../sub-agents/declaration.js";
import { exploreDeclaration } from "../sub-agents/explore.js";
import { generalDeclaration } from "../sub-agents/general.js";
import { librarianDeclaration } from "../sub-agents/librarian.js";
import { loadYamlDeclarations } from "../sub-agents/loader.js";
import { oracleDeclaration } from "../sub-agents/oracle.js";
import { registerSubAgent } from "../sub-agents/register.js";
import { assertUniqueNames } from "../sub-agents/validate-unique.js";
import { registerAstGrepReplaceTool } from "../tools/ast-grep/replace.js";
import { registerAstGrepSearchTool } from "../tools/ast-grep/search.js";
import { registerQueryDocsTool } from "../tools/context7/query.js";
import { registerResolveLibraryIdTool } from "../tools/context7/resolve.js";
import { registerGlobTool } from "../tools/glob/index.js";
import { registerGrepAppSearchTool } from "../tools/grep-app/search.js";
import { registerGrepTool } from "../tools/grep/index.js";
import { registerHashlineEditTool } from "../tools/hashline-edit/index.js";
import { registerWebsearchFetchTool } from "../tools/websearch/fetch.js";
import { registerWebsearchSearchTool } from "../tools/websearch/search.js";
import type { ExtensionAPI } from "../types/pi.js";
import { injectPromptAugmentation } from "./before-agent-start.js";
import { mapReasoningEffort } from "./before-provider-request.js";
import { registerCopilotHeader } from "./copilot-header.js";
import { type ToolResultEvent, processToolResult } from "./tool-result.js";

/** Builtin sub-agent declarations, assembled before enablement. */
const BUILTIN_DECLARATIONS = [
  exploreDeclaration,
  oracleDeclaration,
  librarianDeclaration,
  generalDeclaration,
];
export async function handleSessionStart(pi: ExtensionAPI, ..._args: any[]): Promise<void> {
  const logger = getLogger();
  const config = await loadBlackbytesConfig();

  // Load YAML declarations and combine with builtins
  const yamlDeclarations = await loadYamlDeclarations();
  const allDeclarations = [...BUILTIN_DECLARATIONS, ...yamlDeclarations];

  // Assert unique names across all declarations before enablement
  const allNames = allDeclarations.map((d) => d.name);
  assertUniqueNames(allNames);

  initEnabledSet(config, allNames);

  if (yamlDeclarations.length > 0) {
    logger.info("Loaded YAML sub-agent declarations", {
      count: yamlDeclarations.length,
      names: yamlDeclarations.map((d) => d.name),
    });
  }

  registerCopilotHeader(pi, config);

  // Local tools
  registerHashlineEditTool(pi);
  registerAstGrepSearchTool(pi);
  registerAstGrepReplaceTool(pi);
  registerGlobTool(pi);
  registerGrepTool(pi);

  // HTTP-based tool groups
  registerWebsearchSearchTool(pi);
  registerWebsearchFetchTool(pi);
  registerResolveLibraryIdTool(pi);
  registerQueryDocsTool(pi);
  registerGrepAppSearchTool(pi);

  // Sub-agent delegates — declaration-driven registration
  for (const decl of allDeclarations) {
    registerSubAgentMeta(declarationToMeta(decl));
    registerSubAgent(pi, decl);
  }
}

export async function handleBeforeAgentStart(..._args: any[]): Promise<void> {
  const event = _args[0] as { systemPrompt?: string; modelId?: string } | undefined;
  if (!event?.systemPrompt) return;
  if (event.modelId) {
    setModelFamily(event.modelId);
  }
  event.systemPrompt = injectPromptAugmentation(event.systemPrompt, event.modelId);
}

export async function handleModelSelect(..._args: any[]): Promise<void> {
  const event = _args[0] as { modelId?: string } | undefined;
  if (event?.modelId) {
    setModelFamily(event.modelId);
  }
}

export async function handleBeforeProviderRequest(..._args: any[]): Promise<void> {
  const event = _args[0] as
    | { payload?: Record<string, unknown>; reasoningEffort?: string }
    | undefined;
  if (!event?.payload) return;
  const family = getModelFamily();
  // Env var fallback allows sub-agents to inherit reasoning effort from parent
  const reasoningEffort = event.reasoningEffort ?? process.env.BLACKBYTES_REASONING_EFFORT;
  mapReasoningEffort(event.payload, reasoningEffort, family);
}

export async function handleToolResult(..._args: any[]): Promise<void> {
  const event = _args[0] as ToolResultEvent | undefined;
  if (!event) return;
  const config = await loadBlackbytesConfig();
  const modified = processToolResult(event, { hashline_edit: config.hashline_edit });
  if (modified) {
    // Apply modifications back to the mutable event
    event.content = modified.content;
  }
}

export async function handleSessionShutdown(..._args: any[]): Promise<void> {
  const logger = getLogger();
  await logger.flush();
}
