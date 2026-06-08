import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  type ChainRunner,
  type ExecuteChainOptions,
  allocateTimeoutBudget,
  executeChain,
} from "../chain.js";
import { resetDelegationLog } from "../delegation-log.js";
import type { DelegateResult, RunNestedPiOptions } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface RecordedStep {
  agent: string;
  userPrompt: string;
  timeoutMs: number;
  allowedTools: readonly string[];
  systemPrompt: string;
}

function makeRunner(
  responses: ReadonlyArray<DelegateResult | Error>,
  recorder: RecordedStep[],
): ChainRunner {
  let idx = 0;
  return async (opts: RunNestedPiOptions): Promise<DelegateResult> => {
    recorder.push({
      agent: "agent-from-prompt", // overwritten per-test via resolveAgentConfig
      userPrompt: opts.userPrompt,
      timeoutMs: opts.timeoutMs ?? 0,
      allowedTools: opts.allowedTools,
      systemPrompt: opts.systemPrompt,
    });
    const response = responses[idx++];
    if (response === undefined) {
      throw new Error(`runner called ${idx} times but only ${responses.length} responses queued`);
    }
    if (response instanceof Error) throw response;
    return response;
  };
}

function makeResolver(
  agentConfig: Record<string, { systemPrompt: string; allowedTools?: readonly string[] }>,
) {
  return (agent: string) => {
    const cfg = agentConfig[agent];
    if (!cfg) throw new Error(`unexpected agent "${agent}" in test resolver`);
    return {
      systemPrompt: cfg.systemPrompt,
      allowedTools: cfg.allowedTools ?? ["read"],
    };
  };
}

function makeEnabledSet(names: readonly string[]): (agent: string) => boolean {
  const set = new Set(names);
  return (agent: string) => set.has(agent);
}

const ALL_AGENTS = ["explore", "oracle", "librarian", "general", "reviewer"] as const;
const DEFAULT_RESOLVER = makeResolver(
  Object.fromEntries(
    ALL_AGENTS.map((name) => [name, { systemPrompt: `system:${name}`, allowedTools: ["read"] }]),
  ),
);
const DEFAULT_IS_ENABLED = makeEnabledSet(ALL_AGENTS);

const successResult = (content: string): DelegateResult => ({ success: true, content });
const failureResult = (
  kind: DelegateResult["failureKind"],
  content = "step failed",
  details?: string,
): DelegateResult => ({
  success: false,
  content,
  details,
  failureKind: kind,
});

beforeEach(() => {
  resetDelegationLog();
});

afterEach(() => {
  resetDelegationLog();
});

// ---------------------------------------------------------------------------
// allocateTimeoutBudget
// ---------------------------------------------------------------------------

describe("allocateTimeoutBudget", () => {
  it("returns 0 for zero or negative remaining steps", () => {
    assert.equal(allocateTimeoutBudget(60_000, 0), 0);
    assert.equal(allocateTimeoutBudget(60_000, -1), 0);
  });

  it("returns 0 for zero or negative remaining ms", () => {
    assert.equal(allocateTimeoutBudget(0, 3), 0);
    assert.equal(allocateTimeoutBudget(-1, 3), 0);
  });

  it("splits the budget evenly across remaining steps", () => {
    assert.equal(allocateTimeoutBudget(60_000, 3), 20_000);
    assert.equal(allocateTimeoutBudget(60_000, 5), 12_000);
  });

  it("floors fractional ms to whole milliseconds", () => {
    assert.equal(allocateTimeoutBudget(10_000, 3), 3333);
  });

  it("always returns at least 1ms when both inputs are positive", () => {
    assert.equal(allocateTimeoutBudget(1, 5), 1);
    assert.equal(allocateTimeoutBudget(2, 1_000_000), 1);
  });
});

// ---------------------------------------------------------------------------
// executeChain — input validation
// ---------------------------------------------------------------------------

