import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Type } from "typebox";

import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import { type BlackbytesConfig, parseBlackbytesConfig } from "../../config/schema.js";
import { defineSubAgent } from "../declaration.js";
import { exploreDeclaration } from "../explore.js";
import type { AttemptSummary, FallbackResult } from "../fallback.js";
import { executeWithFallback, formatAttempts } from "../fallback.js";
import { generalDeclaration } from "../general.js";
import { librarianDeclaration } from "../librarian.js";
import { oracleDeclaration } from "../oracle.js";
import { resolveAgentSnapshot } from "../snapshot.js";
import type { DelegateFailureKind, DelegateResult } from "../types.js";
// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDecl(overrides: {
  mutability?: "read-only" | "full-access";
  allowedTools?: string[];
  fallbackModels?: string[];
}) {
  return defineSubAgent<{ q: string }>({
    name: "test-agent",
    toolName: "delegate_test-agent",
    description: "test",
    parameters: Type.Object({ q: Type.String() }),
    systemPrompt: "x",
    allowedTools: overrides.allowedTools ?? ["read"],
    mutability: overrides.mutability,
    source: "builtin",
    staticOverrides: overrides.fallbackModels
      ? { fallbackModels: overrides.fallbackModels }
      : undefined,
    buildUserPrompt: (p) => p.q,
  });
}

const BASE_CONFIG: BlackbytesConfig = {
  disabled_tools: [],
  disabled_sub_agents: [],
  hashline_edit: true,
  copilot_initiator_header: true,
};

function makeSnapshot(opts: {
  mutability?: "read-only" | "full-access";
  allowedTools?: string[];
  fallbackModels?: string[];
  jsonFallbackModels?: string[];
}) {
  const decl = makeDecl({
    mutability: opts.mutability,
    allowedTools: opts.allowedTools,
    fallbackModels: opts.fallbackModels,
  });
  const config: BlackbytesConfig = opts.jsonFallbackModels
    ? {
        ...BASE_CONFIG,
        sub_agents: {
          "test-agent": { fallbackModels: opts.jsonFallbackModels } as unknown as Record<
            string,
            never
          >,
        },
      }
    : BASE_CONFIG;
  return resolveAgentSnapshot(decl, config);
}

function makeRunner(
  responses: Array<DelegateResult>,
  durations?: Array<number>,
): {
  runner: (opts: { timeoutMs?: number; model?: string }) => Promise<DelegateResult>;
  calls: Array<{ model?: string; timeoutMs?: number }>;
} {
  const calls: Array<{ model?: string; timeoutMs?: number }> = [];
  let index = 0;
  return {
    calls,
    runner: async (opts) => {
      calls.push({ model: opts.model, timeoutMs: opts.timeoutMs });
      const resp = responses[index++];
      if (!resp) throw new Error(`Unexpected runner call #${index}`);
      return resp;
    },
  };
}

type RunOpts = Parameters<typeof executeWithFallback>[0]["runOpts"];
const BASE_RUN_OPTS: RunOpts = {
  systemPrompt: "sys",
  userPrompt: "user",
  allowedTools: ["read"],
  timeoutMs: 10_000,
};

// ---------------------------------------------------------------------------
// formatAttempts helper
// ---------------------------------------------------------------------------

describe("formatAttempts", () => {
  it("formats a single successful attempt", () => {
    const attempts: AttemptSummary[] = [
      { model: "gpt-4o", status: "success", retriable: false, durationMs: 1500 },
    ];
    const out = formatAttempts(attempts);
    assert.equal(out, "gpt-4o (success, 1.5s)");
  });

  it("formats undefined model as (host model)", () => {
    const attempts: AttemptSummary[] = [
      { model: undefined, status: "success", retriable: false, durationMs: 2000 },
    ];
    assert.equal(formatAttempts(attempts), "(host model) (success, 2.0s)");
  });

  it("formats multiple attempts separated by semicolon", () => {
    const attempts: AttemptSummary[] = [
      {
        model: "gpt-4o",
        status: "provider_or_model_unavailable",
        retriable: true,
        durationMs: 100,
      },
      { model: "claude-opus-4", status: "success", retriable: false, durationMs: 4300 },
    ];
    const out = formatAttempts(attempts);
    assert.ok(out.includes("gpt-4o (provider_or_model_unavailable"));
    assert.ok(out.includes("claude-opus-4 (success"));
    assert.ok(out.includes(";"));
  });
});

// ---------------------------------------------------------------------------
// executeWithFallback — core behaviour
// ---------------------------------------------------------------------------

