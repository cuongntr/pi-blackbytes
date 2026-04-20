import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUNDLED_TOOLS,
  SUB_AGENTS,
  TOOL_GROUPS,
  derivePromptFeatureFlags,
} from "../../config/resource-metadata.js";
import type { PromptFeatureKey } from "../../config/resource-metadata.js";
import { createBytesPromptRenderContext } from "../bytes/shared.js";
import { renderBytesPrompt } from "../loader.js";

const CAPABILITY_SNIPPETS: Record<PromptFeatureKey, string> = {
  hashlineEdit: "Hashline Edit Workflow",
  subagentDelegation: "Delegate when specialization materially reduces",
  documentationLookup: "Documentation lookup may be available",
  githubCodeSearch: "GitHub code search may be available",
  webSearch: "Web lookup capabilities may be available",
};

function resourcesForFeature(feature: PromptFeatureKey): {
  tools: Set<string>;
  subAgents: Set<string>;
} {
  const tools = new Set<string>();
  const subAgents = new Set<string>();

  for (const tool of BUNDLED_TOOLS) {
    if (tool.promptFeatures?.includes(feature)) {
      tools.add(tool.name);
    }
  }

  for (const group of TOOL_GROUPS) {
    if (group.promptFeatures?.includes(feature)) {
      for (const toolName of group.tools) {
        tools.add(toolName);
      }
    }
  }

  for (const agent of SUB_AGENTS) {
    if (agent.promptFeatures?.includes(feature)) {
      subAgents.add(agent.name);
    }
  }

  return { tools, subAgents };
}

function renderPromptForFeature(feature: PromptFeatureKey): string {
  const resources = resourcesForFeature(feature);
  return renderBytesPrompt(
    createBytesPromptRenderContext("claude", resources.tools, resources.subAgents),
  );
}

describe("prompt-to-runtime capability sync", () => {
  it("has metadata-backed resources for every prompt feature", () => {
    for (const feature of Object.keys(CAPABILITY_SNIPPETS) as PromptFeatureKey[]) {
      const resources = resourcesForFeature(feature);
      assert.ok(
        resources.tools.size > 0 || resources.subAgents.size > 0,
        `${feature} should be backed by resource metadata`,
      );
    }
  });

  it("derives feature flags from authoritative metadata-backed resources", () => {
    const tools = new Set<string>();
    const subAgents = new Set<string>();

    for (const feature of Object.keys(CAPABILITY_SNIPPETS) as PromptFeatureKey[]) {
      const resources = resourcesForFeature(feature);
      for (const tool of resources.tools) tools.add(tool);
      for (const agent of resources.subAgents) subAgents.add(agent);
    }

    const flags = derivePromptFeatureFlags(tools, subAgents);
    assert.deepEqual(flags, {
      hashlineEdit: true,
      subagentDelegation: true,
      documentationLookup: true,
      githubCodeSearch: true,
      webSearch: true,
    });
  });

  it("renders hashline guidance only when hashline metadata-backed resources are enabled", () => {
    const prompt = renderPromptForFeature("hashlineEdit");
    assert.ok(prompt.includes(CAPABILITY_SNIPPETS.hashlineEdit));

    const withoutHashline = renderBytesPrompt(
      createBytesPromptRenderContext("claude", new Set<string>(), new Set<string>()),
    );
    assert.ok(!withoutHashline.includes(CAPABILITY_SNIPPETS.hashlineEdit));
  });

  it("renders delegation guidance only when delegation-backed sub-agents are enabled", () => {
    const prompt = renderPromptForFeature("subagentDelegation");
    assert.ok(prompt.includes(CAPABILITY_SNIPPETS.subagentDelegation));

    const withoutDelegation = renderBytesPrompt(
      createBytesPromptRenderContext("claude", new Set<string>(), new Set<string>()),
    );
    assert.ok(!withoutDelegation.includes(CAPABILITY_SNIPPETS.subagentDelegation));
  });

  it("renders documentation lookup guidance only when docs-backed resources are enabled", () => {
    const docsPrompt = renderPromptForFeature("documentationLookup");
    assert.ok(docsPrompt.includes(CAPABILITY_SNIPPETS.documentationLookup));

    const webPrompt = renderPromptForFeature("webSearch");
    assert.ok(!webPrompt.includes(CAPABILITY_SNIPPETS.documentationLookup));
  });

  it("renders web lookup guidance only when web-backed resources are enabled", () => {
    const webPrompt = renderPromptForFeature("webSearch");
    assert.ok(webPrompt.includes(CAPABILITY_SNIPPETS.webSearch));

    const docsPrompt = renderPromptForFeature("documentationLookup");
    assert.ok(!docsPrompt.includes(CAPABILITY_SNIPPETS.webSearch));
  });

  it("renders GitHub code search guidance only when grep_app metadata-backed resources are enabled", () => {
    const prompt = renderPromptForFeature("githubCodeSearch");
    assert.ok(prompt.includes(CAPABILITY_SNIPPETS.githubCodeSearch));

    const withoutCodeSearch = renderPromptForFeature("documentationLookup");
    assert.ok(!withoutCodeSearch.includes(CAPABILITY_SNIPPETS.githubCodeSearch));
  });
});