describe("executeChain validation", () => {
  const baseOptions: Pick<
    ExecuteChainOptions,
    "resolveAgentConfig" | "isAgentEnabled" | "runner" | "now"
  > = {
    resolveAgentConfig: DEFAULT_RESOLVER,
    isAgentEnabled: DEFAULT_IS_ENABLED,
    runner: makeRunner([], []),
    now: () => 0,
  };

  it("throws when the step list is empty", async () => {
    await assert.rejects(
      () =>
        executeChain({
          ...baseOptions,
          steps: [],
          totalTimeoutMs: 60_000,
        }),
      /at least 1 step/,
    );
  });

  it("throws when the chain has more than 5 steps", async () => {
    await assert.rejects(
      () =>
        executeChain({
          ...baseOptions,
          steps: [
            { agent: "explore", question: "q1" },
            { agent: "oracle", question: "q2" },
            { agent: "librarian", question: "q3" },
            { agent: "general", question: "q4" },
            { agent: "reviewer", question: "q5" },
            { agent: "explore", question: "q6" },
          ],
          totalTimeoutMs: 60_000,
        }),
      /at most 5 steps/,
    );
  });

  it("throws when totalTimeoutMs is not positive", async () => {
    await assert.rejects(
      () =>
        executeChain({
          ...baseOptions,
          steps: [{ agent: "explore", question: "q" }],
          totalTimeoutMs: 0,
        }),
      /totalTimeoutMs must be a positive number/,
    );
    await assert.rejects(
      () =>
        executeChain({
          ...baseOptions,
          steps: [{ agent: "explore", question: "q" }],
          totalTimeoutMs: -1,
        }),
      /totalTimeoutMs must be a positive number/,
    );
  });

  it("throws when a step references an unknown agent", async () => {
    await assert.rejects(
      () =>
        executeChain({
          ...baseOptions,
          isAgentEnabled: makeEnabledSet(["explore"]),
          steps: [{ agent: "nonexistent", question: "q" }],
          totalTimeoutMs: 60_000,
        }),
      /unknown or disabled agent "nonexistent"/,
    );
  });

  it("throws when a step references a disabled agent", async () => {
    await assert.rejects(
      () =>
        executeChain({
          ...baseOptions,
          isAgentEnabled: makeEnabledSet(["explore"]),
          steps: [
            { agent: "explore", question: "q1" },
            { agent: "oracle", question: "q2" },
          ],
          totalTimeoutMs: 60_000,
        }),
      /unknown or disabled agent "oracle"/,
    );
  });

  it("throws when a step has an empty agent name", async () => {
    await assert.rejects(
      () =>
        executeChain({
          ...baseOptions,
          steps: [{ agent: "", question: "q" }],
          totalTimeoutMs: 60_000,
        }),
      /non-empty agent name/,
    );
  });

  it("throws when a step has a non-positive timeoutMs", async () => {
    await assert.rejects(
      () =>
        executeChain({
          ...baseOptions,
          steps: [{ agent: "explore", question: "q", timeoutMs: 0 }],
          totalTimeoutMs: 60_000,
        }),
      /non-positive timeoutMs/,
    );
    await assert.rejects(
      () =>
        executeChain({
          ...baseOptions,
          steps: [{ agent: "explore", question: "q", timeoutMs: -1 }],
          totalTimeoutMs: 60_000,
        }),
      /non-positive timeoutMs/,
    );
  });
});

// ---------------------------------------------------------------------------
// executeChain — happy path
// ---------------------------------------------------------------------------

