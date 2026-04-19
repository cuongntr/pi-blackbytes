import { initEnabledSet } from "../config/enabled-set.js";
// Handler functions wired to pi extension events.
import { loadBlackbytesConfig } from "../config/loader.js";
import { getLogger } from "../shared/logger.js";
import { setModelFamily } from "../shared/model-capability.js";
import { getModelFamily } from "../shared/model-capability.js";
import { registerDelegateExploreTool } from "../sub-agents/explore.js";
import { registerDelegateGeneralTool } from "../sub-agents/general.js";
import { registerDelegateLibrarianTool } from "../sub-agents/librarian.js";
import { registerDelegateOracleTool } from "../sub-agents/oracle.js";
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

export async function handleSessionStart(pi: ExtensionAPI, ..._args: any[]): Promise<void> {
  const config = await loadBlackbytesConfig();
  initEnabledSet(config);
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
  // Sub-agent delegates
  registerDelegateExploreTool(pi);
  registerDelegateOracleTool(pi);
  registerDelegateLibrarianTool(pi);
  registerDelegateGeneralTool(pi);
}

export async function handleBeforeAgentStart(..._args: any[]): Promise<void> {
  const event = _args[0] as { systemPrompt?: string } | undefined;
  if (!event?.systemPrompt) return;
  event.systemPrompt = injectPromptAugmentation(event.systemPrompt);
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
