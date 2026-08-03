#!/usr/bin/env -S node --import tsx
/**
 * Per-agent + Bytes-overlay prompt baseline snapshot.
 *
 * Writes a short report (char count, section count, top headings) for:
 *   - Every builtin sub-agent system prompt (explore/oracle/librarian/general)
 *   - The Bytes overlay rendered for each provider variant (claude/gpt/gemini/kimi-when-available)
 *
 * Used as the Phase 0 baseline before Bytes v2 rework.
 */

import { exploreDeclaration } from "../src/sub-agents/explore.js";
import { generalDeclaration } from "../src/sub-agents/general.js";
import { librarianDeclaration } from "../src/sub-agents/librarian.js";
import { oracleDeclaration } from "../src/sub-agents/oracle.js";
import { createBytesPromptRenderContext } from "../src/system-prompt/bytes/shared.js";
import { renderBytesPrompt } from "../src/system-prompt/loader.js";

interface PromptStats {
  readonly name: string;
  readonly chars: number;
  readonly sections: number;
  readonly topHeadings: string[];
}

function statsFor(name: string, prompt: string): PromptStats {
  const lines = prompt.split("\n");
  const sectionLines = lines.filter((l) => /^#{1,3} /.test(l));
  return {
    name,
    chars: prompt.length,
    sections: sectionLines.length,
    topHeadings: sectionLines.slice(0, 12),
  };
}

const subAgentDecls = [
  exploreDeclaration,
  oracleDeclaration,
  librarianDeclaration,
  generalDeclaration,
];

const subAgentStats = subAgentDecls.map((d) => statsFor(d.name, d.systemPrompt));

const FAMILIES = ["claude", "gpt", "gemini", "kimi", "other"] as const;
const overlayStats = FAMILIES.map((family) => {
  const ctx = createBytesPromptRenderContext(
    family,
    new Set(["hashline_edit", "web_search", "web_fetch", "docs_resolve", "docs_query", "gh_search"]),
    new Set(["explore", "oracle", "librarian", "general"]),
  );
  return statsFor(`bytes-overlay/${family}`, renderBytesPrompt(ctx));
});

const all = [...subAgentStats, ...overlayStats];

console.log("# Bytes / Sub-agent Prompt Baseline\n");
console.log("| Component | Chars | Sections |");
console.log("| --- | ---: | ---: |");
for (const s of all) {
  console.log(`| ${s.name} | ${s.chars} | ${s.sections} |`);
}

console.log("\n## Top headings per component\n");
for (const s of all) {
  console.log(`### ${s.name}`);
  for (const h of s.topHeadings) console.log(`- ${h.trim()}`);
  console.log();
}
