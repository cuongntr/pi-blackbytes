import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnabledSet } from "../../../config/enabled-set.js";
import type { DelegateResult, RunNestedPiOptions } from "../../../sub-agents/types.js";
import { executeHandoff } from "../tool.js";

function makeEnabledSet(overrides: Partial<EnabledSet> = {}): EnabledSet {
  return Object.freeze({
    tools: overrides.tools ?? new Set<string>(),
    subAgents: overrides.subAgents ?? new Set<string>(),
    skills: overrides.skills ?? new Set<string>(),
    disabledTools: overrides.disabledTools ?? new Set<string>(),
  });
}

interface CapturedSpawn {
  options: RunNestedPiOptions;
}

function makeSpawnCapture(result: DelegateResult): {
  spawn: (opts: RunNestedPiOptions) => Promise<DelegateResult>;
  captured: CapturedSpawn[];
} {
  const captured: CapturedSpawn[] = [];
  return {
    captured,
    spawn: async (opts: RunNestedPiOptions) => {
      captured.push({ options: opts });
      return result;
    },
  };
}

describe("handoff tool", () => {
  it("rejects empty goal with a clear error", async () => {
    const { spawn, captured } = makeSpawnCapture({ success: true, content: "" });
    const result = await executeHandoff({ goal: "   " }, { spawn });
    assert.equal(captured.length, 0, "spawn must not be called for empty goal");
    assert.match(result.content[0].text, /non-empty `goal`/);
    assert.equal(result.details?.summary, "missing goal");
  });

  it("spawns nested Pi with goal embedded as Handoff context header", async () => {
    const { spawn, captured } = makeSpawnCapture({
      success: true,
      content: "all done",
    });
    const result = await executeHandoff(
      { goal: "Refactor the auth module" },
      {
        spawn,
        cwd: () => "/tmp/work",
        now: () => "2026-05-02T00:00:00.000Z",
      },
    );
    assert.equal(captured.length, 1);
    const opts = captured[0].options;
    assert.match(opts.userPrompt, /^Handoff context: Refactor the auth module/);
    assert.match(opts.userPrompt, /timestamp: 2026-05-02T00:00:00.000Z/);
    assert.match(opts.userPrompt, /working directory: \/tmp\/work/);
    assert.equal(opts.cwd, "/tmp/work");
    assert.deepEqual(opts.allowedTools, []);
    assert.equal(result.content[0].text, "all done");
    assert.equal(result.details?.summary, "handoff completed");
  });

  it("includes mode hint when provided and surfaces it in summary", async () => {
    const { spawn, captured } = makeSpawnCapture({ success: true, content: "ok" });
    const result = await executeHandoff(
      { goal: "Investigate flaky test", mode: "deep" },
      { spawn, cwd: () => "/x", now: () => "T" },
    );
    assert.match(captured[0].options.userPrompt, /mode hint: deep/);
    assert.equal(result.details?.summary, "handoff completed (deep)");
  });

  it("caps prior_summary at 4 KB and routes it through redactSecrets", async () => {
    const { spawn, captured } = makeSpawnCapture({ success: true, content: "ok" });
    const big = "x".repeat(5000);
    // Synthetic high-entropy token assembled at runtime so we never commit a
    // real-looking secret literal to the repo.
    const fakeToken = ["sk", "test", "abcdef0123456789ABCDEFGHIJKLMNOP"].join("_");
    const priorSummary = `Authorization: Bearer ${fakeToken} (trailing pad) ${big}`;
    await executeHandoff(
      { goal: "g", prior_summary: priorSummary },
      { spawn, cwd: () => "/x", now: () => "T" },
    );
    const userPrompt = captured[0].options.userPrompt;
    assert.ok(userPrompt.includes("Prior thread summary"), "section header present");
    // Capped: original is >5000 chars; never embed a >4500-char x-run.
    assert.equal(userPrompt.match(/x{4500,}/), null, "prior summary content was capped");
  });

  it("returns a failure result with details when nested Pi fails", async () => {
    const { spawn } = makeSpawnCapture({
      success: false,
      content: "nested error",
      details: "stderr trace",
      failureKind: "failed",
    });
    const result = await executeHandoff(
      { goal: "do stuff" },
      { spawn, cwd: () => "/x", now: () => "T" },
    );
    assert.match(result.content[0].text, /Handoff failed/);
    assert.match(result.content[0].text, /stderr trace/);
    assert.equal(result.details?.summary, "handoff failed");
  });

  it("forwards a 30-minute default timeout to runNestedPi", async () => {
    const { spawn, captured } = makeSpawnCapture({ success: true, content: "ok" });
    await executeHandoff({ goal: "g" }, { spawn, cwd: () => "/x", now: () => "T" });
    assert.equal(captured[0].options.timeoutMs, 1_800_000);
  });

  it("auto-distills the last messages from a sessionManager when present", async () => {
    const { spawn, captured } = makeSpawnCapture({ success: true, content: "ok" });
    const fakeBranch = [
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t",
        message: { role: "user", content: "Implement feature X" },
      },
      {
        type: "thinking_level_change",
        id: "2",
        parentId: "1",
        timestamp: "t",
        thinkingLevel: "high",
      },
      {
        type: "message",
        id: "3",
        parentId: "2",
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Reading files now" },
            { type: "toolCall", name: "read", arguments: { path: "x.ts" } },
          ],
        },
      },
    ];
    const sm = { getBranch: () => fakeBranch };
    await executeHandoff(
      { goal: "Continue" },
      { spawn, sessionManager: sm, cwd: () => "/x", now: () => "T" },
    );
    const userPrompt = captured[0].options.userPrompt;
    assert.match(userPrompt, /Auto-distilled prior summary/);
    assert.match(userPrompt, /Implement feature X/);
    assert.match(userPrompt, /Reading files now/);
    assert.match(userPrompt, /\[toolCall: read\]/);
  });

  it("skips auto-distill when sessionManager throws or yields nothing", async () => {
    const { spawn, captured } = makeSpawnCapture({ success: true, content: "ok" });
    const sm = {
      getBranch: () => {
        throw new Error("boom");
      },
    };
    await executeHandoff(
      { goal: "g" },
      { spawn, sessionManager: sm, cwd: () => "/x", now: () => "T" },
    );
    assert.equal(captured[0].options.userPrompt.includes("Auto-distilled prior summary"), false);
  });

  // ---------------------------------------------------------------------
  // Boundary regression: nested handoff must propagate parent's
  // capability gating instead of receiving the full Pi tool surface.
  // ---------------------------------------------------------------------

  it("propagates parent's enabled extension tools + Pi built-ins to nested allowlist", async () => {
    const { spawn, captured } = makeSpawnCapture({ success: true, content: "ok" });
    const enabled = makeEnabledSet({
      tools: new Set(["hashline_edit", "grep", "glob", "web_search"]),
    });
    await executeHandoff(
      { goal: "g" },
      { spawn, cwd: () => "/x", now: () => "T", getEnabledSetFn: () => enabled },
    );
    const allowed = new Set(captured[0].options.allowedTools);
    // Parent's enabled extension tools must be present.
    for (const name of ["hashline_edit", "grep", "glob", "web_search"]) {
      assert.ok(allowed.has(name), `expected nested allowlist to include ${name}`);
    }
    // Pi built-ins must be present (handoff is full-access).
    for (const name of ["read", "bash", "edit", "write"]) {
      assert.ok(allowed.has(name), `expected nested allowlist to include builtin ${name}`);
    }
    assert.ok(allowed.size >= 8, "nested allowlist should include >= 8 tools");
  });

  it("respects parent's disabled_tools — disabled extension tools are excluded from nested allowlist", async () => {
    const { spawn, captured } = makeSpawnCapture({ success: true, content: "ok" });
    const enabled = makeEnabledSet({
      tools: new Set(["hashline_edit", "grep", "glob"]),
      // User explicitly disabled `bash` and `web_search`. Even though `bash`
      // is a Pi built-in (not in `tools`), the global denylist must still
      // strip it from the nested allowlist.
      disabledTools: new Set(["bash", "web_search"]),
    });
    await executeHandoff(
      { goal: "g" },
      { spawn, cwd: () => "/x", now: () => "T", getEnabledSetFn: () => enabled },
    );
    const allowed = new Set(captured[0].options.allowedTools);
    assert.ok(!allowed.has("bash"), "disabled `bash` must NOT appear in nested allowlist");
    assert.ok(
      !allowed.has("web_search"),
      "disabled `web_search` must NOT appear in nested allowlist",
    );
    // Non-disabled tools survive.
    assert.ok(allowed.has("hashline_edit"));
    assert.ok(allowed.has("read"));
  });

  it("excludes `delegate_*` tools from nested allowlist (defense-in-depth on top of recursion guard)", async () => {
    const { spawn, captured } = makeSpawnCapture({ success: true, content: "ok" });
    const enabled = makeEnabledSet({
      // Include delegate_* names as if they were enabled (simulating misuse).
      tools: new Set(["hashline_edit", "delegate_explore", "delegate_oracle", "grep"]),
    });
    await executeHandoff(
      { goal: "g" },
      { spawn, cwd: () => "/x", now: () => "T", getEnabledSetFn: () => enabled },
    );
    const allowed = captured[0].options.allowedTools;
    const hasDelegate = allowed.some((t) => t.startsWith("delegate_"));
    assert.ok(!hasDelegate, "nested allowlist must not contain any delegate_* tools");
  });
});
