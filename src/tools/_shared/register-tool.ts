import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
  pi.registerTool(definition);
}
