/**
 * Per-agent runtime snapshot built once at session start.
 *
 * This module centralizes per-agent config resolution and freezes the result
 * for the lifetime of the host session. Disk changes to `settings.json` or
 * YAML files made AFTER `handleSessionStart()` returns are intentionally
 * ignored until the next session — both delegate execution and
 * `/blackbytes-status` consume this immutable snapshot.
 *
 * Precedence (lowest -> highest):
 *   1. Declaration `staticOverrides` (declaration-time defaults)
 *   2. (For YAML decls) the YAML file's own `model` / `reasoning_effort` fields,
 *      already folded into `staticOverrides` by the loader.
 *   3. JSON `blackbytes.sub_agents.<name>` from `settings.json`.
 *
 * The reserved `temperature` field is preserved on the snapshot so the status
 * command can surface it, but it is never threaded into nested-Pi execution
 * (the runner does not emit `--temperature`; Pi CLI does not accept it).
 *
 * Unknown per-agent fields preserved by `.passthrough()` on the schema flow
 * through into `extra` so future runtime-supported fields can be promoted
 * without losing user config.
 */

import type { BlackbytesConfig } from "../config/schema.js";
import type { ModelOverrides, SubAgentDeclaration } from "./declaration.js";
import {
  EXTENSION_TOOL_NAMES,
  MUTATING_EXEC_TOOLS,
  PI_BUILTIN_TOOLS,
  READ_SEARCH_DOCS_TOOLS,
  finalizeNestedTools,
} from "./delegable-tools.js";

const KNOWN_AGENT_FIELDS = new Set([
  "model",
  "reasoningEffort",
  "timeoutMs",
  "temperature",
  "fallbackModels",
  "promptMode",
  "executionMode",
  "artifactCapture",
]);

/** Pi CLI accepted thinking levels (packages/coding-agent/src/cli/args.ts). */
const PI_VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Coerce invalid legacy reasoning-effort values to undefined. */
function normalizeReasoningEffort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return PI_VALID_THINKING_LEVELS.has(value) ? value : undefined;
}

/** Summarized allowed-tools for display in /blackbytes-status. */
export type AllowedToolsSummary =
  | { mode: "exact"; tools: readonly string[] }
  | {
      mode: "summary";
      total: number;
      categories: { read: number; mutate: number; pi_builtin: number; extension: number };
    };

function computeAllowedToolsSummary(tools: readonly string[]): AllowedToolsSummary {
  if (tools.length <= 8) {
    return { mode: "exact", tools };
  }
  let read = 0;
  let mutate = 0;
  let pi_builtin = 0;
  let extension = 0;
  for (const t of tools) {
    if (MUTATING_EXEC_TOOLS.has(t)) {
      mutate++;
    } else if (READ_SEARCH_DOCS_TOOLS.has(t)) {
      read++;
    } else if (PI_BUILTIN_TOOLS.has(t)) {
      pi_builtin++;
    } else if (EXTENSION_TOOL_NAMES.has(t)) {
      extension++;
    }
  }
  return {
    mode: "summary",
    total: tools.length,
    categories: { read, mutate, pi_builtin, extension },
  };
}

export interface AgentSnapshot {
  /** Sub-agent name (e.g. "oracle", "general"). */
  readonly name: string;
  /** Origin of the declaration: builtin code or YAML file. */
  readonly source: "builtin" | "yaml";
  /** Absolute path of the YAML file when `source === "yaml"`. */
  readonly sourcePath?: string;
  /** Resolved model id (after precedence). `undefined` falls back to host model. */
  readonly model?: string;
  /** Resolved reasoning effort (after precedence). */
  readonly reasoningEffort?: string;
  /** Resolved timeout in milliseconds passed to runNestedPi (after precedence). */
  readonly timeoutMs?: number;
  /**
   * Resolved prompt mode (after precedence). `'static'` (default) uses the
   * declaration prompt verbatim. `'append'` is reserved/not-yet-supported and
   * causes `buildSystemPrompt()` to throw at execution time so callers fail loudly.
   */
  readonly promptMode?: "static" | "append";
  /**
   * Fallback model chain. When non-empty, `executeWithFallback` will retry
   * `provider_or_model_unavailable` failures with each model in order.
   * Only honoured when `fallbackEligible` is true.
   */
  readonly fallbackModels?: readonly string[];
  /**
   * Per-agent tool execution mode override.
   * - `"sequential"` — serialize with other tool calls in the same batch.
   * - `"parallel"` — allow concurrent execution (Pi default).
   * When `undefined`, Pi's default behavior applies (parallel).
   */
  readonly executionMode?: "sequential" | "parallel";
  /** Whether this agent should capture large delegate outputs as local artifacts. */
  readonly artifactCapture: boolean;
  /**
   * Whether this agent is eligible for model fallback.
   * True when mutability is `read-only` AND no MUTATING_EXEC_TOOLS appear in
   * the resolved tool allowlist. Computed once at snapshot time.
   */
  readonly fallbackEligible: boolean;
  /**
   * Reserved/unsupported fields preserved from config. Currently only
   * `temperature` is recognized but the shape is future-proofed.
   */
  readonly reserved: Readonly<Record<string, unknown>>;
  /** Other unknown per-agent fields preserved by schema passthrough. */
  readonly extra: Readonly<Record<string, unknown>>;
  /** Summarized allowed-tools resolved at snapshot time. */
  readonly allowedToolsSummary: AllowedToolsSummary;
  /**
   * Tools dropped during finalization at snapshot time.
   * Populated from the lenient finalization pass in `resolveAgentSnapshot()`.
   */
  readonly droppedTools?: {
    readonly globalDisabled: readonly string[];
    readonly mutability: readonly string[];
    readonly unknown: readonly string[];
  };
}

