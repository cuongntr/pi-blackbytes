import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { makeRenderCall, str, truncate } from "../_shared/call-render.js";
import { registerTool } from "../_shared/register-tool.js";
import { buildStatsRenderResult } from "../_shared/stats-render.js";
import { executeHandoff } from "./tool.js";

export function registerHandoffTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.HANDOFF, {
    name: TOOL_NAMES.HANDOFF,
    promptSnippet: "Hand off work to a fresh nested Pi session with a self-contained goal.",
    description:
      "Spawn a fresh nested Pi session to continue work in a clean context. " +
      "The new session does NOT inherit the parent transcript — pass everything " +
      "the new thread needs in `goal` (and optionally `prior_summary`). " +
      "Recursive handoff is automatically refused inside an already-nested session.",
    parameters: Type.Object({
      goal: Type.String({
        description:
          "Self-contained brief: what to do, what was already established, key file " +
          "paths, and the success criterion. The nested session has no access to " +
          "the parent transcript.",
      }),
      mode: Type.Optional(
        Type.String({
          description: 'Optional cognitive-style hint (e.g. "deep", "rush", "review").',
        }),
      ),
      prior_summary: Type.Optional(
        Type.String({
          description:
            "Optional caller-supplied summary of relevant prior work. Capped at 4 KB " +
            "and redacted for secrets before being included in the nested prompt.",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { goal: string; mode?: string; prior_summary?: string },
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: {
        cwd?: string;
        sessionManager?: { getBranch?: (id?: string) => unknown[]; getEntries?: () => unknown[] };
      },
    ) =>
      executeHandoff(params, {
        signal,
        cwd: () => ctx?.cwd ?? process.cwd(),
        sessionManager: ctx?.sessionManager,
      }),
    renderCall: makeRenderCall("🤝", "handoff", (args, theme) => {
      const goal = str(args.goal);
      const mode = str(args.mode);
      const parts: string[] = [];
      if (goal) parts.push(theme.fg("accent", `"${truncate(goal, 60)}"`));
      if (mode) parts.push(theme.fg("muted", `[${mode}]`));
      return parts.join(" ");
    }),
    renderResult: buildStatsRenderResult({ partial: "Handing off..." }),
  });
}
