// REVIEW CANDIDATE ONLY. Loaded only by explicitly authorized isolated rehearsal.
// Legacy ordinary-services provider registration intentionally exercises recomposition.
import { writeFileSync } from "node:fs";

export default async function fixture(pi) {
  const config = globalThis[Symbol.for("blackbytes.rehearsal.config")];
  if (!config) throw new Error("fixture_sentinels_missing");
  const { createAssistantMessageEventStream } = await import(config.aiRoot);
  const counters = {
    selected: 0,
    decoy: 0,
    tools: 0,
    recomposed: false,
    sameSessionRequest: true,
    shutdown: false,
    handledInputs: 0,
  };
  let sessionModel;
  const save = () => writeFileSync(config.counterFile, JSON.stringify(counters));
  const definition = {
    id: "literal/slash:high",
    name: "Synthetic",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  for (const provider of ["fixture-selected", "fixture-decoy"]) {
    pi.registerProvider(provider, {
      baseUrl: "https://invalid.example",
      apiKey: "synthetic-fixture-value",
      api: "openai-completions",
      models: [definition],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const selected = provider === "fixture-selected";
        counters[selected ? "selected" : "decoy"]++;
        counters.sameSessionRequest &&= model === sessionModel;
        const tool = selected && counters.selected === 1;
        const message = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 0,
          content: tool
            ? [{ type: "toolCall", id: "fixture-call", name: "fixture_read", arguments: {} }]
            : [{ type: "text", text: "synthetic complete 🦊" }],
          stopReason: tool ? "toolUse" : "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        save();
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
        return stream;
      },
    });
  }
  pi.registerTool({
    name: "fixture_read",
    label: "Synthetic read",
    description: "Synthetic counter only",
    parameters: { type: "object", properties: {} },
    async execute() {
      counters.tools++;
      save();
      return { content: [{ type: "text", text: "synthetic tool" }], details: {} };
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    sessionModel = ctx.model;
    const a = ctx.modelRegistry.find("fixture-selected", "literal/slash:high");
    const b = ctx.modelRegistry.find("fixture-selected", "literal/slash:high");
    counters.recomposed = a !== b && a?.provider === b?.provider && a?.id === b?.id;
    save();
    if (config.cell === "C05") pi.sendUserMessage("synthetic startup run");
    if (config.cell === "C07") pi.setActiveTools([]);
  });
  // These regressions must NOT be accepted as success without a newly forwarded
  // assistant. They remain BLOCKED until public-runtime/ordered receipts are wired.
  pi.on("input", () => {
    if (config.variant === "handled-without-assistant" || config.variant === "handled-after-startup-refusal") {
      counters.handledInputs++;
      save();
      return { action: "handled" };
    }
  });
  pi.registerCommand("fixture_reload", {
    description: "Synthetic replacement refusal",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
  pi.on("session_shutdown", () => {
    counters.shutdown = true;
    save();
  });
  save();
}
