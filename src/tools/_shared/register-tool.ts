import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getEnabledSet } from "../../config/enabled-set.js";

/**
 * Registers a tool with the pi extension API if it is enabled in the current session config.
 * If the tool is disabled, registration is silently skipped.
 *
 * Note: `definition` is typed as `any` to match ExtensionAPI.registerTool's signature,
 * which accepts varied shapes (parameters/inputSchema, execute/handler).
 */
export function registerTool(pi: ExtensionAPI, name: string, definition: any): void {
  if (!getEnabledSet().tools.has(name)) {
    return;
  }

  // Pi calls tool executors as (toolCallId, params, signal, onUpdate, ctx). Several local
  // tools are implemented as simple pure executors that accept only params. Adapt those at
  // registration time while preserving already Pi-shaped executors like hashline_edit.
  if (typeof definition.execute === "function" && definition.execute.length <= 1) {
    const execute = definition.execute;
    pi.registerTool({
      ...definition,
      execute: (_toolCallId: unknown, params: unknown) =>
        execute(params === undefined && typeof _toolCallId === "object" ? _toolCallId : params),
    });
    return;
  }

  pi.registerTool(definition);
}
