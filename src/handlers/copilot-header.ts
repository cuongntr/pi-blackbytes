import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerCopilotHeader(
  pi: ExtensionAPI,
  config: { copilot_initiator_header: boolean },
): void {
  if (!config.copilot_initiator_header) return;
  pi.registerProvider("github-copilot", { headers: { "x-initiator": "agent" } });
}