describe("executeChain sequential execution", () => {
  it("runs steps strictly sequentially in the given order", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [successResult("a-out"), successResult("b-out"), successResult("c-out")],
      calls,
    );

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [
        { agent: "explore", question: "first" },
        { agent: "oracle", question: "second" },
        { agent: "reviewer", question: "third" },
      ],
      totalTimeoutMs: 60_000,
    });

    assert.equal(calls.length, 3);
    assert.equal(result.steps.length, 3);
    assert.deepEqual(
      result.steps.map((s) => s.agent),
      ["explore", "oracle", "reviewer"],
    );
    assert.deepEqual(
      result.steps.map((s) => s.content),
      ["a-out", "b-out", "c-out"],
    );
    assert.equal(result.success, true);
    assert.equal(result.stoppedEarly, false);
    assert.equal(result.stoppedAtStep, undefined);
  });

  it("propagates the prior step output into the next step's user prompt", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [successResult("EXPLORE_RESULT"), successResult("ORACLE_RESULT")],
      calls,
    );

    await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [
        { agent: "explore", question: "first question" },
        { agent: "oracle", question: "second question" },
      ],
      totalTimeoutMs: 60_000,
    });

    assert.equal(calls.length, 2);
    // Step 1: no previous output
    assert.equal(calls[0]!.userPrompt, "first question");
    // Step 2: must include the prior content under a clear heading
    assert.ok(calls[1]!.userPrompt.startsWith("second question\n\n"));
    assert.ok(calls[1]!.userPrompt.includes("## Previous step output (from explore)"));
    assert.ok(calls[1]!.userPrompt.includes("EXPLORE_RESULT"));
  });

  it("includes the optional step.context under a Context heading", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner([successResult("ok")], calls);

    await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [{ agent: "explore", question: "q", context: "extra info" }],
      totalTimeoutMs: 60_000,
    });

    assert.ok(calls[0]!.userPrompt.includes("## Context"));
    assert.ok(calls[0]!.userPrompt.includes("extra info"));
  });

  it("forwards per-agent config (system prompt, tools) into the runner", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner([successResult("ok"), successResult("ok")], calls);
    const resolver = makeResolver({
      explore: { systemPrompt: "EXPLORE_SYS", allowedTools: ["read", "glob"] },
      oracle: { systemPrompt: "ORACLE_SYS", allowedTools: ["read", "web_search"] },
    });

    await executeChain({
      resolveAgentConfig: resolver,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [
        { agent: "explore", question: "q" },
        { agent: "oracle", question: "q" },
      ],
      totalTimeoutMs: 60_000,
    });

    assert.equal(calls[0]!.systemPrompt, "EXPLORE_SYS");
    assert.deepEqual(calls[0]!.allowedTools, ["read", "glob"]);
    assert.equal(calls[1]!.systemPrompt, "ORACLE_SYS");
    assert.deepEqual(calls[1]!.allowedTools, ["read", "web_search"]);
  });

  it("accepts a single-step chain (lower boundary)", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner([successResult("done")], calls);

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [{ agent: "explore", question: "q" }],
      totalTimeoutMs: 60_000,
    });

    assert.equal(calls.length, 1);
    assert.equal(result.steps.length, 1);
    assert.equal(result.success, true);
  });

  it("accepts a 5-step chain (upper boundary)", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [
        successResult("1"),
        successResult("2"),
        successResult("3"),
        successResult("4"),
        successResult("5"),
      ],
      calls,
    );

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
        { agent: "librarian", question: "q3" },
        { agent: "general", question: "q4" },
        { agent: "reviewer", question: "q5" },
      ],
      totalTimeoutMs: 60_000,
    });

    assert.equal(calls.length, 5);
    assert.equal(result.success, true);
  });
});

// ---------------------------------------------------------------------------
// executeChain — failure semantics
// ---------------------------------------------------------------------------

describe("executeChain failure semantics", () => {
  it("stops on the first failed step by default and reports stoppedAtStep", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [successResult("a-out"), failureResult("failed", "boom"), successResult("never-run")],
      calls,
    );

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
        { agent: "reviewer", question: "q3" },
      ],
      totalTimeoutMs: 60_000,
    });

    assert.equal(calls.length, 2, "third step should not have been launched");
    assert.equal(result.success, false);
    assert.equal(result.stoppedEarly, true);
    assert.equal(result.stoppedAtStep, 1);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0]!.success, true);
    assert.equal(result.steps[1]!.success, false);
    assert.equal(result.steps[1]!.failureKind, "failed");
    assert.equal(result.steps[1]!.content, "boom");
  });

  it("continues past failures when continueOnFailure is true and threads the error forward", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [
        successResult("a-out"),
        failureResult("timed_out", "TIMEOUT_ERR", "details here"),
        successResult("c-out"),
      ],
      calls,
    );

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      continueOnFailure: true,
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
        { agent: "reviewer", question: "q3" },
      ],
      totalTimeoutMs: 60_000,
    });

    assert.equal(calls.length, 3);
    assert.equal(result.success, false);
    assert.equal(result.stoppedEarly, false);
    assert.equal(result.steps.length, 3);
    // Step 3 must see the failure content under the previous-step heading.
    assert.ok(
      calls[2]!.userPrompt.includes("## Previous step output (from oracle, FAILED: timed_out)"),
    );
    assert.ok(calls[2]!.userPrompt.includes("TIMEOUT_ERR"));
    assert.ok(calls[2]!.userPrompt.includes("details here"));
  });

  it("captures the runner-thrown error as a failed step without aborting the chain (continueOnFailure)", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [successResult("a"), new Error("spawn failed"), successResult("c")],
      calls,
    );

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      continueOnFailure: true,
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
        { agent: "reviewer", question: "q3" },
      ],
      totalTimeoutMs: 60_000,
    });

    assert.equal(result.steps.length, 3);
    assert.equal(result.steps[1]!.success, false);
    assert.equal(result.steps[1]!.failureKind, "failed");
    assert.equal(result.steps[1]!.details, "spawn failed");
  });
});