describe("executeWithFallback", () => {
  it("first-model success — no fallback attempted", async () => {
    const snapshot = makeSnapshot({ fallbackModels: ["fallback-model"] });
    const { runner, calls } = makeRunner([{ success: true, content: "ok" }]);

    const result = await executeWithFallback({
      snapshot,
      runOpts: BASE_RUN_OPTS,
      runner: runner as Parameters<typeof executeWithFallback>[0]["runner"],
    });

    assert.equal(result.success, true);
    assert.equal(result.content, "ok");
    assert.equal(calls.length, 1);
    assert.equal(result.attemptedModels.length, 1);
    assert.equal(result.attemptedModels[0]!.status, "success");
    assert.equal(result.attemptedModels[0]!.retriable, false);
  });

  it("primary fails with provider_or_model_unavailable, fallback succeeds", async () => {
    const snapshot = makeSnapshot({ fallbackModels: ["fallback-model"] });
    const { runner, calls } = makeRunner([
      {
        success: false,
        content: "Nested Pi failed",
        failureKind: "provider_or_model_unavailable" as DelegateFailureKind,
      },
      { success: true, content: "fallback result" },
    ]);

    const result = await executeWithFallback({
      snapshot,
      runOpts: { ...BASE_RUN_OPTS, model: "primary-model" },
      runner: runner as Parameters<typeof executeWithFallback>[0]["runner"],
    });

    assert.equal(result.success, true);
    assert.equal(result.content, "fallback result");
    assert.equal(calls.length, 2);
    assert.equal(result.attemptedModels.length, 2);
    assert.equal(result.attemptedModels[0]!.status, "provider_or_model_unavailable");
    assert.equal(result.attemptedModels[0]!.retriable, true);
    assert.equal(result.attemptedModels[1]!.model, "fallback-model");
    assert.equal(result.attemptedModels[1]!.status, "success");
  });

  it("all models fail — returns failure with attempt summary in details", async () => {
    const snapshot = makeSnapshot({ fallbackModels: ["fallback-1", "fallback-2"] });
    const { runner, calls } = makeRunner([
      {
        success: false,
        content: "Nested Pi failed",
        failureKind: "provider_or_model_unavailable" as DelegateFailureKind,
      },
      {
        success: false,
        content: "Nested Pi failed",
        failureKind: "provider_or_model_unavailable" as DelegateFailureKind,
      },
      {
        success: false,
        content: "Nested Pi failed",
        failureKind: "provider_or_model_unavailable" as DelegateFailureKind,
      },
    ]);

    const result = await executeWithFallback({
      snapshot,
      runOpts: BASE_RUN_OPTS,
      runner: runner as Parameters<typeof executeWithFallback>[0]["runner"],
    });

    assert.equal(result.success, false);
    assert.equal(calls.length, 3);
    assert.equal(result.attemptedModels.length, 3);
    assert.ok(result.details?.includes("Attempted models:"));
    assert.ok(result.details?.includes("fallback-1"));
    assert.ok(result.details?.includes("fallback-2"));
  });

  it("no model override and no fallbacks — single call with model=undefined", async () => {
    // snapshot.model is undefined; no fallbackModels
    const snapshot = makeSnapshot({});
    const { runner, calls } = makeRunner([{ success: true, content: "ok" }]);

    const result = await executeWithFallback({
      snapshot,
      runOpts: BASE_RUN_OPTS,
      runner: runner as Parameters<typeof executeWithFallback>[0]["runner"],
    });

    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.model, undefined);
    assert.equal(result.attemptedModels.length, 1);
  });

  // -------------------------------------------------------------------------
  // Non-retriable failure kinds — no retry
  // -------------------------------------------------------------------------

  const nonRetriableKinds: DelegateFailureKind[] = [
    "timed_out",
    "cancelled",
    "recursion_refused",
    "cli_usage_error",
    "invalid_tool_allowlist",
    "spawn_error",
    "failed",
  ];

  for (const kind of nonRetriableKinds) {
    it(`no retry on failure kind: ${kind}`, async () => {
      const snapshot = makeSnapshot({ fallbackModels: ["fallback-model"] });
      const { runner, calls } = makeRunner([
        { success: false, content: "Nested Pi failed", failureKind: kind },
      ]);

      const result = await executeWithFallback({
        snapshot,
        runOpts: BASE_RUN_OPTS,
        runner: runner as Parameters<typeof executeWithFallback>[0]["runner"],
      });

      assert.equal(result.success, false);
      assert.equal(calls.length, 1, `Expected single call for ${kind}`);
      assert.equal(result.attemptedModels.length, 1);
      assert.equal(result.attemptedModels[0]!.retriable, false);
    });
  }

  // -------------------------------------------------------------------------
  // Eligibility: full-access agent ignores fallback
  // -------------------------------------------------------------------------

  it("fallback configured but agent full-access — single primary attempt only", async () => {
    const snapshot = makeSnapshot({
      mutability: "full-access",
      allowedTools: ["bash", "edit", "write"],
      fallbackModels: ["should-not-use"],
    });
    assert.equal(snapshot.fallbackEligible, false);

    const { runner, calls } = makeRunner([
      {
        success: false,
        content: "Nested Pi failed",
        failureKind: "provider_or_model_unavailable" as DelegateFailureKind,
      },
    ]);

    const result = await executeWithFallback({
      snapshot,
      runOpts: BASE_RUN_OPTS,
      runner: runner as Parameters<typeof executeWithFallback>[0]["runner"],
    });

    assert.equal(calls.length, 1, "Must not retry ineligible agent");
    assert.equal(result.success, false);
  });

  it("YAML agent with bash in allowed_tools — fallback ineligible", async () => {
    // A YAML-style agent with bash in allowedTools but read-only mutability
    // is ineligible because bash is a MUTATING_EXEC_TOOL.
    const decl = defineSubAgent<{ q: string }>({
      name: "yaml-with-bash",
      toolName: "delegate_yaml-with-bash",
      description: "test",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["bash", "read"],
      mutability: "read-only",
      source: "yaml",
      staticOverrides: { fallbackModels: ["fallback"] },
      buildUserPrompt: (p) => p.q,
    });
    const snapshot = resolveAgentSnapshot(decl, BASE_CONFIG);
    assert.equal(snapshot.fallbackEligible, false);
  });

  // -------------------------------------------------------------------------
  // Total-chain timeout budget
  // -------------------------------------------------------------------------

  it("budget exhausted after primary — fallback not attempted", async () => {
    const snapshot = makeSnapshot({ fallbackModels: ["fallback-model"] });
    const budgetMs = 5000;
    let fakeNow = 0;

    // Primary attempt takes 4200ms (leaves only 800ms < MIN_REMAINING_MS=1000)
    const { runner, calls } = makeRunner([
      {
        success: false,
        content: "Nested Pi failed",
        failureKind: "provider_or_model_unavailable" as DelegateFailureKind,
      },
    ]);

    const nowFn = () => fakeNow;
    const wrappedRunner: Parameters<typeof executeWithFallback>[0]["runner"] = async (opts) => {
      // Simulate the primary taking 4200ms
      fakeNow += 4200;
      return runner(opts);
    };

    const result = await executeWithFallback({
      snapshot,
      runOpts: { ...BASE_RUN_OPTS, timeoutMs: budgetMs },
      runner: wrappedRunner,
      now: nowFn,
    });

    // Budget end = 0+5000 = 5000. After primary: fakeNow=4200. remaining=5000-4200=800 < 1000.
    assert.equal(calls.length, 1, "Fallback should be skipped due to budget exhaustion");
    assert.equal(result.success, false);
  });

  it("budget exhausted BEFORE first attempt — returns controlled timed_out failure", async () => {
    // Regression for a critical bug: when timeoutMs <= MIN_REMAINING_MS the
    // loop would skip every attempt and dereference an undefined lastResult,
    // throwing out of executeWithFallback.
    const snapshot = makeSnapshot({ fallbackModels: ["fallback-model"] });
    const { runner, calls } = makeRunner([]);

    const result = await executeWithFallback({
      snapshot,
      // 1000ms is exactly MIN_REMAINING_MS so the loop short-circuits before
      // any attempt is made.
      runOpts: { ...BASE_RUN_OPTS, timeoutMs: 1000 },
      runner: runner as Parameters<typeof executeWithFallback>[0]["runner"],
      now: () => 0,
    });

    assert.equal(calls.length, 0, "runner must not be invoked when budget is pre-exhausted");
    assert.equal(result.success, false);
    assert.equal(result.failureKind, "timed_out");
    assert.equal(result.attemptedModels.length, 0);
    assert.match(result.details ?? "", /Insufficient fallback budget/);
  });

  // -------------------------------------------------------------------------
  // Config precedence
  // -------------------------------------------------------------------------

  it("JSON fallbackModels overrides declaration (staticOverrides) fallbackModels", () => {
    const decl = makeDecl({ fallbackModels: ["decl-fallback"] });
    const config: BlackbytesConfig = {
      ...BASE_CONFIG,
      sub_agents: {
        "test-agent": { fallbackModels: ["json-fallback"] } as unknown as Record<string, never>,
      },
    };
    const snapshot = resolveAgentSnapshot(decl, config);
    assert.deepEqual(snapshot.fallbackModels, ["json-fallback"]);
  });

  it("YAML fallback_models folds into staticOverrides and is used when no JSON override", () => {
    // Simulate what the YAML loader does: sets staticOverrides.fallbackModels
    const decl = defineSubAgent<{ q: string }>({
      name: "yaml-agent",
      toolName: "delegate_yaml-agent",
      description: "test",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read"],
      source: "yaml",
      staticOverrides: { fallbackModels: ["yaml-fallback"] },
      buildUserPrompt: (p) => p.q,
    });
    const snapshot = resolveAgentSnapshot(decl, BASE_CONFIG);
    assert.deepEqual(snapshot.fallbackModels, ["yaml-fallback"]);
  });

  it("JSON wins over YAML staticOverrides for fallbackModels", () => {
    const decl = defineSubAgent<{ q: string }>({
      name: "yaml-agent",
      toolName: "delegate_yaml-agent",
      description: "test",
      parameters: Type.Object({ q: Type.String() }),
      systemPrompt: "x",
      allowedTools: ["read"],
      source: "yaml",
      staticOverrides: { fallbackModels: ["yaml-fallback"] },
      buildUserPrompt: (p) => p.q,
    });
    const config: BlackbytesConfig = {
      ...BASE_CONFIG,
      sub_agents: {
        "yaml-agent": { fallbackModels: ["json-wins"] } as unknown as Record<string, never>,
      },
    };
    const snapshot = resolveAgentSnapshot(decl, config);
    assert.deepEqual(snapshot.fallbackModels, ["json-wins"]);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("fallbackModels schema validation", () => {
  it("rejects non-string entries in fallbackModels", () => {
    const result = parseBlackbytesConfig({
      sub_agents: { explore: { fallbackModels: [42] } },
    });
    assert.equal(result.ok, false);
  });

  it("rejects more than 5 entries", () => {
    const result = parseBlackbytesConfig({
      sub_agents: {
        explore: { fallbackModels: ["a", "b", "c", "d", "e", "f"] },
      },
    });
    assert.equal(result.ok, false);
  });

  it("accepts valid fallbackModels array", () => {
    const result = parseBlackbytesConfig({
      sub_agents: { explore: { fallbackModels: ["gpt-4o", "claude-opus-4"] } },
    });
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Snapshot eligibility for builtin agents
// ---------------------------------------------------------------------------

describe("snapshot eligibility for builtin agents", () => {
  beforeEach(() => {
    // generalDeclaration.allowedTools() calls getEnabledSet() at execution time.
    // Initialize a default enabled set so snapshot resolution does not throw.
    _resetEnabledSet();
    initEnabledSet(BASE_CONFIG);
  });
  it("explore — eligible for fallback (read-only)", () => {
    const snapshot = resolveAgentSnapshot(exploreDeclaration, BASE_CONFIG);
    assert.equal(snapshot.fallbackEligible, true);
  });

  it("oracle — eligible for fallback (read-only)", () => {
    const snapshot = resolveAgentSnapshot(oracleDeclaration, BASE_CONFIG);
    assert.equal(snapshot.fallbackEligible, true);
  });

  it("librarian — eligible for fallback (read-only)", () => {
    const snapshot = resolveAgentSnapshot(librarianDeclaration, BASE_CONFIG);
    assert.equal(snapshot.fallbackEligible, true);
  });

  it("general — ineligible for fallback (full-access / mutating tools)", () => {
    const snapshot = resolveAgentSnapshot(generalDeclaration, BASE_CONFIG);
    assert.equal(snapshot.fallbackEligible, false);
  });

  it("explore with fallbackModels configured — still shows eligible", () => {
    const config: BlackbytesConfig = {
      ...BASE_CONFIG,
      sub_agents: {
        explore: { fallbackModels: ["claude-opus-4"] } as unknown as Record<string, never>,
      },
    };
    const snapshot = resolveAgentSnapshot(exploreDeclaration, config);
    assert.equal(snapshot.fallbackEligible, true);
    assert.deepEqual(snapshot.fallbackModels, ["claude-opus-4"]);
  });
});
