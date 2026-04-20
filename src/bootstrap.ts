import { handleBlackbytesStatus } from "./commands/blackbytes-status.js";
import { registerSetupModelsCommand } from "./commands/setup-models.js";
import {
  handleBeforeAgentStart,
  handleBeforeProviderRequest,
  handleModelSelect,
  handleSessionShutdown,
  handleSessionStart,
  handleToolResult,
} from "./handlers/index.js";
import type { ExtensionAPI } from "./types/pi.js";

// Define the shape of the event context for error handling
interface EventContext {
  ui?: {
    notify(level: string, message: string): void;
  };
}

// Utility function to wrap event handlers with error handling
function wrap(
  eventName: string,
  handler: (...args: any[]) => Promise<void>,
): (...args: any[]) => void {
  return (...args: any[]) => {
    handler(...args).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pi-blackbytes] Error in ${eventName} handler:`, err);
      const ctx = args[0] as EventContext | undefined;
      try {
        ctx?.ui?.notify("error", `[pi-blackbytes] ${eventName}: ${message}`);
      } catch {
        // ignore secondary errors from notify
      }
    });
  };
}

export function bootstrap(pi: ExtensionAPI): void {
  pi.on(
    "session_start",
    wrap("session_start", (...args: any[]) => handleSessionStart(pi, ...args)),
  );
  pi.on("before_agent_start", wrap("before_agent_start", handleBeforeAgentStart));
  pi.on("model_select", wrap("model_select", handleModelSelect));
  pi.on("before_provider_request", wrap("before_provider_request", handleBeforeProviderRequest));
  pi.on("tool_result", wrap("tool_result", handleToolResult));
  pi.on("session_shutdown", wrap("session_shutdown", handleSessionShutdown));
  pi.registerCommand("blackbytes-status", async () => {
    const output = await handleBlackbytesStatus();
    console.log(output);
  });
  registerSetupModelsCommand(pi);
}
