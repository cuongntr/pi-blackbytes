import type { AgentHome } from "./agent-home.js";

/** Fixed, path-free guidance: never expose environment values or registry contents. */
export function getAgentHomeGuidance(home: AgentHome): string | undefined {
  if (home.source === "PI_AGENT_DIR") {
    return "Blackbytes selected legacy PI_AGENT_DIR. Parent Pi auth/model registry may already use a different home and cannot be relocated by Blackbytes. Restart Pi with PI_CODING_AGENT_DIR set to the same directory; PI_AGENT_DIR is optional and must agree. No credentials are copied.";
  }
  if (home.conflict) {
    return "Restart Pi with PI_CODING_AGENT_DIR set to the intended directory; remove PI_AGENT_DIR or set it to the same directory. Blackbytes does not merge homes or copy credentials.";
  }
  return undefined;
}
