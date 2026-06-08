export type DelegateFailureKind =
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "recursion_refused"
  | "cli_usage_error"
  | "invalid_tool_allowlist"
  | "provider_or_model_unavailable"
  | "malformed_jsonl"
  | "killed";

export interface RunNestedPiOptions {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  reasoningEffort?: string;
  allowedTools: string[];
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number; // default 300000 (5min)
  captureArtifacts?: boolean;
  artifactAgent?: string;
  /**
   * Internal callback used by the host registration layer to build safe
   * live progress updates for the parent TUI.
   *
   * The runner spawns nested Pi with `--mode json`, parses each JSONL line
   * into a `PiSessionEvent`, and invokes this callback once per parsed
   * event. The registration layer is responsible for redacting secrets,
   * bounding retained output, and emitting a short collapsed summary with
   * richer `details` for expandable UI.
   *
   * Calling Pi's tool `onUpdate` does not append content to the final tool
   * result that the LLM sees; it is a UI-only streaming surface. Keeping the
   * callback internal preserves that boundary while still allowing users to
   * click/expand the running delegate tool call for diagnostics.
   */
  onUpdate?: (event: PiSessionEvent) => void;
  killGraceMs?: number;
}

export interface DelegateResult {
  success: boolean;
  content: string;
  details?: string;
  failureKind?: DelegateFailureKind;
  artifactPath?: string;
}

// ---------------------------------------------------------------------------
// Chain executor types (REQ-005). The chain runs 1-5 existing sub-agents in
// sequence, passing each step's output to the next under a clear heading.
// Internal-only in Phase 2: no public delegate_chain tool, no YAML DSL, no
// fanout, no async polling, no inter-agent chat.
// ---------------------------------------------------------------------------

/** A single sequential step in a chain. */
export interface ChainStep {
  /** Name of a registered, enabled sub-agent (e.g. "explore"). */
  agent: string;
  /** Primary task / question passed to the sub-agent as the user prompt body. */
  question: string;
  /** Optional additional context included under a "## Context" heading. */
  context?: string;
  /** Optional per-step timeout override (ms); capped by the chain's remaining budget. */
  timeoutMs?: number;
}

/** Logical chain configuration; transport-agnostic. */
export interface ChainOptions {
  /** Ordered steps to execute. 1-5 allowed; 0 and >5 are rejected up front. */
  steps: readonly ChainStep[];
  /** Hard total timeout in ms covering the entire chain execution. */
  totalTimeoutMs: number;
  /**
   * When true, the chain continues past a failed step (with its error content
   * threaded forward under the previous-step heading). Defaults to false
   * (stop on first failure).
   */
  continueOnFailure?: boolean;
  /** Optional abort signal that cancels the chain in-flight. */
  signal?: AbortSignal;
  /** Working directory passed to the nested runner for each step. */
  cwd?: string;
}

/** Per-step outcome recorded by the chain executor. */
export interface ChainStepResult {
  agent: string;
  success: boolean;
  /** Step output (success) or short error line (failure). */
  content: string;
  /** Optional long-form failure details (mirrors `DelegateResult.details`). */
  details?: string;
  /** Wall-clock duration of the step in ms. */
  durationMs: number;
  /** Failure classification when the step failed. */
  failureKind?: DelegateFailureKind;
  /** Artifact path when the underlying runner captured an artifact. */
  artifactPath?: string;
  /** Effective per-step timeout that was applied (ms). */
  timeoutMs: number;
}

/** Aggregate outcome of a chain execution. */
export interface ChainResult {
  /** True when every step succeeded. */
  success: boolean;
  /** Per-step results in execution order. */
  steps: ChainStepResult[];
  /** Wall-clock duration of the entire chain in ms. */
  totalDurationMs: number;
  /** True when the chain stopped before executing all steps. */
  stoppedEarly: boolean;
  /** Index of the step that caused the chain to stop (undefined when stoppedEarly is false). */
  stoppedAtStep?: number;
}

/**
 * One JSONL event emitted on stdout by `pi -p --mode json`. The shape is
 * intentionally permissive (string-keyed, unknown-valued) because we only
 * need to discriminate on `type` and read a few well-known nested fields.
 * Consumers narrow with runtime checks.
 *
 * Known event types observed in the v0.67 stream:
 *  - session, agent_start, turn_start, agent_end
 *  - message_start, message_end, turn_end
 *  - message_update (with nested assistantMessageEvent.type:
 *      text_start | text_delta | text_end |
 *      thinking_start | thinking_delta | thinking_end |
 *      toolcall_start | toolcall_delta | toolcall_end |
 *      done | error | start)
 *  - tool_execution_start | tool_execution_update | tool_execution_end
 *  - extension_ui_request (ignored)
 */
export type PiSessionEvent = { readonly type: string } & Readonly<Record<string, unknown>>;