// ---------------------------------------------------------------------------
// executeChain — timeout budgeting
// ---------------------------------------------------------------------------

describe("executeChain timeout budgeting", () => {
  it("divides the remaining budget across remaining steps when no per-step override is set", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner([successResult("a"), successResult("b"), successResult("c")], calls);

    // The chain must split the REMAINING budget (deadline - now) across the
    // REMAINING steps at each iteration, so unused time on early steps flows
    // forward. With a frozen clock, the slice grows as the number of remaining
    // steps shrinks.
    await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
        { agent: "reviewer", question: "q3" },
      ],
      totalTimeoutMs: 60_000,
    });

    // Step 1 of 3: 60_000 / 3 = 20_000ms
    assert.equal(calls[0]!.timeoutMs, 20_000);
    // Step 2 of 2 remaining: 60_000 / 2 = 30_000ms (clock frozen, so full
    // remaining budget is still available).
    assert.equal(calls[1]!.timeoutMs, 30_000);
    // Step 3 of 1 remaining: 60_000 / 1 = 60_000ms.
    assert.equal(calls[2]!.timeoutMs, 60_000);
  });

  it("honours step.timeoutMs when it is smaller than the remaining-budget slice", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner([successResult("a"), successResult("b")], calls);

    await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [
        { agent: "explore", question: "q1", timeoutMs: 5_000 },
        { agent: "oracle", question: "q2" },
      ],
      totalTimeoutMs: 60_000,
    });

    // First step honours the override (5_000 < 60_000/2 = 30_000).
    assert.equal(calls[0]!.timeoutMs, 5_000);
    // Second step gets the full remaining budget (clock frozen at 0).
    assert.equal(calls[1]!.timeoutMs, 60_000);
  });

  it("caps step.timeoutMs at the remaining budget", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner([successResult("a")], calls);

    // First step uses nearly all the budget; second step should get whatever remains.
    let consumed = 0;
    await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => {
        const v = consumed;
        consumed = 0;
        return v;
      },
      steps: [
        { agent: "explore", question: "q1", timeoutMs: 120_000 },
        { agent: "oracle", question: "q2" },
      ],
      totalTimeoutMs: 60_000,
    });

    // First step timeoutMs was capped from 120_000 to 60_000 (the full budget).
    assert.equal(calls[0]!.timeoutMs, 60_000);
  });

  it("records a controlled timed_out step when the budget is exhausted mid-chain", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner([successResult("a"), successResult("b")], calls);

    // The chain invokes `now()` a small fixed number of times per step
    // (start, per-iter remaining check, per-step start/end). We let the
    // first two steps run on a frozen clock (call index <= 7) and then
    // jump to 5_500ms when the third step's remaining-budget check fires,
    // leaving only 500ms against a 1_000ms minimum — the chain must stop
    // and synthesise a timed-out step rather than launching the runner.
    let clockCalls = 0;
    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => {
        clockCalls += 1;
        return clockCalls <= 7 ? 0 : 5_500;
      },
      minStepTimeoutMs: 1_000,
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
        { agent: "reviewer", question: "q3" },
      ],
      totalTimeoutMs: 6_000,
    });

    // Two steps were launched before the budget became too small.
    assert.equal(calls.length, 2);
    // Third step was synthesised as a controlled timed-out step.
    assert.equal(result.steps.length, 3);
    assert.equal(result.steps[2]!.agent, "reviewer");
    assert.equal(result.steps[2]!.success, false);
    assert.equal(result.steps[2]!.failureKind, "timed_out");
    assert.ok(result.steps[2]!.content.includes("total timeout budget exhausted"));
    assert.equal(result.stoppedEarly, true);
    assert.equal(result.stoppedAtStep, 2);
  });
});

// ---------------------------------------------------------------------------
// executeChain — abort signal
// ---------------------------------------------------------------------------

