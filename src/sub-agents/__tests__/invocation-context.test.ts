import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { THINKING_LEVELS } from "../../config/model-settings.js";
import { BlackbytesConfigSchema } from "../../config/schema.js";
import { defineSubAgent } from "../declaration.js";
import { captureInvocationContext, resolveInvocationIntent } from "../invocation-context.js";
import type { InvocationEntryContext, ModelCatalogue } from "../invocation-context.js";
import { loadYamlDeclarations } from "../loader.js";
import { resolveAgentSnapshot } from "../snapshot.js";

const declaration = defineSubAgent({
  name: "fixture",
  toolName: "delegate_fixture",
  description: "fixture",
  parameters: Type.Object({}),
  systemPrompt: "fixture",
  allowedTools: ["read"],
  buildUserPrompt: () => "fixture",
});
const config = BlackbytesConfigSchema.parse({});
const catalogue = [
  { provider: "p", id: "unique" },
  { provider: "p", id: "shared" },
  { provider: "q", id: "shared" },
  { provider: "p", id: "org/slash:0" },
  { provider: "p", id: "literal:high" },
  { provider: "p", id: "literal" },
  { provider: "q", id: "p/unique" },
];
const registry: ModelCatalogue = { getAll: () => catalogue };
// Compile-time proof against installed Pi, without constructing/loading a registry.
const compatibleContext = (ctx: ExtensionContext): InvocationEntryContext => ctx;
const compatibleCatalogue = (ctx: ExtensionContext): ModelCatalogue => ctx.modelRegistry;
void compatibleContext;
void compatibleCatalogue;
function invocation(model?: string, reasoningEffort?: string) {
  return captureInvocationContext(
    { model: catalogue[0], cwd: "/fixture" },
    resolveAgentSnapshot({ ...declaration, staticOverrides: { model, reasoningEffort } }, config),
  );
}

describe("exact invocation intent producer", () => {
  for (const [selector, provider, id, thinking] of [
    ["p/unique", "p", "unique", undefined],
    ["unique", "p", "unique", undefined],
    ["org/slash:0", "p", "org/slash:0", undefined],
    ["p/org/slash:0:high", "p", "org/slash:0", "high"],
    ["literal:high", "p", "literal:high", undefined],
    ["literal:high:low", "p", "literal:high", "low"],
    [" unique:off ", "p", "unique", "off"],
  ] as const) {
    it(`resolves ${selector} exactly with whole-ID priority`, () => {
      const result = resolveInvocationIntent(invocation(selector), registry);
      assert.deepEqual(result, {
        ok: true,
        model: { provider, id },
        selector: `${provider}/${id}`,
        reasoningEffort: thinking,
      });
      assert.ok(Object.isFrozen(result));
      if (result.ok) assert.ok(Object.isFrozen(result.model));
    });
  }
  for (const selector of ["shared", "SHARED", "uniq", "*", "p/*", "unknown", "unique:bogus"]) {
    it(`rejects ${selector} without leaking input`, () => {
      const result = resolveInvocationIntent(invocation(selector), registry);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.failureKind, "provider_or_model_unavailable");
        assert.match(result.content, /exact provider\/id/);
        assert.ok(result.content.length < 400);
      }
    });
  }
  it("explicit reasoning wins suffix; all supported levels survive without clamping", () => {
    for (const level of THINKING_LEVELS) {
      const result = resolveInvocationIntent(invocation("unique:low", ` ${level} `), registry);
      assert.ok(result.ok);
      assert.equal(result.reasoningEffort, level);
    }
  });
  it("captures identity synchronously before model switch/await and never parent thinking", async () => {
    const parent = { provider: "p", id: "unique" };
    const ctx = { model: parent, cwd: "/before", thinkingLevel: "high" };
    const snapshot = resolveAgentSnapshot(declaration, config);
    const captured = captureInvocationContext(ctx, snapshot);
    assert.equal(captured instanceof Promise, false);
    parent.id = "shared";
    ctx.cwd = "/after";
    await Promise.resolve();
    assert.deepEqual(captured.parentModel, catalogue[0]);
    assert.equal(captured.cwd, "/before");
    assert.notEqual(captured.snapshot, snapshot);
    assert.ok(Object.isFrozen(captured.snapshot.allowedToolsSummary));
    assert.equal(snapshot.model, undefined);
    const result = resolveInvocationIntent(captured, registry);
    assert.ok(result.ok);
    assert.equal(result.selector, "p/unique");
    assert.equal(result.reasoningEffort, undefined);
    const next = resolveInvocationIntent(captureInvocationContext(ctx, snapshot), registry);
    assert.ok(next.ok);
    assert.equal(next.selector, "p/shared");
  });
  it("reads the live model once and detaches nested snapshot data without freezing the source", () => {
    let reads = 0;
    const extra = { nested: { value: "before" } };
    const snap = { ...resolveAgentSnapshot(declaration, config), extra };
    const captured = captureInvocationContext(
      {
        get model() {
          reads++;
          return reads === 1 ? catalogue[0] : catalogue[1];
        },
        cwd: "/fixture",
      },
      snap,
    );
    extra.nested.value = "after";
    assert.equal(reads, 1);
    assert.deepEqual(captured.snapshot.extra, { nested: { value: "before" } });
    assert.ok(Object.isFrozen(captured.snapshot.extra.nested));
    assert.equal(Object.isFrozen(extra.nested), false);
    assert.equal(resolveInvocationIntent(captured, registry).ok, true);
  });
  it("missing parent is controlled, while overrides and explicit attempts work", () => {
    const missing = { ...invocation(), parentModel: undefined };
    assert.equal(resolveInvocationIntent(missing, registry).ok, false);
    assert.equal(resolveInvocationIntent(missing, registry, "unique").ok, true);
    assert.equal(
      resolveInvocationIntent({ ...invocation("unique"), parentModel: undefined }, registry).ok,
      true,
    );
    assert.equal(resolveInvocationIntent(missing, registry, " ").ok, false);
  });
  it("uses only getAll and bounds catalogue exceptions", () => {
    let calls = 0;
    const guarded = {
      getAll() {
        calls++;
        return catalogue;
      },
      getAvailable() {
        throw Error("forbidden");
      },
      refresh() {
        throw Error("forbidden");
      },
    };
    assert.equal(resolveInvocationIntent(invocation(), guarded).ok, true);
    assert.equal(calls, 1);
    const failed = resolveInvocationIntent(invocation(), {
      getAll() {
        throw Error("private registry details");
      },
    });
    assert.equal(failed.ok, false);
    assert.ok(!JSON.stringify(failed).includes("private registry"));
  });
});

