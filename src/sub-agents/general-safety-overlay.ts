import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnabledSet } from "../config/enabled-set.js";
import { redactSecrets } from "../shared/redact.js";
export { redactSecrets };

/**
 * Maximum size, in characters, of the rendered safety overlay block.
 * Derived from the bead 1.3 polish constraint (~8–12KB). We pick the lower
 * bound so the block stays small relative to typical persona prompts.
 */
export const GENERAL_SAFETY_OVERLAY_MAX_CHARS = 8192;

/**
 * Maximum number of bytes of repository AGENTS.md content we are willing to
 * include verbatim in the overlay. Repo content is the largest variable
 * input; capping it bounds the overlay before the deterministic truncate.
 */
const AGENTS_MD_MAX_CHARS = 4096;

/**
 * Sentinel/header markers used in tests to assert the overlay is present.
 */
export const GENERAL_SAFETY_OVERLAY_HEADER = "## Execution Safety Overlay (General sub-agent)";
export const GENERAL_SAFETY_OVERLAY_FOOTER = "## End Execution Safety Overlay";

export interface BuildGeneralSafetyOverlayInput {
  /** Working directory this nested session will run in. */
  readonly cwd?: string;
  /** Snapshot of enabled tools / sub-agents / disabled tools / skills. */
  readonly enabledSet: EnabledSet;
  /** Final allowlist passed to `runNestedPi()` (already finalized). */
  readonly finalizedTools: readonly string[];
  /**
   * Override the file reader (used in tests). Default reads from disk.
   * Returns `undefined` when the file is missing.
   */
  readonly readRepoFile?: (relativePath: string) => Promise<string | undefined>;
}

async function defaultReadRepoFile(
  cwd: string | undefined,
  relativePath: string,
): Promise<string | undefined> {
  if (!cwd) return undefined;
  try {
    return await readFile(join(cwd, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return "_(none)_";
  return items
    .map((i) => `\`${i}\``)
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
}

/**
 * Build a deterministic, bounded safety/context overlay for the General
 * sub-agent. The overlay is prepended to the persona system prompt so
 * downstream Pi sees:
 *
 *   [overlay]\n\n[persona prompt]
 *
 * The overlay is intentionally small (~8KB cap), redacted for obvious
 * secrets, and falls back to a minimal block if repo instructions cannot
 * be read.
 */
export async function buildGeneralSafetyOverlay(
  input: BuildGeneralSafetyOverlayInput,
): Promise<string> {
  const {
    cwd,
    enabledSet,
    finalizedTools,
    readRepoFile = (rel) => defaultReadRepoFile(cwd, rel),
  } = input;

  // Resolve repository constraints (AGENTS.md). Truncate to a small budget
  // so the overlay stays bounded regardless of repo size.
  let agentsMd: string | undefined;
  try {
    const raw = await readRepoFile("AGENTS.md");
    if (raw && raw.trim().length > 0) {
      const trimmed =
        raw.length > AGENTS_MD_MAX_CHARS
          ? `${raw.slice(0, AGENTS_MD_MAX_CHARS)}\n\n_…(truncated for overlay)…_`
          : raw;
      agentsMd = redactSecrets(trimmed);
    }
  } catch {
    agentsMd = undefined;
  }

  const tools = formatList([...finalizedTools]);
  const enabledTools = formatList([...enabledSet.tools]);
  const disabledTools = formatList([...enabledSet.disabledTools]);
  const enabledAgents = formatList([...enabledSet.subAgents]);

  const sections: string[] = [];

  sections.push(GENERAL_SAFETY_OVERLAY_HEADER);
  sections.push(
    "_This block is injected by the host before your persona prompt. " +
      "It bounds the execution context of this nested Pi session. " +
      "Treat it as authoritative for the host environment._",
  );

  sections.push("### Working Environment");
  sections.push(`- Working directory: \`${cwd ?? "(host process cwd)"}\``);
  sections.push(`- Final allowlist passed to nested Pi: ${tools}`);
  sections.push(`- Extension tools enabled in this session: ${enabledTools}`);
  sections.push(`- Globally disabled tools (denylist): ${disabledTools}`);
  sections.push(`- Sibling sub-agents registered: ${enabledAgents}`);

  sections.push("### Hard Rules");
  sections.push(
    "- **No recursive delegation.** You are a nested sub-agent. You MUST NOT " +
      "call any `delegate_*` tool. The host strips them from your allowlist; " +
      "do not attempt to invoke them via shell either.",
  );
  sections.push(
    "- **No git mutations without explicit instruction.** Do not run " +
      "`git push`, `git reset --hard`, `git rebase -i`, branch deletions, " +
      "force-push, or any destructive git command unless the task explicitly " +
      "requires it.",
  );
  sections.push(
    "- **Do not commit secrets.** Never stage or echo `.env`, credential " +
      "files, API keys, or tokens. Treat any value matching " +
      "`API_KEY|TOKEN|SECRET|PASSWORD` as sensitive.",
  );
  sections.push(
    "- **Do not introduce new dependencies** unless the task explicitly " +
      "instructs you to add one.",
  );
  sections.push(
    "- **Stay in scope.** Do not refactor, reformat, or rewrite files " +
      "outside the requested change set.",
  );
  sections.push(
    "- **Verification source of truth.** Before claiming completion, prefer " +
      "the repository-defined full verification command from AGENTS.md or " +
      "project scripts. If none exists, run the relevant available checks " +
      "(lint, typecheck, build, tests) using repository conventions. Report " +
      "outcomes honestly; never weaken or skip a gate to fabricate a green result.",
  );

  if (agentsMd) {
    sections.push("### Repository Constraints (from AGENTS.md)");
    sections.push(agentsMd);
  } else {
    sections.push("### Repository Constraints");
    sections.push("_AGENTS.md not available; falling back to host hard rules above._");
  }

  sections.push(GENERAL_SAFETY_OVERLAY_FOOTER);

  let rendered = sections.join("\n\n");

  // Final deterministic safety net: hard-cap the rendered overlay.
  if (rendered.length > GENERAL_SAFETY_OVERLAY_MAX_CHARS) {
    const head = rendered.slice(
      0,
      GENERAL_SAFETY_OVERLAY_MAX_CHARS - GENERAL_SAFETY_OVERLAY_FOOTER.length - 32,
    );
    rendered = `${head}\n\n_…(overlay truncated)…_\n\n${GENERAL_SAFETY_OVERLAY_FOOTER}`;
  }

  return rendered;
}
