import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SubAgentMeta } from "../../config/resource-metadata.js";
import type { SubAgentRoutingMetadata } from "../declaration.js";
import { buildOverlayRoutingMatrix, buildRoutingSummary } from "../routing.js";

function makeMeta(name: string, routing?: SubAgentRoutingMetadata): SubAgentMeta {
  return {
    name,
    description: `${name} description`,
    promptFeatures: ["subagentDelegation"],
    routing,
  };
}

const exploreRouting: SubAgentRoutingMetadata = {
  category: "exploration",
  cost: "medium",
  useWhen: ["Broad codebase search", "Cross-file discovery"],
  avoidWhen: ["Simple grep suffices"],
  keyTrigger: "Deep contextual grep across multiple files",
};

const oracleRouting: SubAgentRoutingMetadata = {
  category: "reasoning",
  cost: "high",
  useWhen: ["Hard architecture decisions", "After 2 failed attempts"],
  avoidWhen: ["Simple questions from local code"],
  keyTrigger: "Deep analytical reasoning on hard problems",
};

describe("buildRoutingSummary", () => {
  it("returns empty string when no agents are enabled", () => {
    const metas = [makeMeta("explore", exploreRouting)];
    assert.equal(buildRoutingSummary(metas, new Set()), "");
  });

  it("filters out disabled agents", () => {
    const metas = [makeMeta("explore", exploreRouting), makeMeta("oracle", oracleRouting)];
    const result = buildRoutingSummary(metas, new Set(["explore"]));
    assert.ok(result.includes("explore"));
    assert.ok(!result.includes("oracle"));
  });

  it("sorts agents alphabetically for deterministic output", () => {
    const metas = [makeMeta("oracle", oracleRouting), makeMeta("explore", exploreRouting)];
    const result = buildRoutingSummary(metas, new Set(["explore", "oracle"]));
    const exploreIdx = result.indexOf("explore");
    const oracleIdx = result.indexOf("oracle");
    assert.ok(exploreIdx < oracleIdx, "explore should come before oracle");
  });

  it("includes category, cost, and useWhen/avoidWhen", () => {
    const metas = [makeMeta("explore", exploreRouting)];
    const result = buildRoutingSummary(metas, new Set(["explore"]));
    assert.ok(result.includes("exploration"));
    assert.ok(result.includes("medium cost"));
    assert.ok(result.includes("Broad codebase search"));
    assert.ok(result.includes("Simple grep suffices"));
  });

  it("produces placeholder for agents without routing", () => {
    const metas = [makeMeta("custom-agent")];
    const result = buildRoutingSummary(metas, new Set(["custom-agent"]));
    assert.ok(result.includes("custom-agent"));
    assert.ok(result.includes("—"));
  });

  it("includes four builtins plus a YAML fixture when all enabled", () => {
    const metas = [
      makeMeta("explore", exploreRouting),
      makeMeta("general", { ...oracleRouting, category: "implementation" }),
      makeMeta("librarian", { ...oracleRouting, category: "research" }),
      makeMeta("oracle", oracleRouting),
      makeMeta("yaml-auditor", { ...exploreRouting, category: "review" }),
    ];
    const all = new Set(["explore", "general", "librarian", "oracle", "yaml-auditor"]);
    const result = buildRoutingSummary(metas, all);
    for (const name of all) {
      assert.ok(result.includes(name), `${name} must appear in summary`);
    }
  });
});

describe("buildOverlayRoutingMatrix", () => {
  it("returns empty array when no agents enabled", () => {
    const routes = buildOverlayRoutingMatrix([makeMeta("explore", exploreRouting)], new Set());
    assert.deepEqual(routes, []);
  });

  it("produces one-line entries with key trigger", () => {
    const routes = buildOverlayRoutingMatrix(
      [makeMeta("explore", exploreRouting)],
      new Set(["explore"]),
    );
    assert.equal(routes.length, 1);
    assert.ok(routes[0].includes("explore"));
    assert.ok(routes[0].includes("Deep contextual grep"));
  });

  it("sorts alphabetically", () => {
    const routes = buildOverlayRoutingMatrix(
      [makeMeta("oracle", oracleRouting), makeMeta("explore", exploreRouting)],
      new Set(["explore", "oracle"]),
    );
    assert.equal(routes.length, 2);
    assert.ok(routes[0].includes("explore"));
    assert.ok(routes[1].includes("oracle"));
  });

  it("shows placeholder for agents without routing", () => {
    const routes = buildOverlayRoutingMatrix([makeMeta("custom")], new Set(["custom"]));
    assert.equal(routes.length, 1);
    assert.ok(routes[0].includes("custom agent"));
  });
});