describe("executeChain abort handling", () => {
  it("stops before launching the next step when the signal is already aborted", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [successResult("a"), successResult("never-1"), successResult("never-2")],
      calls,
    );

    const controller = new AbortController();
    controller.abort();

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      signal: controller.signal,
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
        { agent: "reviewer", question: "q3" },
      ],
      totalTimeoutMs: 60_000,
    });

    // The first step sees the already-aborted signal at the top of its iteration
    // and stops before launching — the runner is never called.
    assert.equal(calls.length, 0);
    // A synthesised cancelled step is recorded so callers always have a
    // per-step record of why the chain stopped (mirrors the budget-exhausted
    // case where the un-runnable step is also recorded).
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]!.agent, "explore");
    assert.equal(result.steps[0]!.success, false);
    assert.equal(result.steps[0]!.failureKind, "cancelled");
    assert.equal(result.steps[0]!.content, "Chain step skipped: aborted before launch");
    assert.equal(result.success, false);
    assert.equal(result.stoppedEarly, true);
    assert.equal(result.stoppedAtStep, 0);
  });

  it("converts an AbortError thrown by the runner into a cancelled step result", async () => {
    const calls: RecordedStep[] = [];
    const abortError = new Error("aborted mid-run");
    abortError.name = "AbortError";
    const runner = makeRunner([abortError], calls);

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [{ agent: "explore", question: "q" }],
      totalTimeoutMs: 60_000,
    });

    assert.equal(calls.length, 1);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]!.success, false);
    assert.equal(result.steps[0]!.failureKind, "cancelled");
    assert.equal(result.steps[0]!.content, "aborted mid-run");
  });
});

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

describe("chain module exports", () => {
  it("exports allocateTimeoutBudget, executeChain, and the relevant types", async () => {
    const mod = await import("../chain.js");
    assert.equal(typeof mod.allocateTimeoutBudget, "function");
    assert.equal(typeof mod.executeChain, "function");
  });
});

// ---------------------------------------------------------------------------
// executeChain — integration-style scenarios
//
// These tests exercise the chain through the same surfaces a future public
// tool registration would: realistic DelegateResult shapes, mixed agent
// types, AbortController-driven cancellation, and middle-step failure
// propagation. They do NOT spawn a real `pi` process — the runner is mocked
// at the same boundary used by `register.ts`.
// ---------------------------------------------------------------------------

