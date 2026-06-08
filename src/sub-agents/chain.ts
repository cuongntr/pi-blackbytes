/**
 * Sequential chain executor (REQ-005, Phase 2).
 *
 * Runs 1-5 existing sub-agents in sequence, passing each step's output to the
 * next under a clear "## Previous step output" heading. Reuses the existing
 * nested-Pi runner (`runNestedPi`) for each step rather than introducing a
 * new spawn path. Stops on the first failure by default; opt-in
 * `continueOnFailure` threads the failure content forward so subsequent steps
 * can adapt.
 *
 * Deliberately narrow in Phase 2:
 *   - No public `delegate_chain` tool (decision deferred to Phase 3 per Q-001).
 *   - No YAML chain DSL — chains are constructed in code.
 *   - No dynamic fanout, no async/background polling, no inter-agent chat.
 *   - No fallback-model orchestration: each step uses a single model.
 *
 * The chain validates step count, agent names, and timeout values
 * synchronously before any nested run starts. Unknown/disabled agents are
 * rejected up front so callers fail loudly rather than mid-chain.
 */

import { getEnabledSet } from "../config/enabled-set.js";
import { runNestedPi } from "./runner.js";
import type {
  ChainOptions,
  ChainResult,
  ChainStep,
  ChainStepResult,
  DelegateResult,
  RunNestedPiOptions,
} from "./types.js";

/**
 * Resolves the per-agent runtime config needed to build a `RunNestedPiOptions`
 * for a single step. The chain does not import snapshots or declarations
 * directly — callers (e.g. a future tool registration) plug in the resolution
 * strategy that fits the host session.
 */
export type ChainAgentResolver = (agent: string) => {
  systemPrompt: string;
  allowedTools: readonly string[];
  model?: string;
  reasoningEffort?: string;
};

/**
 * Injected runner function for testability. The default is `runNestedPi`,
 * matching the spec's "reuses runNestedPi" requirement.
 */
export type ChainRunner = (opts: RunNestedPiOptions) => Promise<DelegateResult>;

/** Options accepted by {@link executeChain}. */
export interface ExecuteChainOptions extends ChainOptions {
  /**
   * Resolves the per-agent runtime config (system prompt, tool allowlist,
   * model) used to build each step's `RunNestedPiOptions`. Required.
   */
  resolveAgentConfig: ChainAgentResolver;
  /**
   * Validates an agent name before execution. Defaults to the session-scoped
   * enabled set (`getEnabledSet().subAgents.has(name)`), matching the gate
   * used by `registerSubAgent`. Injected by tests to bypass session state.
   */
  isAgentEnabled?: (agent: string) => boolean;
  /** Runner override for tests. Default: `(opts) => runNestedPi(opts)`. */
  runner?: ChainRunner;
  /** Clock override for tests. Default: `Date.now`. */
  now?: () => number;
  /**
   * Minimum budget floor (ms) for a single step. Defends against degenerate
   * allocations when the remaining budget is too small to launch a nested
   * session meaningfully. Defaults to 1000ms (matches `executeWithFallback`).
   */
  minStepTimeoutMs?: number;
}

const DEFAULT_MIN_STEP_TIMEOUT_MS = 1000;
const MAX_CHAIN_STEPS = 5;

/**
 * Split a remaining total timeout evenly across the remaining steps.
 *
 * Returns the per-step slice as `Math.max(1, floor(remaining / remainingSteps))`
 * so every step gets at least 1ms and the cumulative allocation never exceeds
 * the supplied remaining budget. Pure function; safe to call in tests.
 */
export function allocateTimeoutBudget(remainingMs: number, remainingSteps: number): number {
  if (remainingSteps <= 0) return 0;
  if (remainingMs <= 0) return 0;
  return Math.max(1, Math.floor(remainingMs / remainingSteps));
}

function defaultIsAgentEnabled(agent: string): boolean {
  return getEnabledSet().subAgents.has(agent);
}

