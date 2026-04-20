import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getEnabledSet } from "../config/enabled-set.js";
import type { SubAgentDeclaration } from "./declaration.js";
import { type SpawnFn, runNestedPi } from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RegisterSubAgentOptions {
  /** Override the default spawn function (for testing). */
  spawnFn?: SpawnFn;
}

/**
 * Register a sub-agent with the Pi host based on its declaration.
 * Skips registration silently when the agent is not in the enabled set.
 *
 * This is the generic replacement for per-agent `registerDelegate*Tool()`
 * functions. It reads the system prompt, resolves allowed tools and model
 * overrides from the declaration, then delegates to `runNestedPi()`.
 */
export function registerSubAgent(
  pi: ExtensionAPI,
  declaration: SubAgentDeclaration,
  options?: RegisterSubAgentOptions,
): void {
  if (!getEnabledSet().subAgents.has(declaration.name)) return;

  const { spawnFn } = options ?? {};

  (pi.registerTool as (def: unknown) => void)({
    name: declaration.toolName,
    description: declaration.description,
    parameters: declaration.parameters,
    execute: async (params: Record<string, unknown>) => {
      const systemPrompt =
        declaration.systemPrompt ??
        (declaration.systemPromptPath
          ? await readFile(join(__dirname, "..", declaration.systemPromptPath), "utf-8")
          : undefined);

      if (!systemPrompt) {
        throw new Error(
          `Sub-agent "${declaration.name}" has neither systemPrompt nor systemPromptPath`,
        );
      }

      const userPrompt = declaration.buildUserPrompt(params);

      const allowedTools =
        typeof declaration.allowedTools === "function"
          ? [...declaration.allowedTools()]
          : [...declaration.allowedTools];

      const overrides = (await declaration.resolveModelOverrides?.()) ?? {};

      const result = await runNestedPi(
        {
          systemPrompt,
          userPrompt,
          model: overrides.model,
          reasoningEffort: overrides.reasoningEffort,
          allowedTools,
        },
        spawnFn,
      );

      return {
        content: result.success ? result.content : `Error: ${result.content}`,
      };
    },
  });
}
