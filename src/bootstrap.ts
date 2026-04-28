import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { handleBlackbytesStatus } from "./commands/blackbytes-status.js";
import { registerSetupModelsCommand } from "./commands/setup-models.js";
import {
  handleAgentStart,
  handleBeforeAgentStart,
  handleBeforeProviderRequest,
  handleModelSelect,
  handleSessionShutdown,
  handleSessionStart,
  handleToolResult,
} from "./handlers/index.js";
import { registerCompactToolsCommand } from "./tools/compact-tools/index.js";

// Utility function to wrap event handlers with error handling
function wrap<E, R>(
  eventName: string,
  handler: (event: E, ctx: ExtensionContext) => Promise<R> | R,
): (event: E, ctx: ExtensionContext) => Promise<R | undefined> {
  return async (event: E, ctx: ExtensionContext) => {
    try {
      return await handler(event, ctx);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pi-blackbytes] Error in ${eventName} handler:`, err);
      try {
        ctx.ui.notify(`[pi-blackbytes] ${eventName}: ${message}`, "error");
      } catch {
        // ignore secondary errors from notify
      }
      return undefined;
    }
  };
}

export function bootstrap(pi: ExtensionAPI): void {
  pi.on(
    "session_start",
    wrap("session_start", (event, ctx) => handleSessionStart(pi, event, ctx)),
  );
  pi.on("before_agent_start", wrap("before_agent_start", handleBeforeAgentStart));
  pi.on("agent_start", wrap("agent_start", handleAgentStart));
  pi.on("model_select", wrap("model_select", handleModelSelect));
  pi.on("before_provider_request", wrap("before_provider_request", handleBeforeProviderRequest));
  pi.on("tool_result", wrap("tool_result", handleToolResult));
  pi.on("session_shutdown", wrap("session_shutdown", handleSessionShutdown));
  pi.registerCommand("blackbytes-status", {
    handler: async (_args: string, _ctx) => {
      const output = await handleBlackbytesStatus();
      console.log(output);
    },
  });
  registerSetupModelsCommand(pi);
  registerCompactToolsCommand(pi);
}
