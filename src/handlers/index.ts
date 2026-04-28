import type {
  AgentStartEvent,
  BeforeAgentStartEvent,
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent as PiToolResultEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { setupBranding } from "../branding.js";
import { initEnabledSet } from "../config/enabled-set.js";
import { loadBlackbytesConfig } from "../config/loader.js";
import { registerSubAgentMeta } from "../config/resource-metadata.js";
import { getLogger } from "../shared/logger.js";
import { setModelFamily } from "../shared/model-capability.js";
import { resetSessionRuntimeState } from "../shared/session-state.js";
import {
  captureAgentStartSystemPrompt,
  captureProviderSystemPrompts,
} from "../shared/system-prompt-log.js";
import { declarationToMeta } from "../sub-agents/declaration.js";
import { setYamlDiagnostics } from "../sub-agents/diagnostics.js";
import { exploreDeclaration } from "../sub-agents/explore.js";
import { generalDeclaration } from "../sub-agents/general.js";
import { librarianDeclaration } from "../sub-agents/librarian.js";
import { loadYamlDeclarations } from "../sub-agents/loader.js";
import { oracleDeclaration } from "../sub-agents/oracle.js";
import { registerSubAgent } from "../sub-agents/register.js";
import { reviewerDeclaration } from "../sub-agents/reviewer.js";
import { initAgentSnapshot } from "../sub-agents/snapshot.js";
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
import { registerCopilotHeader } from "./copilot-header.js";
import { type ToolResultEvent as LocalToolResultEvent, processToolResult } from "./tool-result.js";
/** Minimal shape of Pi's model_select event (not re-exported from the top-level package export). */
interface ModelSelectEvent {
  model: { id: string };
}

interface BeforeAgentStartResult {
  systemPrompt?: string;
}

type ToolResultResult = Partial<Pick<PiToolResultEvent, "content" | "details" | "isError">>;

/** Builtin sub-agent declarations, assembled before enablement. */
const BUILTIN_DECLARATIONS = [
  exploreDeclaration,
  oracleDeclaration,
  librarianDeclaration,
  generalDeclaration,
  reviewerDeclaration,
];
export async function handleSessionStart(
  pi: ExtensionAPI,
  _event: SessionStartEvent,
  _ctx: ExtensionContext,
): Promise<void> {
  const logger = getLogger();
  // Idempotency: clear any session-scoped runtime state before loading
  // config or registering anything. This protects against repeated startups
  // in the same process (e.g. tests, restarts) and against a previous
  // partial/failed startup leaving stale singletons.
  resetSessionRuntimeState();
  const config = await loadBlackbytesConfig();

  // Load YAML declarations and combine with builtins
  // Builtin names are reserved — YAML files claiming the same name are skipped with diagnostics.
  assertUniqueNames(BUILTIN_DECLARATIONS.map((d) => d.name));
  const builtinNames = BUILTIN_DECLARATIONS.map((d) => d.name);
  const { declarations: yamlDeclarations, diagnostics } = await loadYamlDeclarations(builtinNames);
  setYamlDiagnostics(diagnostics);
  const allDeclarations = [...BUILTIN_DECLARATIONS, ...yamlDeclarations];
  // allDeclarations is now guaranteed unique: builtins are unique (asserted above),
  // and loader already deduped yaml against builtins + earlier yaml files.
  const allNames = allDeclarations.map((d) => d.name);

  initEnabledSet(config, allNames);
  initAgentSnapshot(allDeclarations, config);

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

  // Branding widget below the editor
  setupBranding(_ctx);
}

export async function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): Promise<BeforeAgentStartResult> {
  const modelId = ctx.model?.id;
  if (modelId) {
    setModelFamily(modelId);
  }
  return { systemPrompt: injectPromptAugmentation(event.systemPrompt, modelId) };
}

export async function handleAgentStart(
  _event: AgentStartEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const config = await loadBlackbytesConfig();
  await captureAgentStartSystemPrompt(config, ctx);
}

export async function handleModelSelect(
  event: ModelSelectEvent,
  _ctx: ExtensionContext,
): Promise<void> {
  setModelFamily(event.model.id);
}

export async function handleBeforeProviderRequest(
  event: BeforeProviderRequestEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  if (!payload) return;

  const config = await loadBlackbytesConfig();
  await captureProviderSystemPrompts(config, payload, ctx);
}

export async function handleToolResult(
  event: PiToolResultEvent,
  _ctx: ExtensionContext,
): Promise<ToolResultResult | undefined> {
  const config = await loadBlackbytesConfig();
  const modified = processToolResult(event as LocalToolResultEvent, {
    hashline_edit: config.hashline_edit,
  });
  if (modified) {
    // Apply modifications back to the mutable event for local tests and return
    // the result for Pi's return-based tool_result contract.
    (event as LocalToolResultEvent).content = modified.content;
    return { content: modified.content as PiToolResultEvent["content"] };
  }
  return undefined;
}

export async function handleSessionShutdown(
  _event: SessionShutdownEvent,
  _ctx: ExtensionContext,
): Promise<void> {
  const logger = getLogger();
  await logger.flush();
}
