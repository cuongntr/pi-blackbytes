import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Type } from "@sinclair/typebox";

import type { BlackbytesConfig } from "../../config/schema.js";
import { defineSubAgent } from "../declaration.js";
import {
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
  copilot_initiator_header: true,
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
