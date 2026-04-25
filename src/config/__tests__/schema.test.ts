import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BlackbytesConfigSchema, parseBlackbytesConfig } from "../schema.js";

describe("BlackbytesConfigSchema", () => {
  it("empty object validates with all defaults applied", () => {
    const result = parseBlackbytesConfig({});
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.value.disabled_tools, []);
      assert.deepEqual(result.value.disabled_sub_agents, []);
      assert.equal(result.value.hashline_edit, true);
      assert.equal(result.value.copilot_initiator_header, true);
      assert.equal(result.value.websearch, undefined);
      assert.equal(result.value.context7, undefined);
      assert.equal(result.value.system_prompt_log, undefined);
      assert.equal(result.value.sub_agents, undefined);
    }
  });

  it("invalid types produce clear error messages", () => {
    const result = parseBlackbytesConfig({ hashline_edit: "yes" });
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors[0].includes("hashline_edit"));
    }
  });

  it("unknown keys are preserved (not stripped)", () => {
    const result = parseBlackbytesConfig({ unknown_key: "hello" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal((result.value as Record<string, unknown>).unknown_key, "hello");
    }
  });

  it("valid full config parses correctly", () => {
    const input = {
      disabled_tools: ["tool1", "tool2"],
      disabled_sub_agents: ["explore", "oracle"],
      hashline_edit: false,
      copilot_initiator_header: false,
      websearch: { provider: "exa", exa_api_key: "key123" },
      context7: { api_key: "c7key" },
      system_prompt_log: {
        enabled: true,
        path: "./system-prompts.jsonl",
        capture_provider_system: true,
      },
      sub_agents: {
        myAgent: { model: "gpt-4o", reasoningEffort: "high", temperature: 0.7 },
      },
    };
    const result = parseBlackbytesConfig(input);
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.value.disabled_tools, ["tool1", "tool2"]);
      assert.deepEqual(result.value.disabled_sub_agents, ["explore", "oracle"]);
      assert.equal(result.value.hashline_edit, false);
      assert.equal(result.value.websearch?.provider, "exa");
      assert.equal(result.value.websearch?.exa_api_key, "key123");
      assert.equal(result.value.context7?.api_key, "c7key");
      assert.equal(result.value.system_prompt_log?.enabled, true);
      assert.equal(result.value.system_prompt_log?.path, "./system-prompts.jsonl");
      assert.equal(result.value.system_prompt_log?.capture_agent_start, true);
      assert.equal(result.value.system_prompt_log?.capture_provider_system, true);
      assert.equal(result.value.system_prompt_log?.include_nested, false);
      assert.equal(result.value.system_prompt_log?.dedupe, true);
      assert.equal(result.value.sub_agents?.myAgent?.model, "gpt-4o");
    }
  });

  it("accepts arbitrary strings in disabled_sub_agents", () => {
    const result = parseBlackbytesConfig({
      disabled_sub_agents: ["custom_yaml_agent", "explore"],
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.value.disabled_sub_agents, ["custom_yaml_agent", "explore"]);
    }
  });

  it("preserves unknown nested per-agent fields (passthrough)", () => {
    // Forward-compat guarantee: the per-agent inner schema must not strip
    // unknown keys. This protects user settings from silent loss when a
    // future-supported field is configured before the runtime supports it.
    const result = parseBlackbytesConfig({
      sub_agents: {
        myAgent: {
          model: "gpt-4o",
          // intentionally unknown — must be preserved verbatim
          custom_future_field: { nested: true },
          another_unknown: 42,
        },
      },
    });
    assert.ok(result.ok);
    if (result.ok) {
      const agent = result.value.sub_agents?.myAgent as Record<string, unknown> | undefined;
      assert.ok(agent, "agent entry should be preserved");
      assert.equal(agent?.model, "gpt-4o");
      assert.deepEqual(agent?.custom_future_field, { nested: true });
      assert.equal(agent?.another_unknown, 42);
    }
  });

  it("accepts temperature as a reserved/unsupported field without runtime threading", () => {
    // The CLI does not accept --temperature today (PI_CLI_COMPATIBILITY_EVIDENCE).
    // The schema must continue to accept it so existing user configs do not break;
    // the runner separately guarantees the flag is never emitted.
    const result = parseBlackbytesConfig({
      sub_agents: { myAgent: { temperature: 0.42 } },
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.value.sub_agents?.myAgent?.temperature, 0.42);
    }
  });
});
