/**
 * Centralised system-prompt assembler for sub-agents.
 *
 * ## Design contract
 *
 * `buildSystemPrompt` is the single entry-point for constructing the string
 * that is passed to `runNestedPi()` via `--system-prompt`. It owns the
 * `promptMode` dispatch:
 *
 * - `'static'` (default) — returns the resolved base prompt unchanged.
 *   Byte-for-byte identical to the previous inline behaviour in `register.ts`.
 *
 * - `'append'` — **NOT YET IMPLEMENTED**. Deferred because Pi's
 *   `ExtensionAPI` execute callback receives only
 *   `(toolCallId, params, signal, onUpdate, ctx?)` — there is no stable,
 *   bounded API surface that exposes the parent session's static system prompt
 *   to an extension. `AgentSession.systemPrompt` exists on the class but is
 *   unreachable from the registered tool's execute closure without unsafe
 *   global state. Until Pi surfaces a supported `parentContext` field on the
 *   execute context, append mode throws immediately so callers fail loudly
 *   rather than silently degrading.
 *
 * ## Append mode — deferred implementation notes
 *
 * When a safe source is available it MUST:
 *   1. Be bounded (static session instruction, not raw transcript/tool outputs).
 *   2. Be redacted (strip secrets / API keys before embedding).
 *   3. Be size-capped (≤ 4 KB of inherited block).
 *   4. Include explicit boundary markers so the child model can distinguish
 *      parent context from its own instructions.
 *   5. Append the sub-agent's own prompt LAST so child constraints override.
 *
 * Track in: CHANGELOG.md Unreleased → "append mode deferred (pib-vyj.2.3)".
 */

import { classifyModel } from "../shared/model-capability.js";
import type { SubAgentDeclaration } from "./declaration.js";

// ---------------------------------------------------------------------------
// Prompt body resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the system prompt body for a sub-agent, selecting a family-specific
 * variant only when `modelId` is explicitly provided and a matching variant
 * exists on the declaration.
 *
 * @param decl The sub-agent declaration.
 * @param modelId The explicitly configured nested model ID (from snapshot).
 *   When undefined, the default `systemPrompt` is always used — the parent's
 *   cached model family is never consulted.
 * @returns The resolved prompt body string.
 */
export function resolveSystemPromptBody(
  decl: Pick<SubAgentDeclaration, "systemPrompt" | "systemPromptByFamily">,
  modelId?: string,
): string {
  if (!modelId || !decl.systemPromptByFamily) {
    return decl.systemPrompt;
  }
  const family = classifyModel(modelId);
  return decl.systemPromptByFamily[family] ?? decl.systemPrompt;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BuildSystemPromptOptions {
  /** The pre-resolved base system prompt from `declaration.systemPrompt`. */
  readonly basePrompt: string;
  /** The declaration driving the assembly. */
  readonly declaration: Pick<SubAgentDeclaration, "name" | "promptMode">;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the final system prompt string for a nested Pi invocation.
 *
 * @param opts.basePrompt  The resolved base prompt (verbatim from `declaration.systemPrompt`).
 * @param opts.declaration The sub-agent declaration (only `name` and
 *   `promptMode` are consumed here).
 * @returns The assembled system prompt string.
 * @throws {Error} If `promptMode === 'append'`, which is not yet supported.
 */
export function buildSystemPrompt(opts: BuildSystemPromptOptions): string {
  const mode = opts.declaration.promptMode ?? "static";

  if (mode === "static") {
    return opts.basePrompt;
  }

  // append — fail loud; see module-level JSDoc for rationale and road-map.
  throw new Error(
    `Sub-agent "${opts.declaration.name}" uses promptMode "append" which is not yet supported. No stable API exists to retrieve the parent session's system prompt from inside a registered tool execute callback. Set promptMode to "static" (the default) or omit the field until append mode is implemented in a future release (pib-vyj.2.3).`,
  );
}

// ---------------------------------------------------------------------------
// User-prompt helper
// ---------------------------------------------------------------------------

/**
 * Compose a sub-agent's user prompt from its primary argument plus optional
 * caller-supplied context, using the shared delimiter convention. Several
 * builtin declarations repeated this exact ternary; centralising it keeps the
 * formatting (delimiter, label spacing) consistent across agents.
 *
 * @param main The primary prompt text (question / task / request).
 * @param context Optional additional context block.
 * @param label Heading used to introduce the context block.
 *   Defaults to "Additional context".
 * @returns `main` alone when no context, otherwise main + delimited context.
 */
export function formatUserPrompt(
  main: string,
  context?: string,
  label = "Additional context",
): string {
  return context ? `${main}\n\n---\n\n${label}:\n${context}` : main;
}
