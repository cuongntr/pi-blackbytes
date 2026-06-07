import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getDelegationLog,
  getDelegationSummary,
  logDelegation,
  resetDelegationLog,
} from "../delegation-log.js";

afterEach(() => {
  resetDelegationLog();
});

describe("logDelegation / getDelegationLog", () => {
  it("starts empty", () => {
    assert.deepEqual(getDelegationLog(), []);
  });

  it("appends entries", () => {
    logDelegation({
      agent: "explore",
      startedAt: 1000,
      durationMs: 500,
      success: true,
      toolCallCount: 3,
      outputChars: 120,
    });
    const log = getDelegationLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].agent, "explore");
    assert.equal(log[0].success, true);
    assert.equal(log[0].toolCallCount, 3);
  });

  it("returns a readonly view (mutations do not affect internal state)", () => {
    logDelegation({
      agent: "oracle",
      startedAt: 2000,
      durationMs: 800,
      success: false,
      toolCallCount: 1,
      outputChars: 50,
    });
    const view = getDelegationLog();
    assert.equal(view.length, 1);
    // Casting away readonly to verify the internal array is not the same ref
    // exposed directly — pushing to the view should not grow the internal log.
    (view as unknown as unknown[]).push({} as never);
    // The internal log via a fresh call still has just 1 entry
    assert.equal(getDelegationLog().length, 1);
  });

  it("logs entries with failureKind", () => {
    logDelegation({
      agent: "explore",
      startedAt: 1000,
      durationMs: 500,
      success: false,
      toolCallCount: 3,
      outputChars: 0,
      failureKind: "timed_out",
    });
    const log = getDelegationLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].failureKind, "timed_out");
  });

  it("logs entries with fallbackAttempts", () => {
    logDelegation({
      agent: "explore",
      startedAt: 2000,
      durationMs: 800,
      success: true,
      toolCallCount: 5,
      outputChars: 200,
      fallbackAttempts: [
        {
          model: "gpt-4o",
          status: "provider_or_model_unavailable",
          retriable: true,
          durationMs: 1200,
        },
        {
          model: "claude-opus-4",
          status: "success",
          retriable: false,
          durationMs: 4500,
        },
      ],
    });
    const log = getDelegationLog();
    assert.equal(log.length, 1);
    assert.ok(log[0].fallbackAttempts);
    assert.equal(log[0].fallbackAttempts!.length, 2);
    assert.equal(log[0].fallbackAttempts![0].model, "gpt-4o");
    assert.equal(log[0].fallbackAttempts![1].status, "success");
  });

  it("logs entries with artifactPath", () => {
    logDelegation({
      agent: "explore",
      startedAt: 2500,
      durationMs: 600,
      success: true,
      toolCallCount: 2,
      outputChars: 300,
      artifactPath: "/tmp/pi-blackbytes/artifact.md",
    });
    const log = getDelegationLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].artifactPath, "/tmp/pi-blackbytes/artifact.md");
  });

  it("logs entries with errorHint (up to ~200 chars)", () => {
    const hint = "A".repeat(200);
    logDelegation({
      agent: "explore",
      startedAt: 3000,
      durationMs: 300,
      success: false,
      toolCallCount: 1,
      outputChars: 0,
      errorHint: hint,
    });
    const log = getDelegationLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].errorHint, hint);
    assert.equal(log[0].errorHint!.length, 200);
  });

  it("omits optional fields when absent", () => {
    logDelegation({
      agent: "general",
      startedAt: 4000,
      durationMs: 100,
      success: true,
      toolCallCount: 1,
      outputChars: 50,
    });
    const entry = getDelegationLog()[0];
    assert.equal(entry.failureKind, undefined);
    assert.equal(entry.fallbackAttempts, undefined);
    assert.equal(entry.errorHint, undefined);
    assert.equal(entry.artifactPath, undefined);
  });
});