describe("model source normalization parity", () => {
  it("JSON and direct declaration blanks inherit only after each source is normalized", () => {
    for (const blank of ["", " ", "\t\n"]) {
      const defaults = {
        ...declaration,
        staticOverrides: { model: " unique ", reasoningEffort: " low " },
      };
      const parsed = BlackbytesConfigSchema.parse({
        sub_agents: {
          fixture: { model: blank, reasoningEffort: blank, temperature: 0.2, promptMode: "append" },
        },
      });
      const snap = resolveAgentSnapshot(defaults, parsed);
      assert.equal(snap.model, "unique");
      assert.equal(snap.reasoningEffort, "low");
      const bypass = resolveAgentSnapshot(defaults, {
        ...config,
        sub_agents: { fixture: { model: blank, reasoningEffort: blank } },
      });
      assert.equal(bypass.model, "unique");
      assert.equal(bypass.reasoningEffort, "low");
      assert.equal(snap.reserved.temperature, 0.2);
      assert.equal(snap.promptMode, "append");
      assert.equal(
        resolveAgentSnapshot(
          { ...declaration, staticOverrides: { model: blank, reasoningEffort: blank } },
          config,
        ).model,
        undefined,
      );
      const direct = defineSubAgent(defaults);
      assert.equal(direct.staticOverrides?.model, "unique");
      assert.equal(direct.staticOverrides?.reasoningEffort, "low");
    }
    const snap = resolveAgentSnapshot(
      declaration,
      BlackbytesConfigSchema.parse({
        sub_agents: { fixture: { model: " p/unique ", reasoningEffort: " high " } },
      }),
    );
    assert.equal(snap.model, "p/unique");
    assert.equal(snap.reasoningEffort, "high");
  });
  it("blank fallback is invalid at schema, declaration, snapshot and invocation bypass", () => {
    for (const blank of ["", " ", "\t"]) {
      assert.equal(
        BlackbytesConfigSchema.safeParse({ sub_agents: { fixture: { fallbackModels: [blank] } } })
          .success,
        false,
      );
      const invalid = { ...declaration, staticOverrides: { fallbackModels: [blank] } };
      assert.throws(() => defineSubAgent(invalid), /non-empty/);
      assert.throws(() => resolveAgentSnapshot(invalid, config), /non-empty/);
      const entry = invocation();
      assert.equal(
        resolveInvocationIntent(
          { ...entry, snapshot: { ...entry.snapshot, fallbackModels: [blank] } },
          registry,
        ).ok,
        false,
      );
    }
    const values = [" unique "];
    const snap = resolveAgentSnapshot(
      { ...declaration, staticOverrides: { fallbackModels: values } },
      config,
    );
    values[0] = "changed";
    assert.deepEqual(snap.fallbackModels, ["unique"]);
    assert.ok(Object.isFrozen(snap.fallbackModels));
  });
  for (const hole of [0, 1, 2]) {
    it(`rejects a sparse fallback at index ${hole} across direct caller boundaries`, () => {
      const fallbackModels = ["p/unique", "p/shared", "q/shared"];
      delete fallbackModels[hole];
      const invalid = { ...declaration, staticOverrides: { fallbackModels } };
      assert.throws(() => defineSubAgent(invalid), /non-empty/);
      assert.throws(() => resolveAgentSnapshot(invalid, config), /non-empty/);
      assert.throws(
        () =>
          resolveAgentSnapshot(declaration, {
            ...config,
            sub_agents: { fixture: { fallbackModels } },
          }),
        /non-empty/,
      );
      const entry = invocation();
      const bypass = { ...entry, snapshot: { ...entry.snapshot, fallbackModels } };
      let catalogueReads = 0;
      const guardedRegistry = {
        getAll() {
          catalogueReads++;
          return catalogue;
        },
      };
      // Spreading a sparse attempt list must not turn its hole into parent inheritance.
      for (const attempt of [undefined, ...fallbackModels]) {
        const result = resolveInvocationIntent(bypass, guardedRegistry, attempt);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.failureKind, "provider_or_model_unavailable");
      }
      assert.equal(catalogueReads, 0);
    });
  }
  it("YAML blanks/trimmed settings match JSON/declaration and diagnose blank fallbacks", async () => {
    const home = await mkdtemp(join(tmpdir(), "invocation-parity-"));
    const previous = process.env.PI_AGENT_DIR;
    const official = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_AGENT_DIR = home;
    process.env.PI_CODING_AGENT_DIR = home;
    try {
      await mkdir(join(home, "sub-agents"));
      for (const [name, model, effort, fallback] of [
        ["blank", " \t", " ", undefined],
        ["trimmed", " unique ", " high ", [" p/unique "]],
        ["invalid", "unique", "off", [" "]],
      ] as const) {
        await writeFile(
          join(home, "sub-agents", `${name}.yaml`),
          JSON.stringify({
            name,
            description: "test",
            system_prompt: "test",
            allowed_tools: ["read"],
            model,
            reasoning_effort: effort,
            fallback_models: fallback,
          }),
        );
      }
      const loaded = await loadYamlDeclarations();
      assert.equal(loaded.declarations.length, 2);
      assert.match(loaded.diagnostics.skippedFiles[0].reason, /fallback_models.*non-empty/);
      const blank = loaded.declarations.find((d) => d.name === "blank");
      const trimmed = loaded.declarations.find((d) => d.name === "trimmed");
      assert.ok(blank && trimmed);
      assert.equal(resolveAgentSnapshot(blank, config).model, undefined);
      assert.equal(resolveAgentSnapshot(blank, config).reasoningEffort, undefined);
      assert.equal(trimmed.staticOverrides?.model, "unique");
      assert.equal(trimmed.staticOverrides?.reasoningEffort, "high");
      assert.deepEqual(trimmed.staticOverrides?.fallbackModels, ["p/unique"]);
      const override = BlackbytesConfigSchema.parse({
        sub_agents: { trimmed: { model: " ", reasoningEffort: " " } },
      });
      assert.equal(resolveAgentSnapshot(trimmed, override).model, "unique");
      assert.equal(resolveAgentSnapshot(trimmed, override).reasoningEffort, "high");
      const nonblank = BlackbytesConfigSchema.parse({
        sub_agents: { trimmed: { model: " p/shared ", reasoningEffort: " off " } },
      });
      assert.equal(resolveAgentSnapshot(trimmed, nonblank).model, "p/shared");
      assert.equal(resolveAgentSnapshot(trimmed, nonblank).reasoningEffort, "off");
    } finally {
      if (previous === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = previous;
      if (official === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = official;
      await rm(home, { recursive: true, force: true });
    }
  });
});
