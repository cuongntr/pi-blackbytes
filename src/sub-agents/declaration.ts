import type { TObject } from "typebox";
import type { SubAgentMeta } from "../config/resource-metadata.js";
import type { ModelFamily } from "../shared/model-capability.js";
import type { AgentMutability, FinalizeMode } from "./delegable-tools.js";

/** Model and reasoning-effort overrides resolved at execution time. */
export interface ModelOverrides {
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  fallbackModels?: readonly string[];
}

/**
 * Static tool allowlist or a function that resolves it at execution time.
 * Dynamic resolvers are called per invocation so config changes are picked up.
 */
export type AllowedToolsResolver = readonly string[] | (() => readonly string[]);

/** Typed routing metadata for sub-agent delegation decisions. */
export interface SubAgentRoutingMetadata {
  readonly category: "exploration" | "reasoning" | "research" | "implementation" | "review";
  readonly cost: "low" | "medium" | "high";
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly keyTrigger?: string;
}

/**
 * Declaration contract shared by builtin and YAML-defined sub-agents.
 *
 * Builtins supply explicit `parameters` and `buildUserPrompt` hooks;
 * YAML-loaded agents may use a simpler `{ prompt: string }` shape,
 * but the registrar must never assume that.
 */
export interface SubAgentDeclaration<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Sub-agent identity, e.g. "explore", "oracle". */
  readonly name: string;

  /** Delegate tool name registered with the host, e.g. "delegate_explore". */
  readonly toolName: string;

  /** Human-readable description shown in tool metadata. */
  readonly description: string;

  /** TypeBox parameter schema for the delegate tool. */
  readonly parameters: TObject;

  /** System-prompt text passed to the nested Pi session. */
  readonly systemPrompt: string;

  /** Static tool allowlist or a function that resolves it at execution time. */
  readonly allowedTools: AllowedToolsResolver;

  /**
   * Builds the user-prompt string from validated call parameters.
   * Method syntax enables bivariant checking for heterogeneous declaration arrays.
   */
  buildUserPrompt(params: TParams): string;

  /**
   * Resolve model and reasoning-effort overrides at execution time
   * so config changes are picked up dynamically.
   * May return a plain object or a Promise for async config loading.
   */
  readonly resolveModelOverrides?: () => ModelOverrides | Promise<ModelOverrides>;

  /**
   * Per-agent mutability classification consumed by the nested-tool finalizer.
   * - `read-only`   (default) — only read/search/docs tools may reach `--tools`;
   *                  any mutating/exec tool in the resolved allowlist is stripped.
   * - `full-access` — both read-only and mutating/exec tools are permitted.
   */
  readonly mutability?: AgentMutability;

  /**
   * Declaration-time defaults for model / reasoning effort. Forms the lowest
   * precedence layer in the per-agent config resolver:
   *   declaration defaults < YAML declaration fields < JSON `sub_agents.<name>` overrides.
   * Builtin agents may set this to express baseline behavior (e.g. Oracle's
   * `reasoningEffort: 'high'`). YAML loader populates this from the YAML file.
   */
  readonly staticOverrides?: ModelOverrides;

  /**
   * Origin of the declaration. `"builtin"` for code-defined agents, `"yaml"`
   * for declarations loaded from `$PI_AGENT_DIR/sub-agents/*.yaml`. Used by
   * the snapshot + `/blackbytes-status` so users can see where each agent
   * comes from. Defaults to `"builtin"` when omitted.
   */
  readonly source?: "builtin" | "yaml";

  /** Absolute path to the YAML file when `source === "yaml"`. */
  readonly sourcePath?: string;

  /**
   * Validation strictness applied by the nested-tool finalizer.
   * - `strict`  (default for builtins) — throws on unknown / `delegate_*` names.
   * - `lenient` (used for YAML-defined agents) — silently drops them.
   */
  readonly finalizeMode?: FinalizeMode;

  /**
   * How the system prompt is assembled when passed to the nested Pi process.
   * - `'static'` (default) — uses `systemPrompt` verbatim.
   * - `'append'` — reserved for future use; append parent-session context before
   *   the sub-agent's own prompt. **Not yet supported.** Passing this value
   *   causes `buildSystemPrompt()` to throw at execution time so the caller
   *   fails loudly rather than silently falling back.
   */
  readonly promptMode?: "static" | "append";

  /**
   * Declaration-level default for Pi's tool execution mode.
   * - `'sequential'` — serialize with other tool calls in the same batch.
   * - `'parallel'` — allow concurrent execution (Pi default).
   * When `undefined`, Pi's default behavior applies (parallel).
   * YAML agents may set this from the `execution_mode` field.
   * JSON `sub_agents.<name>.executionMode` overrides this at runtime.
   */
  readonly executionMode?: "sequential" | "parallel";

  /**
   * Optional builder invoked AFTER tool finalization. Returned text is
   * prepended to the resolved system prompt before `runNestedPi()` is called.
   * Use for bounded safety/context overlays (e.g. the General agent overlay).
   * Errors thrown here are logged and the agent falls back to its base prompt.
   */
  readonly prependSystemPrompt?: (ctx: {
    readonly cwd?: string;
    readonly finalizedTools: readonly string[];
  }) => string | Promise<string>;

  /**
   * Per-model-family system prompt overrides. When the configured nested
   * model classifies as a known family, the corresponding prompt body
   * is used instead of the default `systemPrompt`.
   */
  readonly systemPromptByFamily?: Partial<Record<ModelFamily, string>>;

  /**
   * Typed routing metadata consumed by overlay and status renderers.
   * Builtins populate this directly; YAML agents may set it via the
   * optional `routing` YAML field.
   */
  readonly routing?: SubAgentRoutingMetadata;
}

/**
 * Creates an immutable sub-agent declaration with full type inference
 * over the parameters shape.
 */
export function defineSubAgent<TParams extends Record<string, unknown>>(
  declaration: SubAgentDeclaration<TParams>,
): SubAgentDeclaration<TParams> {
  return Object.freeze(declaration);
}

/** Derives a {@link SubAgentMeta} from a declaration for runtime registration. */
export function declarationToMeta(decl: SubAgentDeclaration): SubAgentMeta {
  return {
    name: decl.name,
    description: decl.description,
    promptFeatures: ["subagentDelegation"],
    routing: decl.routing,
  };
}
