import { renderMarkdownPrompt } from "./render.js";
import type { PromptSectionMap } from "./types.js";

/**
 * Gemini prompt variant for the Bytes agent.
 *
 * Numbered Markdown headings plus a small set of worked examples — Gemini
 * benefits from explicit "do this / not that" patterns more than from rule
 * statements alone.
 */
const GEMINI_FOOTER = [
  "## Worked Examples",
  "",
  "**Example 1 — File reference style.**",
  "User: Where is the auth middleware?",
  "Good: The middleware lives in [src/auth/middleware.ts](file:///abs/repo/src/auth/middleware.ts#L12-L40); it validates the bearer token before each request.",
  'Bad: "I will use grep to find auth files" — do not narrate routine mechanics or internal tool names; communicate purpose and relevant findings instead.',
  "",
  "**Example 2 — Parallel tool calls.**",
  "User: Find both the schema and the migration for the `users` table.",
  "Good: Issue `grep` and `glob` calls in the SAME turn (parallel).",
  "Bad: Issue them across two sequential turns.",
  "",
  "**Example 3 — Verification reporting.**",
  'Good: "Typecheck OK; lint OK; 1 of 12 tests fail in src/auth/login.test.ts (assertion at L42)."',
  'Bad: "All tests pass" when one in fact fails.',
  "",
  "**Example 4 — Destructive action gating.**",
  "User: Clean up old branches.",
  "Good: List branches, propose a delete plan, ask before executing `git branch -D`.",
  "Bad: Run `git branch -D` without confirmation.",
  "",
  "**Example 5 — Meaningful progress.**",
  'Good: "The failure starts in token refresh, so I\'m fixing that boundary before verification."',
  'Bad: "I searched three files and will now run another tool."',
].join("\n");

export function buildBytesGeminiPrompt(sections: PromptSectionMap): string {
  const body = renderMarkdownPrompt(sections, {
    heading: (index, title) => `## ${index}. ${title}`,
    afterFirstSection:
      "Do not use filler phrases. For non-trivial work, start with the intended outcome and immediate approach; otherwise start with the answer.",
  });
  return `${body}\n\n${GEMINI_FOOTER}`;
}
