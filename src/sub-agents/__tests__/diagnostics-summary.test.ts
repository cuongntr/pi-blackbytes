import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import type { BlackbytesConfig } from "../../config/schema.js";
import { defineSubAgent } from "../declaration.js";
import { logDelegation, resetDelegationLog } from "../delegation-log.js";
import { buildDiagnosticsSummary } from "../diagnostics-summary.js";
import { _resetYamlDiagnostics, setYamlDiagnostics } from "../diagnostics.js";
import { _resetAgentSnapshot, initAgentSnapshot } from "../snapshot.js";

const defaultConfig: BlackbytesConfig = {
  disabled_tools: [],
  disabled_sub_agents: [],
  hashline_edit: true,
};

function makeTestAgent(name: string) {
  return defineSubAgent<{ question: string }>({
    name,
    toolName: `delegate_${name}`,
    parameters: Type.Object({
      question: Type.String(),
    }),
    description: `Test ${name} sub-agent`,
    systemPrompt: `Test ${name} prompt`,
    allowedTools: ["read", "grep"],
    mutability: "read-only",
    finalizeMode: "strict",
    source: "builtin",
    buildUserPrompt: (p) => p.question,
  });
}

beforeEach(() => {
  const agents = [makeTestAgent("explore"), makeTestAgent("oracle")];
  initEnabledSet(defaultConfig);
  initAgentSnapshot(agents, defaultConfig);
});

afterEach(() => {
  resetDelegationLog();
  _resetYamlDiagnostics();
  _resetAgentSnapshot();
  _resetEnabledSet();
});

describe("buildDiagnosticsSummary", () => {
  it("returns empty summary when no delegations", () => {
    const summary = buildDiagnosticsSummary();
    assert.equal(summary.agents.length, 2);
    assert.equal(summary.totalDelegations, 0);
    assert.equal(summary.successRate, 1);
    assert.equal(summary.recentFailures.length, 0);
    assert.equal(summary.yamlWarnings.length, 0);
  });

  it("groups failures by kind", () => {
    logDelegation({
      agent: "explore",
      startedAt: 1000,
      durationMs: 500,
      success: false,
      toolCallCount: 0,
      outputChars: 0,
      failureKind: "timed_out",
      errorHint: "Request timed out after 300s",
    });
    logDelegation({
      agent: "oracle",
      startedAt: 2000,
      durationMs: 600,
      success: false,
      toolCallCount: 0,
      outputChars: 0,
      failureKind: "timed_out",
      errorHint: "Another timeout",
    });
    logDelegation({
      agent: "explore",
      startedAt: 3000,
      durationMs: 400,
      success: false,
      toolCallCount: 0,
      outputChars: 0,
      failureKind: "spawn_error",
      errorHint: "pi CLI not found",
    });

    const summary = buildDiagnosticsSummary();
    assert.equal(summary.totalDelegations, 3);
    assert.equal(summary.successRate, 0);
    assert.equal(summary.recentFailures.length, 2);

    const timeoutGroup = summary.recentFailures.find((f) => f.kind === "timed_out");
    assert.ok(timeoutGroup);
    assert.equal(timeoutGroup.count, 2);
    assert.equal(timeoutGroup.recentHints.length, 2);

    const spawnGroup = summary.recentFailures.find((f) => f.kind === "spawn_error");
    assert.ok(spawnGroup);
    assert.equal(spawnGroup.count, 1);
  });

  it("limits recent hints to 3 per failure kind", () => {
    for (let i = 0; i < 5; i++) {
      logDelegation({
        agent: "explore",
        startedAt: 1000 + i,
        durationMs: 100,
        success: false,
        toolCallCount: 0,
        outputChars: 0,
        failureKind: "failed",
        errorHint: `Error ${i}`,
      });
    }

    const summary = buildDiagnosticsSummary();
    const failedGroup = summary.recentFailures.find((f) => f.kind === "failed");
    assert.ok(failedGroup);
    assert.equal(failedGroup.count, 5);
    assert.deepEqual(failedGroup.recentHints, ["Error 4", "Error 3", "Error 2"]);
  });

  it("passes through pre-redacted error hints", () => {
    logDelegation({
      agent: "explore",
      startedAt: 1000,
      durationMs: 500,
      success: false,
      toolCallCount: 0,
      outputChars: 0,
      failureKind: "failed",
      errorHint: "API_KEY=[REDACTED] failed",
    });

    const summary = buildDiagnosticsSummary();
    const hint = summary.recentFailures[0]?.recentHints[0];
    assert.equal(hint, "API_KEY=[REDACTED] failed");
  });

  it("includes YAML warnings", () => {
    setYamlDiagnostics({
      directory: "/tmp/agents",
      directoryExists: true,
      scannedFiles: ["test.yaml"],
      loadedDeclarations: [],
      skippedFiles: [{ file: "test.yaml", reason: "Invalid schema" }],
    });

    const summary = buildDiagnosticsSummary();
    assert.equal(summary.yamlWarnings.length, 1);
    assert.ok(summary.yamlWarnings[0].includes("test.yaml"));
    assert.ok(summary.yamlWarnings[0].includes("Invalid schema"));
  });

  it("computes success rate correctly", () => {
    logDelegation({
      agent: "explore",
      startedAt: 1000,
      durationMs: 500,
      success: true,
      toolCallCount: 3,
      outputChars: 100,
    });
    logDelegation({
      agent: "oracle",
      startedAt: 2000,
      durationMs: 600,
      success: false,
      toolCallCount: 0,
      outputChars: 0,
      failureKind: "timed_out",
    });

    const summary = buildDiagnosticsSummary();
    assert.equal(summary.totalDelegations, 2);
    assert.equal(summary.successRate, 0.5);
  });
});
