/**
 * Sub-agent display icons used across renderers (call-line + result header).
 * Centralized here so render.ts and register.ts share one source of truth.
 */

export const SUB_AGENT_ICONS: Record<string, string> = {
  explore: "🔭",
  oracle: "🧠",
  librarian: "📚",
  general: "⚡",
};

/** Resolve agent icon with a neutral fallback for unknown / YAML agents. */
export function getAgentIcon(name: string | undefined): string {
  if (!name) return "▸";
  return SUB_AGENT_ICONS[name] ?? "▸";
}
