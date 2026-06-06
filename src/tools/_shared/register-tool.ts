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

  // Tools with custom rendering use the self shell so Pi does not add its
  // default tool wrapper around our lightweight call/result lines. Respect an
  // explicit renderShell if the caller already set one.
  const hasCustomRender =
    typeof definition.renderCall === "function" || typeof definition.renderResult === "function";
  const def =
    hasCustomRender && definition.renderShell === undefined
      ? { ...definition, renderShell: "self" }
      : definition;

  // Pi calls tool executors as (toolCallId, params, signal, onUpdate, ctx). Several local
  // tools are implemented as simple pure executors that accept only params. Adapt those at
  // registration time while preserving already Pi-shaped executors like hashline_edit.
  if (typeof def.execute === "function" && def.execute.length <= 1) {
    const execute = def.execute;
    pi.registerTool({
      ...def,
      execute: (_toolCallId: unknown, params: unknown) =>
        execute(params === undefined && typeof _toolCallId === "object" ? _toolCallId : params),
    });
    return;
  }

  pi.registerTool(def);
}
