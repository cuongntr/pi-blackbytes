import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { declarationToMeta, defineSubAgent } from "../declaration.js";

describe("declarationToMeta", () => {
  it("copies routing metadata to SubAgentMeta", () => {
    const decl = defineSubAgent({
      name: "test-agent",
      toolName: "delegate_test_agent",
      description: "A test agent",
      parameters: Type.Object({ prompt: Type.String() }),
      systemPrompt: "You are a test agent.",
      allowedTools: ["read"],
      buildUserPrompt: (p: { prompt: string }) => p.prompt,
      routing: {
        category: "exploration",
        cost: "medium",
        useWhen: ["Test scenario"],
        avoidWhen: ["Not needed"],
        keyTrigger: "Testing",
      },
    });

    const meta = declarationToMeta(decl);
    assert.equal(meta.name, "test-agent");
    assert.ok(meta.routing);
    assert.equal(meta.routing!.category, "exploration");
    assert.equal(meta.routing!.cost, "medium");
    assert.deepEqual(meta.routing!.useWhen, ["Test scenario"]);
    assert.deepEqual(meta.routing!.avoidWhen, ["Not needed"]);
    assert.equal(meta.routing!.keyTrigger, "Testing");
  });

  it("returns undefined routing when declaration has no routing", () => {
    const decl = defineSubAgent({
      name: "no-routing",
      toolName: "delegate_no_routing",
      description: "Agent without routing",
      parameters: Type.Object({ prompt: Type.String() }),
      systemPrompt: "You are a test agent.",
      allowedTools: ["read"],
      buildUserPrompt: (p: { prompt: string }) => p.prompt,
    });

    const meta = declarationToMeta(decl);
    assert.equal(meta.routing, undefined);
  });
});
