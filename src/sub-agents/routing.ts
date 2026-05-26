import type { SubAgentMeta } from "../config/resource-metadata.js";

/**
 * Build a deterministic routing summary from runtime metadata.
 * Filters to enabled agents, sorts alphabetically by name for stability.
 * YAML agents without routing produce a placeholder entry.
 */
export function buildRoutingSummary(
  metas: readonly SubAgentMeta[],
  enabledSubAgents: ReadonlySet<string>,
): string {
  const filtered = metas
    .filter((m) => enabledSubAgents.has(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (filtered.length === 0) return "";

  const lines: string[] = [];

  for (const meta of filtered) {
    if (!meta.routing) {
      lines.push(`- **${meta.name}** — —`);
      continue;
    }
    const r = meta.routing;
    const useItems = r.useWhen.map((s) => `  - ${s}`).join("\n");
    const avoidItems = r.avoidWhen.map((s) => `  - ${s}`).join("\n");
    lines.push(
      `- **${meta.name}** [${r.category}, ${r.cost} cost]${r.keyTrigger ? ` — ${r.keyTrigger}` : ""}`,
    );
    if (r.useWhen.length > 0) {
      lines.push(`  Use when:\n${useItems}`);
    }
    if (r.avoidWhen.length > 0) {
      lines.push(`  Avoid when:\n${avoidItems}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build a concise routing matrix for the Bytes overlay prompt.
 * Each enabled agent gets a one-line entry with key trigger.
 * Sorted alphabetically for deterministic output.
 */
export function buildOverlayRoutingMatrix(
  metas: readonly SubAgentMeta[],
  enabledSubAgents: ReadonlySet<string>,
): string[] {
  const filtered = metas
    .filter((m) => enabledSubAgents.has(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const routes: string[] = [];
  for (const meta of filtered) {
    if (!meta.routing) {
      routes.push(`\`${meta.name}\` — custom agent`);
      continue;
    }
    const r = meta.routing;
    const trigger = r.keyTrigger ?? r.useWhen[0] ?? r.category;
    routes.push(`\`${meta.name}\` — ${trigger}`);
  }
  return routes;
}
