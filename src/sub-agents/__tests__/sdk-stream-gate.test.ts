import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ChildFailure, installStreamGate } from "../sdk-stream-gate.js";

type Stream = ReturnType<typeof createAssistantMessageEventStream>;
type Message = Awaited<ReturnType<Stream["result"]>>;
type Event = Parameters<Stream["push"]>[0];
// Injected public-shape stream: no SDK/AI runtime import or session/provider execution.
function errorStream(): Stream {
  const events: Event[] = [];
  let result: Message | undefined;
  return {
    push(event: Event) {
      events.push(event);
    },
    end(message?: Message) {
      result = message;
    },
    async result() {
      assert.ok(result);
      return result;
    },
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  } as unknown as Stream;
}
function fixture() {
  const model: NonNullable<AgentSession["model"]> = {
    provider: "self/provider",
    id: "literal/slash:high",
    name: "fixture",
    api: "openai-completions",
    baseUrl: "https://invalid.example",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  let calls = 0;
  let active = ["fixture_read"];
  let available = true;
  let auth = true;
  let listed = true;
  let throws = false;
  const original: AgentSession["agent"]["streamFunction"] = (...args) => {
    calls++;
    assert.equal(args[0], model);
    return errorStream();
  };
  const session = { model, agent: { streamFunction: original }, getActiveToolNames: () => active };
  const catalogue = {
    getModels: () => {
      if (throws) throw new Error("private canary");
      return listed ? [{ ...model }] : [];
    },
    getAvailableSnapshot: () => (available ? [{ ...model }] : []),
    hasConfiguredAuth: () => auth,
  };
  const gate = installStreamGate(
    session,
    catalogue,
    model,
    { model: { ...model }, allowedTools: active },
    errorStream,
    () => {},
  );
  return {
    model,
    session,
    gate,
    catalogue,
    original,
    calls: () => calls,
    tools: (v: string[]) => {
      active = v;
    },
    unavailable: () => {
      available = false;
    },
    unauth: () => {
      auth = false;
    },
    unlist: () => {
      listed = false;
    },
    explode: () => {
      throws = true;
    },
  };
}
async function refused(f: ReturnType<typeof fixture>, request = f.model) {
  const stream = await f.session.agent.streamFunction(request, { messages: [] });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal((await stream.result()).stopReason, "error");
  assert.equal(f.calls(), 0);
  assert.equal(f.gate.forwardedCount, 0);
  assert.ok(f.gate.failure);
  assert.throws(() => f.gate.open(), ChildFailure);
}
describe("managed owned stream gate (injected, no SDK sessions)", () => {
  it("allows fresh catalogue composition while preserving the ONE captured object", () => {
    const f = fixture();
    assert.notEqual(f.catalogue.getModels()[0], f.catalogue.getModels()[0]);
    f.gate.open();
    f.session.agent.streamFunction(f.model, { messages: [] });
    f.session.agent.streamFunction(f.model, { messages: [] });
    assert.equal(f.calls(), 2);
    assert.equal(f.gate.forwardedCount, 2);
    assert.equal(f.gate.failure, undefined);
  });
  it("is CLOSED before bind and refusal permanently survives later open", async () => {
    await refused(fixture());
  });
  const mutations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    "same-tuple session replacement": (f) => {
      f.session.model = { ...f.model };
    },
    "literal id mutation": (f) => {
      f.model.id = "literal/slash";
    },
    "self-provider collision": (f) => {
      f.model.provider = "other/provider";
    },
    "lost exact catalogue tuple": (f) => f.unlist(),
    "cached availability loss": (f) => f.unavailable(),
    "configured auth loss": (f) => f.unauth(),
    "unexpected lookup error": (f) => f.explode(),
    "missing active tool": (f) => f.tools([]),
    "late active tool": (f) => f.tools(["fixture_read", "fixture_write"]),
    "delegate tool": (f) => f.tools(["delegate_general"]),
    "duplicate active tool": (f) => f.tools(["fixture_read", "fixture_read"]),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    for (const stage of ["startup", "request"] as const) {
      it(`${stage}: ${name} refuses without forwarding`, async () => {
        const f = fixture();
        if (stage === "request") f.gate.open();
        mutate(f);
        await refused(f);
      });
    }
  }
  it("rejects same-tuple request replacement", async () => {
    const f = fixture();
    f.gate.open();
    await refused(f, { ...f.model });
    assert.equal(f.gate.failure?.failureKind, "provider_or_model_unavailable");
  });
  it("detects lost wrapper ownership through the retained wrapper", async () => {
    const f = fixture();
    const wrapper = f.session.agent.streamFunction;
    f.gate.open();
    f.session.agent.streamFunction = f.original;
    const stream = await wrapper(f.model, { messages: [] });
    assert.equal((await stream.result()).stopReason, "error");
    assert.equal(f.calls(), 0);
    assert.equal(f.gate.failure?.code, "wrapper_ownership");
  });
  it("replacement action refusal cannot be cleared by restoring state", async () => {
    const f = fixture();
    f.gate.open();
    f.gate.refuse("replacement_refused");
    await refused(f);
    assert.equal(f.gate.failure?.code, "replacement_refused");
  });
});