describe("executeChain integration scenarios", () => {
  it("propagates realistic DelegateResult shapes (success + failure + timeout) across 3 steps", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [
        { success: true, content: "explore-out", artifactPath: "/artifacts/explore.md" },
        failureResult("timed_out", "Nested Pi timed out", "stderr line"),
        { success: true, content: "reviewer-out" },
      ],
      calls,
    );

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      continueOnFailure: true,
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
        { agent: "reviewer", question: "q3" },
      ],
      totalTimeoutMs: 60_000,
    });

    // Per-step results mirror the underlying DelegateResult fields.
    assert.equal(result.steps[0]!.success, true);
    assert.equal(result.steps[0]!.content, "explore-out");
    assert.equal(result.steps[0]!.artifactPath, "/artifacts/explore.md");
    assert.equal(result.steps[0]!.failureKind, undefined);

    assert.equal(result.steps[1]!.success, false);
    assert.equal(result.steps[1]!.failureKind, "timed_out");
    assert.equal(result.steps[1]!.details, "stderr line");

    assert.equal(result.steps[2]!.success, true);
    assert.equal(result.steps[2]!.content, "reviewer-out");

    // Continue-on-failure semantics: all 3 steps ran, none were stopped early.
    assert.equal(result.success, false);
    assert.equal(result.stoppedEarly, false);
    assert.equal(result.steps.length, 3);
  });

  it("composes context across 3+ steps with realistic mixed agent types", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [
        successResult("EXPLORE_FINDINGS\nline1\nline2"),
        successResult("ORACLE_VERDICT: do X"),
        successResult("REVIEWER_OK\napproved"),
      ],
      calls,
    );

    // Read-only agents vs full-access general — the chain must respect the
    // allowlist supplied by the resolver for each.
    const resolver = makeResolver({
      explore: { systemPrompt: "EXPLORE_SYS", allowedTools: ["read", "glob"] },
      oracle: { systemPrompt: "ORACLE_SYS", allowedTools: ["read"] },
      general: { systemPrompt: "GENERAL_SYS", allowedTools: ["read", "bash", "edit"] },
      reviewer: { systemPrompt: "REVIEWER_SYS", allowedTools: ["read"] },
    });

    await executeChain({
      resolveAgentConfig: resolver,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      steps: [
        { agent: "explore", question: "find the bug" },
        { agent: "oracle", question: "analyse", context: "see prior findings" },
        { agent: "general", question: "fix it" },
        { agent: "reviewer", question: "verify" },
      ],
      totalTimeoutMs: 60_000,
    });

    // Step 1: no prior output
    assert.equal(calls[0]!.userPrompt, "find the bug");
    assert.deepEqual(calls[0]!.allowedTools, ["read", "glob"]);

    // Step 2: prior from explore + context heading
    assert.ok(calls[1]!.userPrompt.includes("## Context\nsee prior findings"));
    assert.ok(calls[1]!.userPrompt.includes("## Previous step output (from explore)"));
    assert.ok(calls[1]!.userPrompt.includes("EXPLORE_FINDINGS"));
    assert.deepEqual(calls[1]!.allowedTools, ["read"]);

    // Step 3: only the prior output (no `context` provided for this step)
    assert.ok(!calls[2]!.userPrompt.includes("## Context"));
    assert.ok(calls[2]!.userPrompt.includes("## Previous step output (from oracle)"));
    assert.ok(calls[2]!.userPrompt.includes("ORACLE_VERDICT: do X"));
    // The full-access agent gets its mutating tools through to the runner.
    assert.deepEqual(calls[2]!.allowedTools, ["read", "bash", "edit"]);

    // Step 4: only the prior output
    assert.ok(calls[3]!.userPrompt.includes("## Previous step output (from general)"));
    assert.ok(calls[3]!.userPrompt.includes("approved"));
  });

  it("cancels mid-chain via AbortController and reports cancelled for the in-flight step", async () => {
    const calls: RecordedStep[] = [];
    const controller = new AbortController();

    // Schedule an abort shortly after the chain starts.
    setTimeout(() => controller.abort(), 5).unref();

    // The first step's runner simulates a long-running task that the
    // controller will cut off.
    const slowRunner: ChainRunner = async (opts) => {
      calls.push({
        agent: "agent-from-prompt",
        userPrompt: opts.userPrompt,
        timeoutMs: opts.timeoutMs ?? 0,
        allowedTools: opts.allowedTools,
        systemPrompt: opts.systemPrompt,
      });
      await new Promise<void>((resolve, reject) => {
        if (opts.signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        opts.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
        // Stay pending until the abort handler fires.
      });
      return successResult("never reached");
    };

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner: slowRunner,
      now: () => 0,
      signal: controller.signal,
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
      ],
      totalTimeoutMs: 60_000,
    });

    // First step was cancelled; second step never launched.
    assert.equal(calls.length, 1);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]!.success, false);
    assert.equal(result.steps[0]!.failureKind, "cancelled");
  });

  it("threads a middle-step failure into the next step under a FAILED heading", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [
        successResult("STEP1_OK"),
        failureResult("failed", "STEP2_BOOM", "STDERR_FROM_ORACLE"),
        successResult("STEP3_OK"),
      ],
      calls,
    );

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      continueOnFailure: true,
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
        { agent: "reviewer", question: "q3" },
      ],
      totalTimeoutMs: 60_000,
    });

    // Middle step recorded as failed; chain kept going.
    assert.equal(result.steps[1]!.failureKind, "failed");
    assert.equal(result.steps[1]!.details, "STDERR_FROM_ORACLE");

    // Step 3 sees the FAILED annotation in the previous-output heading.
    assert.ok(
      calls[2]!.userPrompt.includes("## Previous step output (from oracle, FAILED: failed)"),
    );
    assert.ok(calls[2]!.userPrompt.includes("STEP2_BOOM"));
    assert.ok(calls[2]!.userPrompt.includes("STDERR_FROM_ORACLE"));
  });

  it("exposes a default-stop behaviour so a middle-step failure halts the chain", async () => {
    const calls: RecordedStep[] = [];
    const runner = makeRunner(
      [
        successResult("STEP1_OK"),
        failureResult("recursion_refused", "Nested Pi invocation refused: PI_NESTED_DEPTH >= 1"),
        successResult("STEP3_SHOULD_NOT_RUN"),
      ],
      calls,
    );

    const result = await executeChain({
      resolveAgentConfig: DEFAULT_RESOLVER,
      isAgentEnabled: DEFAULT_IS_ENABLED,
      runner,
      now: () => 0,
      // continueOnFailure is omitted on purpose: default is false.
      steps: [
        { agent: "explore", question: "q1" },
        { agent: "oracle", question: "q2" },
        { agent: "reviewer", question: "q3" },
      ],
      totalTimeoutMs: 60_000,
    });

    // Third step was never launched.
    assert.equal(calls.length, 2);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0]!.success, true);
    assert.equal(result.steps[1]!.success, false);
    assert.equal(result.steps[1]!.failureKind, "recursion_refused");
    assert.equal(result.success, false);
    assert.equal(result.stoppedEarly, true);
    assert.equal(result.stoppedAtStep, 1);
  });
});