const MAX_TIMEOUT_MS = 3_600_000;

function isValidTimeoutMs(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v > 0 &&
    v <= MAX_TIMEOUT_MS
  );
}

/**
 * Resolve a single agent snapshot deterministically from declaration defaults
 * + YAML/JSON config. Pure function — no IO, no logging.
 */
export function resolveAgentSnapshot(
  declaration: SubAgentDeclaration,
  config: BlackbytesConfig,
  globalDisabled?: ReadonlySet<string>,
): AgentSnapshot {
  const declDefaults: ModelOverrides = declaration.staticOverrides ?? {};
  const jsonForAgent = config.sub_agents?.[declaration.name];

  const reserved: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  let jsonModel: string | undefined;
  let rawJsonReasoning: string | undefined;
  let jsonTimeoutMs: number | undefined;
  let jsonFallbackModels: readonly string[] | undefined;
  let jsonPromptMode: "static" | "append" | undefined;
  let jsonExecutionMode: "sequential" | "parallel" | undefined;
  let jsonArtifactCapture = false;

  if (jsonForAgent && typeof jsonForAgent === "object") {
    const obj = jsonForAgent as Record<string, unknown>;
    if (typeof obj.model === "string") jsonModel = obj.model;
    if (typeof obj.reasoningEffort === "string") rawJsonReasoning = obj.reasoningEffort;
    if (isValidTimeoutMs(obj.timeoutMs)) jsonTimeoutMs = obj.timeoutMs;
    if (obj.temperature !== undefined) reserved.temperature = obj.temperature;
    if (obj.promptMode === "static" || obj.promptMode === "append") {
      jsonPromptMode = obj.promptMode;
    }
    if (obj.executionMode === "sequential" || obj.executionMode === "parallel") {
      jsonExecutionMode = obj.executionMode;
    }
    if (typeof obj.artifactCapture === "boolean") jsonArtifactCapture = obj.artifactCapture;
    if (
      Array.isArray(obj.fallbackModels) &&
      obj.fallbackModels.every((s: unknown) => typeof s === "string" && s.length > 0)
    ) {
      jsonFallbackModels = obj.fallbackModels as string[];
    }
    for (const [k, v] of Object.entries(obj)) {
      if (!KNOWN_AGENT_FIELDS.has(k)) extra[k] = v;
    }
  }

  const jsonReasoning = normalizeReasoningEffort(rawJsonReasoning);
  const defaultReasoning = normalizeReasoningEffort(declDefaults.reasoningEffort);

  // Run tools through the finalization pipeline to get accurate summary and eligibility.
  const rawTools =
    typeof declaration.allowedTools === "function"
      ? [...declaration.allowedTools()]
      : [...declaration.allowedTools];
  const mutability = declaration.mutability ?? "read-only";
  const finalized = finalizeNestedTools({
    tools: rawTools,
    globalDisabled: globalDisabled ?? new Set(),
    mutability,
    mode: "lenient",
    context: `snapshot ${declaration.name}`,
  });

  // Compute fallback eligibility from finalized (not raw) tools.
  const hasMutatingTool = finalized.tools.some((t) => MUTATING_EXEC_TOOLS.has(t));
  const fallbackEligible = mutability !== "full-access" && !hasMutatingTool;

  return Object.freeze({
    name: declaration.name,
    source: declaration.source ?? "builtin",
    sourcePath: declaration.sourcePath,
    model: jsonModel ?? declDefaults.model,
    reasoningEffort: jsonReasoning ?? defaultReasoning,
    timeoutMs: jsonTimeoutMs ?? declDefaults.timeoutMs,
    promptMode: jsonPromptMode ?? declaration.promptMode,
    executionMode: jsonExecutionMode ?? declaration.executionMode,
    artifactCapture: jsonArtifactCapture,
    fallbackModels: jsonFallbackModels ?? declDefaults.fallbackModels,
    fallbackEligible,
    reserved: Object.freeze(reserved),
    extra: Object.freeze(extra),
    allowedToolsSummary: computeAllowedToolsSummary(finalized.tools),
    droppedTools: Object.freeze({
      globalDisabled: finalized.droppedGlobalDisabled,
      mutability: finalized.droppedMutability,
      unknown: finalized.droppedUnknown,
    }),
  });
}

// ---------------------------------------------------------------------------
// Session-scoped registry
// ---------------------------------------------------------------------------

let sessionSnapshot: ReadonlyMap<string, AgentSnapshot> | undefined;

/**
 * Build and freeze the per-agent snapshot for the current session.
 * Call once from `handleSessionStart()` after declarations + config are loaded.
 */
export function initAgentSnapshot(
  declarations: readonly SubAgentDeclaration[],
  config: BlackbytesConfig,
  globalDisabled?: ReadonlySet<string>,
): ReadonlyMap<string, AgentSnapshot> {
  const map = new Map<string, AgentSnapshot>();
  for (const decl of declarations) {
    map.set(decl.name, resolveAgentSnapshot(decl, config, globalDisabled));
  }
  sessionSnapshot = map;
  return map;
}

/** Returns the active session snapshot or `undefined` if not yet initialized. */
export function getAgentSnapshot(): ReadonlyMap<string, AgentSnapshot> | undefined {
  return sessionSnapshot;
}

/** Convenience: lookup a single agent snapshot. */
export function getAgentSnapshotFor(name: string): AgentSnapshot | undefined {
  return sessionSnapshot?.get(name);
}

/** Test-only reset hook. */
export function _resetAgentSnapshot(): void {
  sessionSnapshot = undefined;
}
