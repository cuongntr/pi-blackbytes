import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Type } from "typebox";

import type { BlackbytesConfig } from "../../config/schema.js";
import { defineSubAgent } from "../declaration.js";
import {
  type AllowedToolsSummary,
  _resetAgentSnapshot,
  getAgentSnapshot,
  getAgentSnapshotFor,
  initAgentSnapshot,
  resolveAgentSnapshot,
} from "../snapshot.js";

const baseDecl = defineSubAgent<{ q: string }>({
  name: "explore",
  toolName: "delegate_explore",
  description: "test",
  parameters: Type.Object({ q: Type.String() }),
  systemPrompt: "x",
  allowedTools: ["read"],
  source: "builtin",
  buildUserPrompt: (p) => p.q,
});

const baseConfig: BlackbytesConfig = {
  disabled_tools: [],
  disabled_sub_agents: [],
  hashline_edit: true,
};

describe("resolveAgentSnapshot", () => {
  beforeEach(() => _resetAgentSnapshot());

  it("uses declaration staticOverrides when no JSON config given", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { model: "decl-model", reasoningEffort: "low" },
    });
    const snap = resolveAgentSnapshot(decl, baseConfig);
    assert.equal(snap.model, "decl-model");
    assert.equal(snap.reasoningEffort, "low");
    assert.deepEqual(snap.reserved, {});
    assert.deepEqual(snap.extra, {});
    assert.equal(snap.source, "builtin");
  });

  it("JSON config overrides declaration defaults", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { model: "decl-model", reasoningEffort: "low" },
    });
    const config: BlackbytesConfig = {
      ...baseConfig,
      sub_agents: { explore: { model: "json-model", reasoningEffort: "high" } },
    };
    const snap = resolveAgentSnapshot(decl, config);
    assert.equal(snap.model, "json-model");
    assert.equal(snap.reasoningEffort, "high");
  });

  it("ignores invalid (non-string) JSON model and reasoning values", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      staticOverrides: { model: "decl-model" },
    });
    // Cast to satisfy TS; mirrors a malformed user settings file.
    const config: BlackbytesConfig = {
      ...baseConfig,
      sub_agents: { explore: { model: 42 as unknown as string } },
    };
    const snap = resolveAgentSnapshot(decl, config);
    assert.equal(snap.model, "decl-model", "fell back to declaration default");
  });

  it("coerces invalid legacy reasoningEffort values to undefined", () => {
    const config: BlackbytesConfig = {
      ...baseConfig,
      sub_agents: { explore: { reasoningEffort: "invalid_old_value" } },
    };
    const snap = resolveAgentSnapshot(baseDecl, config);
    assert.equal(snap.reasoningEffort, undefined, "invalid value coerced to undefined");
  });

  it("preserves valid reasoningEffort values including off", () => {
    const config: BlackbytesConfig = {
      ...baseConfig,
      sub_agents: { explore: { reasoningEffort: "off" } },
    };
    const snap = resolveAgentSnapshot(baseDecl, config);
    assert.equal(snap.reasoningEffort, "off");
  });

  it("preserves temperature as reserved (not threaded into runtime)", () => {
    const config: BlackbytesConfig = {
      ...baseConfig,
      sub_agents: { explore: { temperature: 0.42 } },
    };
    const snap = resolveAgentSnapshot(baseDecl, config);
    assert.equal(snap.reserved.temperature, 0.42);
    assert.equal(snap.model, undefined);
  });

  it("preserves unknown nested fields in extra (passthrough)", () => {
    const config: BlackbytesConfig = {
      ...baseConfig,
      sub_agents: {
        explore: { foo: "bar", future_field: 7 } as unknown as Record<string, never>,
      },
    };
    const snap = resolveAgentSnapshot(baseDecl, config);
    assert.equal(snap.extra.foo, "bar");
    assert.equal(snap.extra.future_field, 7);
  });

  it("YAML source carries sourcePath through to snapshot", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      name: "yaml_agent",
      source: "yaml",
      sourcePath: "/some/dir/yaml_agent.yaml",
    });
    const snap = resolveAgentSnapshot(decl, baseConfig);
    assert.equal(snap.source, "yaml");
    assert.equal(snap.sourcePath, "/some/dir/yaml_agent.yaml");
  });

  it("snapshot object is deeply frozen", () => {
    const snap = resolveAgentSnapshot(baseDecl, baseConfig);
    assert.equal(Object.isFrozen(snap), true);
    assert.equal(Object.isFrozen(snap.reserved), true);
    assert.equal(Object.isFrozen(snap.extra), true);
  });

  it("executionMode resolved from JSON config, falling back to declaration default", () => {
    // JSON config takes precedence over declaration field.
    const declWithDefault = defineSubAgent<{ q: string }>({
      ...baseDecl,
      executionMode: "parallel",
    });
    const configWithOverride: BlackbytesConfig = {
      ...baseConfig,
      sub_agents: { explore: { executionMode: "sequential" } },
    };
    const snap1 = resolveAgentSnapshot(declWithDefault, configWithOverride);
    assert.equal(snap1.executionMode, "sequential", "JSON config overrides declaration");

    // Declaration default used when JSON config omits executionMode.
    const snap2 = resolveAgentSnapshot(declWithDefault, baseConfig);
    assert.equal(snap2.executionMode, "parallel", "falls back to declaration default");

    // Undefined when neither declaration nor JSON config sets it.
    const snap3 = resolveAgentSnapshot(baseDecl, baseConfig);
    assert.equal(
      snap3.executionMode,
      undefined,
      "undefined when unconfigured (Pi parallel default)",
    );
  });
});

