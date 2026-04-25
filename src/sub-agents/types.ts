export type DelegateFailureKind =
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "recursion_refused"
  | "cli_usage_error"
  | "invalid_tool_allowlist"
  | "provider_or_model_unavailable";

export interface RunNestedPiOptions {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  reasoningEffort?: string;
  allowedTools: string[];
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number; // default 300000 (5min)
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
