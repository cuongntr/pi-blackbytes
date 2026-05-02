import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_NAMES } from "../../config/resource-metadata.js";
import { makeRenderCall, str, truncate } from "../_shared/call-render.js";
import { registerTool } from "../_shared/register-tool.js";
import { buildStatsRenderResult } from "../_shared/stats-render.js";
import { type LookAtParams, executeLookAt } from "./tool.js";

export function registerLookAtTool(pi: ExtensionAPI): void {
  registerTool(pi, TOOL_NAMES.LOOK_AT, {
    name: TOOL_NAMES.LOOK_AT,
    promptSnippet: "Inspect a local image file (PNG/JPG/GIF/WebP) with an objective.",
    description:
      "Load a local image (and up to 3 optional reference images) and return them " +
      "alongside an analysis objective so the model can describe, compare, or extract " +
      "information from them. Maximum 10 MB per image. Use this for screenshots, " +
      "diagrams, mockups, or other visual content the read tool cannot interpret.",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute or cwd-relative path to the primary image file.",
      }),
      objective: Type.String({
        description: "Natural-language description of what to extract or describe.",
      }),
      context: Type.Optional(
        Type.String({
          description: "Optional broader background or success criterion.",
        }),
      ),
      referenceFiles: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional reference image paths for comparison or style guidance (max 3).",
          maxItems: 3,
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: LookAtParams,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: { cwd?: string },
    ) => executeLookAt(params, { cwd: () => ctx?.cwd ?? process.cwd() }),
    renderCall: makeRenderCall("👁️", "look_at", (args, theme) => {
      const path = str(args.path);
      const objective = str(args.objective);
      const parts: string[] = [];
      if (path) parts.push(theme.fg("toolOutput", truncate(path, 40)));
      if (objective) parts.push(theme.fg("accent", `"${truncate(objective, 50)}"`));
      return parts.join(" ");
    }),
    renderResult: buildStatsRenderResult({ partial: "Loading image..." }),
  });
}