function isAbortErrorLike(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function composeStepUserPrompt(step: ChainStep, prior: ChainStepResult | undefined): string {
  const sections: string[] = [step.question];

  if (step.context !== undefined && step.context.length > 0) {
    sections.push(`## Context\n${step.context}`);
  }

  if (prior) {
    const statusText = prior.success
      ? `from ${prior.agent}`
      : `from ${prior.agent}, FAILED: ${prior.failureKind ?? "failed"}`;
    const body = prior.success
      ? prior.content
      : [prior.content, prior.details ? `Details:\n${prior.details}` : ""]
          .filter((line) => line.length > 0)
          .join("\n");
    sections.push(`## Previous step output (${statusText})\n${body}`);
  }

  return sections.join("\n\n");
}

function toStepResult(
  agent: string,
  result: DelegateResult,
  durationMs: number,
  timeoutMs: number,
): ChainStepResult {
  return {
    agent,
    success: result.success,
    content: result.content,
    details: result.details,
    durationMs,
    failureKind: result.failureKind,
    artifactPath: result.artifactPath,
    timeoutMs,
  };
}

function totalSuccess(steps: readonly ChainStepResult[]): boolean {
  return steps.length > 0 && steps.every((s) => s.success);
}

/**
 * Run a sequential chain of sub-agent steps. See the module docblock for the
 * full contract. Throws synchronously when input validation fails (zero
 * steps, more than 5 steps, unknown/disabled agents, non-positive
 * `totalTimeoutMs`, or non-positive per-step `step.timeoutMs`); never throws
 * once execution has begun — failures are surfaced through
 * `ChainResult.success` and per-step `failureKind`.
 */
export async function executeChain(options: ExecuteChainOptions): Promise<ChainResult> {
  const {
    steps,
    totalTimeoutMs,
    continueOnFailure = false,
    signal,
    cwd,
    resolveAgentConfig,
    isAgentEnabled = defaultIsAgentEnabled,
    runner = runNestedPi,
    now = Date.now,
    minStepTimeoutMs = DEFAULT_MIN_STEP_TIMEOUT_MS,
  } = options;

  if (steps.length === 0) {
    throw new Error("Chain must have at least 1 step (got 0)");
  }
  if (steps.length > MAX_CHAIN_STEPS) {
    throw new Error(`Chain must have at most ${MAX_CHAIN_STEPS} steps (got ${steps.length})`);
  }
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new Error(`Chain totalTimeoutMs must be a positive number (got ${totalTimeoutMs})`);
  }

  for (const step of steps) {
    if (typeof step.agent !== "string" || step.agent.length === 0) {
      throw new Error("Each chain step must have a non-empty agent name");
    }
    if (typeof step.question !== "string") {
      throw new Error(`Chain step for "${step.agent}" must have a question string`);
    }
    if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) {
      throw new Error(
        `Chain step for "${step.agent}" has a non-positive timeoutMs (${step.timeoutMs}); omit the field to use the auto-allocated budget`,
      );
    }
    if (!isAgentEnabled(step.agent)) {
      throw new Error(`Chain step references unknown or disabled agent "${step.agent}"`);
    }
  }

  const start = now();
  const deadline = start + totalTimeoutMs;
  const stepResults: ChainStepResult[] = [];
  let stoppedEarly = false;
  let stoppedAtStep: number | undefined;
  let prior: ChainStepResult | undefined;

  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) {
      // Caller cancelled before this step could launch. Surface as a
      // controlled cancelled step so callers always see a per-step record
      // of why the chain stopped (matches the budget-exhausted case below).
      const cancelledStep = steps[i]!;
      stepResults.push({
        agent: cancelledStep.agent,
        success: false,
        content: "Chain step skipped: aborted before launch",
        durationMs: 0,
        failureKind: "cancelled",
        timeoutMs: 0,
      });
      stoppedEarly = true;
      stoppedAtStep = i;
      break;
    }

    const step = steps[i]!;
    const remainingMs = Math.max(0, deadline - now());
    if (remainingMs < minStepTimeoutMs) {
      // Total budget exhausted before the next step could launch. Surface as
      // a controlled timed-out step so callers can see exactly where the
      // chain stopped without a raw throw.
      stepResults.push({
        agent: step.agent,
        success: false,
        content: "Chain step skipped: total timeout budget exhausted",
        durationMs: 0,
        failureKind: "timed_out",
        timeoutMs: 0,
      });
      stoppedEarly = true;
      stoppedAtStep = i;
      break;
    }

    const baseBudget = allocateTimeoutBudget(remainingMs, steps.length - i);
    const stepTimeoutMs =
      step.timeoutMs !== undefined ? Math.min(step.timeoutMs, remainingMs) : baseBudget;

    const config = resolveAgentConfig(step.agent);
    const userPrompt = composeStepUserPrompt(step, prior);

    const runOpts: RunNestedPiOptions = {
      systemPrompt: config.systemPrompt,
      userPrompt,
      allowedTools: [...config.allowedTools],
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      timeoutMs: stepTimeoutMs,
      cwd,
      signal,
    };

    const stepStart = now();
    let result: DelegateResult;
    try {
      result = await runner(runOpts);
    } catch (err) {
      if (isAbortErrorLike(err)) {
        // Surface the abort as a controlled failure rather than a throw so
        // the chain always returns a ChainResult on demand. We only treat a
        // thrown AbortError as a cancellation — a generic Error thrown
        // concurrently with an aborted signal would otherwise mask a real
        // runner failure (spawn_error, etc.).
        const message = err instanceof Error ? err.message : "Chain aborted";
        result = {
          success: false,
          content: message,
          failureKind: "cancelled",
        };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        result = {
          success: false,
          content: "Chain step runner threw",
          details: message,
          failureKind: "failed",
        };
      }
    }
    const stepDuration = now() - stepStart;

    const stepResult = toStepResult(step.agent, result, stepDuration, stepTimeoutMs);
    stepResults.push(stepResult);

    if (!result.success) {
      if (!continueOnFailure) {
        stoppedEarly = true;
        stoppedAtStep = i;
        break;
      }
    }

    prior = stepResult;
  }

  return {
    success: totalSuccess(stepResults),
    steps: stepResults,
    totalDurationMs: now() - start,
    stoppedEarly,
    stoppedAtStep,
  };
}