describe("session snapshot lifecycle", () => {
  beforeEach(() => _resetAgentSnapshot());

  it("getAgentSnapshot returns undefined before init", () => {
    assert.equal(getAgentSnapshot(), undefined);
    assert.equal(getAgentSnapshotFor("explore"), undefined);
  });

  it("initAgentSnapshot freezes a snapshot per declaration", () => {
    const map = initAgentSnapshot([baseDecl], baseConfig);
    assert.equal(map.size, 1);
    assert.ok(map.get("explore"));
    assert.equal(getAgentSnapshotFor("explore")?.name, "explore");
  });

  it("snapshot is immutable to post-startup config mutation", () => {
    // Initialize with one config.
    const initialConfig: BlackbytesConfig = {
      ...baseConfig,
      sub_agents: { explore: { model: "initial-model" } },
    };
    initAgentSnapshot([baseDecl], initialConfig);
    const before = getAgentSnapshotFor("explore");
    assert.equal(before?.model, "initial-model");

    // Simulate disk change after handleSessionStart returns: the user edits
    // settings.json. The snapshot must NOT reflect this mutation.
    initialConfig.sub_agents = { explore: { model: "mutated-model" } };
    const after = getAgentSnapshotFor("explore");
    assert.equal(after?.model, "initial-model", "snapshot must remain stable");
    assert.equal(after, before, "same frozen instance");
  });
});

describe("resolveAgentSnapshot finalized tools", () => {
  beforeEach(() => _resetAgentSnapshot());

  it("globally disabled tools are excluded from allowedToolsSummary", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      allowedTools: ["read", "glob", "web_search"],
    });
    const snap = resolveAgentSnapshot(decl, baseConfig, new Set(["web_search"]));
    assert.equal(snap.allowedToolsSummary.mode, "exact");
    const { tools } = snap.allowedToolsSummary as Extract<AllowedToolsSummary, { mode: "exact" }>;
    assert.ok(!tools.includes("web_search"), "globally disabled tool must not appear");
    assert.ok(tools.includes("read"), "enabled tool must be present");
    assert.ok(tools.includes("glob"), "other enabled tool must be present");
  });

  it("fallbackEligible reflects finalized tools after mutability stripping", () => {
    // read-only agent lists bash (mutating) in allowedTools → stripped during finalization
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      allowedTools: ["read", "bash"],
      mutability: "read-only",
    });
    const snap = resolveAgentSnapshot(decl, baseConfig);
    // With finalized tools (bash stripped), no mutating tools remain → eligible
    assert.equal(snap.fallbackEligible, true);
    assert.ok(
      snap.droppedTools?.mutability.includes("bash"),
      "bash should be in droppedTools.mutability",
    );
  });

  it("droppedTools reports globally disabled, mutability-stripped, and unknown tools", () => {
    const decl = defineSubAgent<{ q: string }>({
      ...baseDecl,
      allowedTools: ["read", "web_search", "not_a_real_tool"],
      mutability: "read-only",
    });
    const snap = resolveAgentSnapshot(decl, baseConfig, new Set(["web_search"]));
    assert.ok(
      snap.droppedTools?.globalDisabled.includes("web_search"),
      "should report globally disabled tools",
    );
    assert.ok(
      snap.droppedTools?.unknown.includes("not_a_real_tool"),
      "should report unknown tools",
    );
    assert.deepEqual(snap.droppedTools?.mutability, [], "no mutating tools to strip");
  });
});