describe("delegation log entry cap", () => {
  it("evicts oldest entries when cap (100) is exceeded", () => {
    // Log 105 entries
    const total = 105;
    for (let i = 1; i <= total; i++) {
      logDelegation({
        agent: `agent-${i}`,
        startedAt: i,
        durationMs: 10,
        success: true,
        toolCallCount: 1,
        outputChars: 0,
      });
    }

    const log = getDelegationLog();
    assert.equal(log.length, 100, "expected 100 entries after eviction");

    // First 5 entries (agent-1 through agent-5) should have been evicted
    assert.equal(log[0].agent, "agent-6", "oldest entry should be evicted");
    assert.equal(log[0].startedAt, 6);

    // Last entry should be agent-105
    assert.equal(log[log.length - 1].agent, "agent-105", "newest entry should remain");
    assert.equal(log[log.length - 1].startedAt, 105);
  });

  it("does not evict entries when under the cap", () => {
    for (let i = 1; i <= 5; i++) {
      logDelegation({
        agent: `under-${i}`,
        startedAt: i,
        durationMs: 10,
        success: true,
        toolCallCount: 1,
        outputChars: 0,
      });
    }
    const log = getDelegationLog();
    assert.equal(log.length, 5);
  });
});

describe("resetDelegationLog", () => {
  it("clears all entries", () => {
    logDelegation({
      agent: "general",
      startedAt: 3000,
      durationMs: 200,
      success: true,
      toolCallCount: 5,
      outputChars: 300,
    });
    assert.equal(getDelegationLog().length, 1);
    resetDelegationLog();
    assert.equal(getDelegationLog().length, 0);
  });
});

describe("getDelegationSummary", () => {
  it("returns empty message when no entries", () => {
    assert.equal(getDelegationSummary(), "No delegations this session.");
  });

  it("formats single agent summary correctly", () => {
    logDelegation({
      agent: "explore",
      startedAt: 1000,
      durationMs: 1000,
      success: true,
      toolCallCount: 4,
      outputChars: 200,
    });
    const summary = getDelegationSummary();
    assert.match(summary, /Delegations this session: 1 total/);
    assert.match(summary, /explore: 1x \(1\/1 ok, avg 1000ms\)/);
  });

  it("aggregates multiple calls to the same agent", () => {
    logDelegation({
      agent: "oracle",
      startedAt: 1000,
      durationMs: 2000,
      success: true,
      toolCallCount: 2,
      outputChars: 100,
    });
    logDelegation({
      agent: "oracle",
      startedAt: 3000,
      durationMs: 4000,
      success: false,
      toolCallCount: 1,
      outputChars: 50,
    });
    const summary = getDelegationSummary();
    assert.match(summary, /Delegations this session: 2 total/);
    // avg of 2000 and 4000 = 3000ms; 1 success out of 2
    assert.match(summary, /oracle: 2x \(1\/2 ok, avg 3000ms\)/);
  });

  it("includes cost in summary when non-zero", () => {
    logDelegation({
      agent: "librarian",
      startedAt: 1000,
      durationMs: 500,
      success: true,
      toolCallCount: 3,
      outputChars: 80,
      cost: 0.0025,
    });
    const summary = getDelegationSummary();
    assert.match(summary, /\$0\.0025/);
  });

  it("omits cost when zero or absent", () => {
    logDelegation({
      agent: "general",
      startedAt: 1000,
      durationMs: 300,
      success: true,
      toolCallCount: 2,
      outputChars: 60,
    });
    const summary = getDelegationSummary();
    assert.doesNotMatch(summary, /\$/);
  });

  it("sorts agents alphabetically", () => {
    logDelegation({
      agent: "oracle",
      startedAt: 1000,
      durationMs: 100,
      success: true,
      toolCallCount: 1,
      outputChars: 10,
    });
    logDelegation({
      agent: "explore",
      startedAt: 2000,
      durationMs: 200,
      success: true,
      toolCallCount: 1,
      outputChars: 10,
    });
    logDelegation({
      agent: "general",
      startedAt: 3000,
      durationMs: 300,
      success: true,
      toolCallCount: 1,
      outputChars: 10,
    });
    const lines = getDelegationSummary().split("\n");
    // Lines after the header should be explore, general, oracle
    assert.match(lines[1], /explore/);
    assert.match(lines[2], /general/);
    assert.match(lines[3], /oracle/);
  });
});
