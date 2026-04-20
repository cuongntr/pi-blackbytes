import type {
  BeforeAgentStartEvent,
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent as PiToolResultEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { initEnabledSet } from "../config/enabled-set.js";
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
import { injectPromptAugmentation } from "./before-agent-start.js";
import { mapReasoningEffort } from "./before-provider-request.js";
import { registerCopilotHeader } from "./copilot-header.js";
import { type ToolResultEvent as LocalToolResultEvent, processToolResult } from "./tool-result.js";
/** Minimal shape of Pi's model_select event (not re-exported from the top-level package export). */
interface ModelSelectEvent {
  model: { id: string };
}

/** Builtin sub-agent declarations, assembled before enablement. */
const BUILTIN_DECLARATIONS = [
  exploreDeclaration,
  oracleDeclaration,
  librarianDeclaration,
  generalDeclaration,
];
export async function handleSessionStart(
  pi: ExtensionAPI,
  _event: SessionStartEvent,
  _ctx: ExtensionContext,
): Promise<void> {
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

export async function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const modelId = ctx.model?.id;
  if (modelId) {
    setModelFamily(modelId);
  }
  event.systemPrompt = injectPromptAugmentation(event.systemPrompt, modelId);
}

export async function handleModelSelect(
  event: ModelSelectEvent,
  _ctx: ExtensionContext,
): Promise<void> {
  setModelFamily(event.model.id);
}

export async function handleBeforeProviderRequest(
  event: BeforeProviderRequestEvent,
  _ctx: ExtensionContext,
): Promise<void> {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  if (!payload) return;
  const family = getModelFamily();
  // Env var fallback allows sub-agents to inherit reasoning effort from parent
  const reasoningEffort = process.env.BLACKBYTES_REASONING_EFFORT;
  mapReasoningEffort(payload, reasoningEffort, family);
}

export async function handleToolResult(
  event: PiToolResultEvent,
  _ctx: ExtensionContext,
): Promise<void> {
  const config = await loadBlackbytesConfig();
  const modified = processToolResult(event as LocalToolResultEvent, {
    hashline_edit: config.hashline_edit,
  });
  if (modified) {
    // Apply modifications back to the mutable event
    (event as LocalToolResultEvent).content = modified.content;
  }
}

export async function handleSessionShutdown(
  _event: SessionShutdownEvent,
  _ctx: ExtensionContext,
): Promise<void> {
  const logger = getLogger();
  await logger.flush();
}
