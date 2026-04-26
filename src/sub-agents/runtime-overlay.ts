/**
 * Shared runtime overlay builder for sub-agents.
 *
 * Pi-blackbytes architecture splits a sub-agent's system prompt in two:
 *
 *   [runtime overlay]  ← built here, injected via `prependSystemPrompt`
 *   [persona prompt]   ← static `systemPrompt` from the declaration
 *
 * The overlay carries volatile, session-derived context (current date,
 * finalized tool list, working dir, optional agent-specific sections) so the
 * static persona prompt can stay short and stable.
 *
 * Constraints:
 *  - Bounded size (hard cap, ~4KB by default).
 *  - Deterministic ordering of sections.
 *  - Secrets in caller-provided sections are redacted with the same
 *    patterns as the General safety overlay.
 *  - Never injects sub-agent delegation hints — nested sessions must not
 *    spawn further sub-agents.
 */

import { redactSecrets } from "./general-safety-overlay.js";

/** Hard cap on the rendered overlay, in characters. Smaller than the General
 * safety overlay because this overlay does not carry AGENTS.md content. */
export const SUB_AGENT_RUNTIME_OVERLAY_MAX_CHARS = 4096;

export const SUB_AGENT_RUNTIME_OVERLAY_HEADER = "## Runtime Overlay (sub-agent)";
export const SUB_AGENT_RUNTIME_OVERLAY_FOOTER = "## End Runtime Overlay";

/** A single section to append after the standard runtime sections. */
export interface OverlaySection {
  /** Markdown heading (e.g. `### Citation Policy`). */
  readonly heading: string;
  /** Section body. Will be passed through `redactSecrets()`. */
  readonly body: string;
}

export interface BuildSubAgentRuntimeOverlayInput {
  /** Sub-agent name (for the header). */
  readonly agentName: string;
  /** Working directory the nested Pi session will run in. */
  readonly cwd?: string;
  /** Final tool allowlist passed to the nested Pi process. */
  readonly finalizedTools: readonly string[];
  /** Optional agent-specific sections (e.g. citation policy, classification). */
  readonly sections?: readonly OverlaySection[];
  /**
   * Override the current date (used in tests for deterministic snapshots).
   * Default: `new Date()`.
   */
  readonly now?: Date;
}

function formatToolList(tools: readonly string[]): string {
  if (tools.length === 0) return "_(none)_";
  return [...tools]
    .sort((a, b) => a.localeCompare(b))
    .map((t) => `\`${t}\``)
    .join(", ");
}

/** ISO-style date and year for date-aware research/citation prompts. */
function formatCurrentDate(now: Date): { iso: string; year: number } {
  const iso = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return { iso, year: now.getUTCFullYear() };
}

/**
 * Build a deterministic, bounded runtime overlay for a sub-agent.
 *
 * The overlay is intentionally small. It does NOT duplicate the persona
 * prompt or the parent's Bytes v2 overlay — only volatile, session-derived
 * context that the persona cannot encode statically.
 */
export function buildSubAgentRuntimeOverlay(input: BuildSubAgentRuntimeOverlayInput): string {
  const { agentName, cwd, finalizedTools, sections = [], now = new Date() } = input;

  const date = formatCurrentDate(now);
  const tools = formatToolList(finalizedTools);

  const blocks: string[] = [];

  blocks.push(`${SUB_AGENT_RUNTIME_OVERLAY_HEADER}: \`${agentName}\``);
  blocks.push(
    "_This block is injected by the host before your persona prompt. " +
      "Treat it as authoritative for session-derived context (date, tools, cwd)._",
  );

  blocks.push("### Current Date");
  blocks.push(
    `- Today is **${date.iso}**. Current year is **${date.year}**. Use this when forming web/search queries; do NOT default to older years.`,
  );

  blocks.push("### Working Environment");
  blocks.push(`- Working directory: \`${cwd ?? "(host process cwd)"}\``);
  blocks.push(`- Final tool allowlist: ${tools}`);

  for (const section of sections) {
    blocks.push(section.heading);
    blocks.push(redactSecrets(section.body));
  }

  blocks.push(SUB_AGENT_RUNTIME_OVERLAY_FOOTER);

  let rendered = blocks.join("\n\n");

  if (rendered.length > SUB_AGENT_RUNTIME_OVERLAY_MAX_CHARS) {
    const head = rendered.slice(
      0,
      SUB_AGENT_RUNTIME_OVERLAY_MAX_CHARS - SUB_AGENT_RUNTIME_OVERLAY_FOOTER.length - 32,
    );
    rendered = `${head}\n\n_…(overlay truncated)…_\n\n${SUB_AGENT_RUNTIME_OVERLAY_FOOTER}`;
  }

  return rendered;
}
