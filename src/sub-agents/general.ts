import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { getEnabledSet } from "../config/enabled-set.js";
import type { ExtensionAPI } from "../types/pi.js";
import { type SpawnFn, runNestedPi } from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerDelegateGeneralTool(pi: ExtensionAPI, spawnFn?: SpawnFn): void {
  if (!getEnabledSet().subAgents.has("general")) return;

  pi.registerTool({
    name: "delegate_general",
    description:
      "Delegate a heavy implementation task to a General sub-agent — a focused, " +
      "productive engineer that executes well-defined work end-to-end. Use when you " +
      "need to offload coding, refactoring, debugging, or multi-file changes. " +
      "Full write access: the sub-agent receives all enabled extension tools " +
      "(read, write, bash, search, extension tools) except delegate_* tools " +
      "to prevent recursive sub-agent delegation.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "The implementation task to delegate. Include all context needed to execute " +
          "the task independently: file paths, expected behaviour, constraints, and " +
          "definition of done.",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Additional context (code snippets, error messages, relevant background) " +
            "to include with the task.",
        }),
      ),
    }),
    execute: async (params: { task: string; context?: string }) => {
      const prompt = await readFile(join(__dirname, "../prompts/general.md"), "utf-8");

      // All enabled tools except delegate_* (prevent recursive delegation)
      const allowedTools = [...getEnabledSet().tools].filter((t) => !t.startsWith("delegate_"));

      const userPrompt = params.context
        ? `${params.task}\n\n---\n\nAdditional context:\n${params.context}`
        : params.task;

      const result = await runNestedPi(
        {
          systemPrompt: prompt,
          userPrompt,
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
