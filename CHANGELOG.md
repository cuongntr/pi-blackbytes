# Changelog

## 2.5.0 (2026-05-15)

Compatibility release for Pi's package-scope migration to `@earendil-works/*`.

### Changed

- Migrated all Pi imports and package metadata from `@mariozechner/*` to
  `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.
- Updated peer dependencies to require Pi `>=0.74.0 <1` and refreshed both
  Bun and npm lockfiles.
- Updated CI to install the new Pi packages under the `@earendil-works` scope.
- Updated nested-Pi compatibility evidence for Pi `0.74.0` and the current
  `--mode json` invocation.

### Fixed

- Wrapped `hashline_edit` file mutations in Pi's `withFileMutationQueue()` so
  edits participate in Pi's parallel-tool per-file mutation queue.
- Queued both source and destination paths for `hashline_edit` rename/move
  operations to avoid races with concurrent writes to the destination.

## 2.4.0 (2026-05-12)

Removes the `handoff` tool and extracts the sub-agent progress reporter into
a shared module.

The `handoff` tool spawned a fresh nested Pi session when context was "near
capacity." In practice, the trigger relied entirely on LLM self-diagnosis of
context exhaustion — a condition models cannot reliably detect — and the
auto-distilled 4 KB summary rarely preserved enough context for meaningful
continuation. `delegate_general` covers the concrete-implementation use case
with stronger safety overlays, delegation logging, and fallback chains;
for everything else, starting a new conversation is simpler and more reliable.

### Removed

- **`handoff` tool** (`src/tools/handoff/`): deleted implementation,
  registration, and tests. `TOOL_NAMES.HANDOFF` removed from
  `resource-metadata.ts`; `BUNDLED_TOOLS` drops from 6 to 5 entries;
  `ALL_TOOL_NAMES` drops from 11 to 10.
- **`handoff_protocol` prompt section**: removed from the Bytes v2 overlay
  (14 sections, down from 15), `PromptSectionKey`, `PromptFeatureFlags`,
  section ordering, and all four provider-variant tag maps.

### Changed

- **Progress reporter extracted** (`src/sub-agents/progress-reporter.ts`):
  `createProgressReporter()`, `SubAgentProgressStatus`,
  `SubAgentProgressDetails`, `SubAgentProgressUsage`, `ToolHistoryEntry`,
  and all supporting helpers moved out of `register.ts` into a dedicated
  module. `register.ts` and `render.ts` import from the new location.
- **`buildBytesPromptOverlay()`** simplified to a single `return [...]`
  array now that the conditional handoff section no longer splits the list.
- Documentation (`README.md`, `AGENTS.md`) updated to reflect the current
  tool surface (10 tools, 14 prompt sections), adds the previously missing
  `look_at` entry in the bundled-tools table, and corrects the
  `createProgressReporter` source location.

### Tests

- `enabled-set.test.ts`: tool count assertions updated (11→10, 9→8);
  `handoffEnabled` removed from all `derivePromptFeatureFlags` expectations.
- `bytes-capability-sync.test.ts`: `handoffEnabled` removed from expected
  feature flags.

## 2.3.0 (2026-05-05)

Removes the extension's bundled `grep` tool. Pi's built-in `grep` (available
since Pi 0.67) provides equivalent ripgrep-backed content search with regex,
glob filtering, context lines, and result limits. Sub-agents continue to
receive `grep` in their tool allowlists — it resolves to Pi's built-in
implementation via `PI_BUILTIN_TOOLS`.

### Removed

- **Extension `grep` tool** (`src/tools/grep/`): deleted implementation,
  registration, and tests. `TOOL_NAMES.GREP` removed from
  `resource-metadata.ts`; `BUNDLED_TOOLS` drops from 7 to 6 entries;
  `ALL_TOOL_NAMES` drops from 12 to 11.

### Changed

- Sub-agent declarations (`explore`, `oracle`, `reviewer`, `librarian`,
  `general`) reference `"grep"` as a literal Pi built-in instead of
  `TOOL_NAMES.GREP`.
- Documentation (`README.md`, `AGENTS.md`) updated to reflect the current
  tool surface, peer dependencies (`^0.69.0`, `typebox@*`), and dependency
  list (`zod`, `fast-glob`, `yaml`).

### Tests

- `delegable-tools.test.ts`: `isDelegableTool("grep")` moved from the
  "extension tools" test to the "Pi built-ins" test.
- 14 test files updated to replace extension-grep references with other
  extension tool names in mock data and assertions.
- Total: 592 tests passing in 103 suites.

---

## 2.2.0 (2026-05-03)

Minor release that consolidates the delegation surface (merging
`code-tour` into Explore Tour Mode), streamlines the Bytes overlay,
and adds session-scoped delegation ROI tracking.

### Added

- **Delegation ROI log** (`src/sub-agents/delegation-log.ts`): in-memory,
  session-scoped log tracking per-delegation metrics (agent, duration,
  success, tool call count, output size, cost). `getDelegationSummary()`
  produces per-agent aggregates (call count, success rate, avg duration,
  accumulated cost). Log resets via `resetDelegationLog()`, called from
  `resetSessionRuntimeState()`. New `/blackbytes-status` section
  **Delegation ROI** (#4 in the picker) surfaces the summary.
- **Explore Tour Mode**: `delegate_explore` handles guided flow
  walk-throughs directly. The system prompt includes a **Tour Mode**
  section; when the question asks how a flow works (entry → handler →
  side-effect), the agent responds with a one-line summary + numbered
  `[relpath#L-L](file:///abs/path#L-L) — what · why` steps.
- **Explore `context` parameter**: optional `context` string scopes the
  search or tour (specific files, modules, constraints).

### Removed

- **`code-tour` sub-agent** (`src/sub-agents/code-tour.ts`): deleted.
  Flow walk-through capability is now handled by Explore Tour Mode.
  Removed from `BUILTIN_DECLARATIONS`, `SUB_AGENTS` metadata,
  `SUB_AGENT_ICONS`, and all test hardcoded agent-name lists.
- **`codeTour` capability flag**: removed `codeTour` from
  `ByteCapability` / `PromptFeatureFlags`. The overlay no longer
  gates a separate code-tour bullet.
- **`final_status_spec` prompt section**: merged into
  `completion_contract`. Removed the key from `PromptSectionKey`,
  `SECTION_ORDER`, and `CLAUDE_TAGS`.
- **GPT Verification Gates footer**: removed the explicit
  "1. Typecheck, 2. Lint, 3. Tests, 4. Build" footer from `gpt.ts`.
  Verification rules remain in the shared `verification_contract`
  overlay section.

### Changed

- **Overlay delegation guidance streamlined**: replaced verbose
  per-agent gating rules (General strict gate, Librarian strict gate,
  keyword-trigger block) with a concise positive routing matrix.
  Each enabled agent gets a single-line routing hint; detailed
  anti-pattern rules live in the respective declaration descriptions.
  Net overlay size reduced.
- **Explore description updated**: tool description mentions flow
  walk-throughs and the `context` parameter.
- **`/blackbytes-status` picker expanded**: 10 sections (was 9).
  New section #4 "Delegation ROI" inserted; subsequent sections
  renumbered.

### Tests

- New `src/sub-agents/__tests__/delegation-log.test.ts` (10 tests).
- Librarian gating fixture checks updated: L1–L4 and L6 now check
  declaration description only (guidance moved to descriptions).
- Overlay tests updated for streamlined routing matrix and removed
  sections.
- All hardcoded agent-name lists updated across 5 test files.
- Total: 600 tests passing in 105 suites.

---

## 2.1.0 (2026-05-02) — Bytes v2 Phase 4

This is a **minor, additive** release on top of v2.0.0. It ships three of
the four "Phase 4 — New capabilities" items that were deferred from
v2.0.0 — `handoff`, `code-tour`, and `look_at`. The fourth item
(`bytes_todo`) was implemented and then removed before release; see
**Removed** below for the rationale. Nothing from v2.0.0 changes;
capabilities are gated behind feature flags and only appear in the Bytes
overlay when the backing tool / sub-agent is enabled.

### Added

- **`handoff` tool** (`src/tools/handoff/`): spawns a fresh nested `pi -p`
  session via the existing `runNestedPi()` helper with a self-contained
  `goal`, optional `mode` hint, and optional `prior_summary` (capped at
  4 KB and run through `redactSecrets`). When `ctx.sessionManager` is
  reachable in Pi's tool-execute callback, the tool also auto-distills
  the last 10 message entries of the current branch (4 KB cap, redacted)
  and embeds them under a separate "Auto-distilled prior summary"
  section. The nested session does NOT inherit the parent transcript
  otherwise. Recursive handoff is automatically refused inside an
  already-nested session via the `PI_NESTED_DEPTH >= 1` guard. The user
  abort signal is forwarded so cancelling the parent kills the nested
  Pi. Default timeout 30 minutes. New Bytes overlay section
  `handoff_protocol` (~600 chars) gated behind the `handoffEnabled`
  feature flag — disabling the tool removes the section.
- **`code-tour` sub-agent** (`src/sub-agents/code-tour.ts`): read-only
  guided walk-through agent. Allowed tools: `read`, `grep`, `glob`,
  `ast_search`. Returns a one-line summary plus a numbered list of
  `[relpath#L-L](file:///abs#L-L) — what · why` steps using fluent
  `file://` links. Output spec, scope discipline, and method match the
  Amp finder reference style. Icon `🧭`, `delegate_code_tour` tool,
  `medium` reasoning effort, 10-minute timeout. New
  `delegate_code_tour` bullet in the conditional-workflows section gated
  on `enabledSubAgents.has("code-tour")`.
- **`look_at` tool** (`src/tools/look-at/`): real multimodal tool —
  pre-check confirmed `AgentToolResult.content` accepts
  `(TextContent | ImageContent)[]` in `@mariozechner/pi-coding-agent`
  v0.69. Loads a primary image plus up to 3 reference images (PNG, JPEG,
  GIF, WebP, BMP, SVG; 10 MB max each), embeds them as base64
  `ImageContent` blocks, and prepends a text block with the analysis
  objective and resolved paths. No prompt overlay change — model already
  knows how to consume image content blocks.
### Removed

- **`bytes_todo` tool** (was at `src/tools/bytes-todo/`): the
  lightweight in-memory task list shipped in a pre-release of v2.1.0
  was removed before the v2.1.0 cut. Rationale: (a) modern reasoning
  models (Claude extended thinking, GPT-5 reasoning, Gemini thinking)
  plan internally without an external scratchpad; (b) project users
  rely on richer external task systems (`beads`, Jira, Linear) that
  persist, support dependency graphs, and survive process restarts —
  `bytes_todo`'s module-level state was reset on every extension
  reload; (c) the tool added ~480 tokens of permanent overhead (schema
  + overlay section + capability bullet) per session whether or not it
  was used; (d) the `runner.ts` `--no-session --no-context-files`
  contract meant sub-agents could never see the parent's todo list,
  capping its real value to a single agent's working memory. Net
  effect: dead weight that signalled "use this" while the maintainer
  could not recommend it. Removed surfaces: tool registration
  (`registerBytesTodoTool` in `src/handlers/index.ts`), `BYTES_TODO`
  in `TOOL_NAMES`, `taskListEnabled` flag in `PromptFeatureFlags`,
  `task_list_protocol` `PromptSectionKey`, the matching
  `SECTION_ORDER`/`CLAUDE_TAGS` entries, and the
  `buildTaskListProtocolBody` + capability bullet in `overlay.ts`.
  Disabling-by-config is no longer needed because the tool is gone.
  Test count: 587 passing in 102 suites (was 594 / 103 with
  `bytes_todo` shipped).

### Documentation

- **`gh_search` framing clarified.** Previous wording in `README.md` and
  `AGENTS.md` ("replaces websearch, context7, and grep.app **MCP
  surfaces** with **direct HTTP tools**") was ambiguous about whether
  the wire protocol was also being replaced. Reality: `web_search` /
  `web_fetch` (Exa, Tavily) and `docs_resolve` / `docs_query`
  (Context7) are pure REST clients — no MCP involved. `gh_search` is
  also locally-managed (no Pi MCP plugin needed) but the upstream
  `mcp.grep.app` service still speaks MCP-over-HTTP, so the extension
  ships an in-process `McpHttpClient` for that one tool. New wording
  makes the two flavors explicit and adds a note in `README.md` for
  anyone debugging requests.
- **`glob` recency-sort rationale documented.** The `glob` tool sorts
  results by `mtime` descending (newest first) and shows the top 25 of
  up to 1000 scanned. This was previously documented only as "newest
  matching file paths" without rationale or escape hatch. New
  description spells out: (a) why the recency bias is intentional
  (coding-agent workflows mostly care about currently-edited files);
  (b) when it is *not* what you want (stable lexical enumeration); and
  (c) the recommended alternative (`find` / `ls` Pi built-ins, or
  `grep --files-with-matches`). No behavior change — just clearer
  contract for the calling LLM.

### Fixed

- **`handoff` capability-gating consistency.** The `handoff` tool was
  passing `allowedTools: []` to `runNestedPi()`, which made the runner
  omit the `--tools` flag entirely. Pi's CLI default with no `--tools`
  is to expose the full built-in tool surface to the nested session
  (`bash`, `edit`, `write`, etc.). This was inconsistent with sub-agent
  delegates (`explore`, `oracle`, `librarian`, `general`, `reviewer`,
  `code-tour`), which have always computed and passed an explicit
  allowlist via `finalizeNestedTools()`. The user-visible effect was
  that `disabled_tools` config did not propagate into nested handoff
  sessions: if a user disabled e.g. `bash` in
  `~/.pi/agent/settings.json` to keep the agent away from shell
  commands, the agent could still invoke `bash` from inside a
  `handoff` nested session. Not a security boundary (the LLM is the
  one making the decision in both cases, not an untrusted attacker)
  but a **policy-correctness and architectural-consistency bug**:
  config-level intent should propagate uniformly across all nested
  execution paths. Fix: `handoff/tool.ts` now derives its nested
  allowlist using the same pattern as `general.ts` — parent's enabled
  extension tools (minus `delegate_*`) plus `PI_BUILTIN_TOOLS`, run
  through `finalizeNestedTools` with `full-access` mutability so the
  global `disabled_tools` denylist propagates and `delegate_*` names
  are stripped at the allowlist layer (defense-in-depth on top of the
  existing `PI_NESTED_DEPTH` recursion guard). Three new boundary
  regression tests in `src/tools/handoff/__tests__/handoff.test.ts`
  now pin: (a) parent enabled tools + Pi built-ins propagate to nested
  allowlist; (b) `disabled_tools` is honored end-to-end; (c)
  `delegate_*` is excluded. Production paths via `session_start`
  always go through `getEnabledSet()`; isolated unit tests can inject
  a stub via `getEnabledSetFn`. Test count: 590 passing in 102 suites
  (was 587).

### Changed

- **`general` sub-agent gating tightened** (mirrors the Phase 1.6
  Librarian gating fix). Previously `delegate_general` accepted nearly
  any "implementation" task, including small single-file edits and
  exploratory work that the host agent could finish faster directly.
  Now both the tool description (`src/sub-agents/general.ts`) and the
  Bytes overlay bullet (`src/system-prompt/bytes/overlay.ts`,
  conditional-workflows section) require ALL of: (a) a concrete plan
  (file paths + intended changes known up front, no exploration
  needed); AND (b) work large enough to justify nested-Pi cost (~5+
  file edits OR ~20K+ tokens of read/edit/verify churn); AND (c)
  outcome independently verifiable (tests, diff, lint). An explicit
  `DO NOT use for` denylist covers single-file edits, exploratory or
  ambiguous tasks, work needing mid-stream parent feedback, and plans
  that must evolve as you read code. The `general` persona prompt also
  gained a `Plan-Sanity Check` guardrail that runs before any other
  tool call: if the brief lacks concrete file paths or specifies only
  goal-level intent, the sub-agent returns early with a "Plan too
  vague" diagnostic instead of starting to explore. Rationale: the
  legitimate value of `general` is **context-window offload** for
  parent agents working on long sessions, not "do something the host
  cannot". The strict gate aligns prompt with that real value
  proposition.

### Bytes overlay

- New `PromptSectionKey` value `handoff_protocol` in
  `src/system-prompt/bytes/types.ts`, threaded through `SECTION_ORDER`
  (`render.ts`) and `CLAUDE_TAGS` (`default.ts`).
- New feature flag `handoffEnabled` in `PromptFeatureFlags`, derived in
  `derivePromptFeatureFlags()` from `enabledTools.has(TOOL_NAMES.HANDOFF)`.
- Capability bullets added to `buildSessionCapabilitiesBody()` and the
  conditional-workflows section for `code-tour` and `handoff`. All
  bullets are gated on the matching feature / sub-agent flag, so
  disabling the tool/agent fully removes the prompt mention. The
  capability-sync test in `bytes-capability-sync.test.ts` continues to
  enforce this without code changes.
- Total rendered overlay size: still under the 12 KB budget.

### Tests

- 11 new tests across:
  - `src/tools/handoff/__tests__/handoff.test.ts` (6 tests)
  - `src/tools/look-at/__tests__/look-at.test.ts` (5 tests)
- Six existing test files updated per AGENTS.md (`code-tour` added to the
  hardcoded agent-name lists in `bytes-overlay.test.ts`,
  `before-agent-start.test.ts`, `blackbytes-status.test.ts`,
  `setup-models.test.ts`, `enabled-set.test.ts`, plus expected counts in
  `enabled-set.test.ts` for new bundled tools and sub-agents).
- Total test count: 587 passing in 102 suites (was 574 / 100 at v2.0.0
  cut).

### Versioning

This is `2.1.0` (semver minor, additive). No breaking changes from v2.0.0:
- Disabling any of the three new tools/agents removes them and their prompt
  bullets cleanly.
- Existing config files keep working unchanged. Configs that disabled
  `bytes_todo` via `disabled_tools` will continue to load — `disabled_tools`
  silently ignores unknown names.
- Tool names follow snake_case (`handoff`, `look_at`) and are registered
  in `TOOL_NAMES` in `src/config/resource-metadata.ts`.

## 2.0.0 (2026-05-02) — Bytes v2

This is a **major** release that overhauls Bytes system prompts and sub-agent
behaviour to bring them closer to AmpCode-grade quality, and **fixes the main
pain point**: Librarian was previously over-eager to fire on phrases like
"research" / "tìm hiểu" / "investigate" even for trivial single-source lookups.

### Migration guide (breaking changes)

1. **Explore output format changed** from custom XML wrappers
   (`<results>`, `<files>`, `<answer>`, `<next_steps>`) to plain Markdown with
   fluent `file://` links. If you had downstream code that parsed the XML
   format you must switch to parsing the Markdown bullet list. The new shape:

   ```text
   <one- to two-sentence summary>

   - [src/auth/login.ts#L42-L80](file:///abs/repo/src/auth/login.ts#L42-L80) — short reason
   - …

   <optional 1-line next step>
   ```

2. **Bytes overlay grew** from ~4.3 KB to ~10–11 KB rendered (still under the
   12 KB budget). Sections added:
   - `identity`
   - `autonomy_and_persistence`
   - `investigate_before_acting`
   - `tool_use_protocol`
   - `verification_contract`
   - `executing_actions_with_care`
   - `markdown_format`
   - `file_references`
   - `final_status_spec`

   The legacy XML wrapper tag `<agency>` (Claude variant) was renamed to
   `<precedence>` to match the section key. If you scraped the prompt for
   `<agency>` you must update to `<precedence>`.

3. **New `kimi` model family.** `model.family` may now be `"kimi"` for
   Kimi/Moonshot models. The default routing remains `claude → default.ts`,
   `gpt → gpt.ts`, `gemini → gemini.ts`, plus the new `kimi → kimi.ts`.

4. **Librarian gating is now strict.** Calls that previously succeeded on
   single-URL fetches, single-library docs lookups, single-GitHub searches,
   or local-codebase questions are now explicitly listed as anti-patterns in
   both the tool description and the Bytes overlay. See "Phase 1.6" below.

### Phase 0 — Baseline

- Added `scripts/snapshot-prompts.ts`: dumps per-agent character count,
  section count, and top headings for every builtin sub-agent + every Bytes
  overlay variant. Used as the v1 → v2 baseline.
- Added 6 librarian-gating fixtures (L1–L6) in
  `src/sub-agents/__tests__/librarian-gating.test.ts`. Each fixture exercises
  a representative request and asserts the rendered guidance + tool
  description correctly classify it as `delegate` or `direct`. All 6
  fixtures pass after the Phase 1.6 fix.
- Baseline metrics (rendered chars):
  - Pre-rework: claude/other 4317, gpt 4342, gemini 4224, kimi n/a.
  - Post-rework: claude/other 10111, gpt 10430, gemini 10636, kimi 9853.
  - Gzip package size: 107 KB (well under 500 KB budget).

### Phase 1.6 — Librarian gating hardening (PRIORITY pain-point fix)

- **`librarianDeclaration.description`** rewritten with the strict template:
  - ALL of (a) external information not in repo, (b) MULTIPLE independent
    sources or current-year answer, (c) direct tools each insufficient.
  - Explicit `DO NOT use for` denylist (≥5 cases): single URL fetch, single
    library docs lookup, single GitHub search, local-codebase questions,
    trivial facts.
  - Cost signal: ~5–10× more tokens and latency than a direct tool call.
- **Bytes overlay**: removed the loose keyword-trigger block that previously
  let phrases like `"research" / "tìm hiểu" / "tra cứu" / "investigate"`
  fire `librarian` on their own. Replaced with the same strict (a)+(b)+(c)
  gate plus an explicit "keyword triggers are NOT sufficient by themselves"
  reminder.
- **Cost signal in Session Capabilities**: every `delegate_*` call now
  carries an explicit "~5–10× more tokens and latency than a direct tool
  call — prefer direct tools when 1–2 calls suffice" warning when delegation
  is enabled.

### Phase 1.1–1.4 — Bytes overlay upgrade

- Added `identity`, `autonomy_and_persistence`, `investigate_before_acting`,
  `tool_use_protocol`, `verification_contract`,
  `executing_actions_with_care`, `markdown_format`, `file_references`,
  `final_status_spec` sections — each adapted from the Amp Smart QT4
  reference and trimmed for compactness.
- `verification_contract` introduces a typecheck → lint → test → build gate
  order, faithful-reporting rule, and explicit "do not hard-code expected
  values to satisfy a test" rule.
- `tool_use_protocol` codifies parallel tool calls, the `cwd` parameter
  rule, the `rg`-over-`grep` preference, and the "do not refer to tools by
  name in user prose" rule.
- `file_references` documents the fluent `file://` link form with
  URL-encoding rules.
- `final_status_spec` gives a 2–10 line completion report shape.

### Phase 1.5 — 4 provider variants

- `default.ts` (Claude) now wraps each section in semantic XML tags
  (`<identity>`, `<precedence>`, `<verification>`, `<engineering>`,
  `<workflow>`, `<completion>`, etc.).
- `gpt.ts` appends explicit **Verification Gates** (1. Typecheck, 2. Lint,
  3. Tests, 4. Build) and a **Parallel Execution Policy** footer.
- `gemini.ts` appends 4 worked examples (file-reference style, parallel
  tool calls, verification reporting, destructive-action gating).
- **NEW** `kimi.ts` for Kimi/Moonshot models — terse markdown,
  instruction-dense, no worked examples.
- `loader.ts` routing now covers all 5 families: `claude`, `gpt`, `gemini`,
  `kimi`, `other` (defaults to claude renderer).

### Phase 2 — Sub-agent polish

- **Explore (BREAKING)**: legacy XML output (`<results>/<files>/<answer>/
  <next_steps>`) replaced with Markdown + fluent `file://` links. New
  guidance: ≥6 parallel tool calls per turn when scope is wide, complete
  within 3 turns, prefer source code over docs, scope globs aggressively
  (`core/**/*x*` not `**/*x*`).
- **Oracle**: prepended an "IMPORTANT — Self-contained final message"
  preamble (only the last message returns to the caller). Added fluent
  `file://` link rule. Effort estimate template (Quick/Short/Medium/Large)
  preserved unchanged — that's still a strength.
- **Reviewer**: caller MUST pre-fetch with
  `git diff --merge-base origin/HEAD HEAD` and pass the diff in `context`
  (Reviewer remains read-only, no `bash`/`git` in allowlist). Added abort
  rule for >100 files / >10 K lines, abstraction-fit evaluation
  (over-/under-abstraction), and a runtime `console.warn` when
  `delegate_reviewer` is invoked with empty/short `context`.
- **General**: added a `### Hard Rules` line: "Verification gate order:
  typecheck → lint → test → build — use AGENTS.md commands; report counts
  honestly".
- **Librarian**: added Local File References section with the fluent
  `file://` link form for repo files (external citations remain on the
  GitHub permalink / official docs URL form).

### Phase 3 — UX & communication (folded into Phase 1)

- Channel separation, Markdown strict rules, and final-status spec all live
  in the Bytes overlay sections (`final_status_spec`, `markdown_format`,
  `work_defaults`).

### Phase 4 — New capabilities (shipped in v2.1.0)

The following items were scoped under v2.0.0 but explicitly deferred to a
follow-up minor release. Three of the four are shipped in v2.1.0 (see the
v2.1.0 section above for details); the fourth was implemented and then
removed before the v2.1.0 cut:

- `handoff` tool (spawn nested `pi -p` with fresh context).
- `code-tour` sub-agent (read-only numbered file:line walkthrough).
- `look_at` tool (multimodal — Pi platform multimodal verified supported).
- ~~`bytes_todo` lightweight in-memory TODO list~~ — **removed before
  v2.1.0**. Modern reasoning models plan internally; users with serious
  task-tracking needs use external systems (`beads`, Jira, Linear). See
  the v2.1.0 **Removed** section for details.

### Tests

- 13 new tests in `src/sub-agents/__tests__/librarian-gating.test.ts`
  (description gate + overlay gate + 6 fixtures L1–L6).
- Existing `delegates.test.ts` librarian assertions updated to the new
  (a)(b)(c) + denylist contract.
- Existing `bytes-overlay.test.ts` librarian-trigger assertions updated for
  the new strict gating wording.
- `loader.test.ts` XML-tag assertion updated from `<agency>` to
  `<identity>` / `<precedence>` / `<verification>`.

### Tooling

- New `scripts/snapshot-prompts.ts` (run with `node --import tsx
  scripts/snapshot-prompts.ts`) prints per-agent + per-overlay-variant
  character / section / heading stats.

## 0.2.12 (2026-04-30)

### Added

- **Configurable `executionMode` per agent**: sub-agents can now be configured as `"sequential"` or `"parallel"` via `sub_agents.<name>.executionMode` in `settings.json` or `execution_mode` in YAML declarations. Default is `undefined` (Pi parallel), preserving the ability to run multiple `delegate_general` calls concurrently during plan/bead implementation.
- **YAML runtime overlay parity**: YAML-defined sub-agents now receive the same runtime overlay (current date, working directory, finalized tool list) as builtin agents via `prependSystemPrompt`.
- **Accurate finalized-tools snapshot**: `AgentSnapshot.allowedToolsSummary` and `fallbackEligible` are now computed from finalized tools (after applying `disabled_tools` and mutability policy) instead of raw declaration tools. Added `droppedTools` field with diagnostic breakdown.
- **Final progress details on tool result**: the `details` field (status, cost, latency, tool history, model) is now included in the final tool result, not just in progress updates. Error paths also emit `status: "failed"` details so the renderer no longer incorrectly shows them as completed.
- **Centralized secret redaction**: merged redaction patterns from `runner.ts` and `general-safety-overlay.ts` into `src/shared/redact.ts`. Setup-time error messages are now redacted before surfacing.

### Changed

- **Nested sessions skip parent overlay**: `injectPromptAugmentation()` returns the system prompt unchanged when `PI_NESTED_DEPTH >= 1`, preventing nested LLMs from seeing `delegate_*` tool references they cannot use. Nested agents already receive their own runtime overlay from `prependSystemPrompt`.

### Tests

- Added 14 new tests: redaction patterns (8), finalized-tools snapshot (3), executionMode config resolution (2), snapshot executionMode precedence (1).

## 0.2.11 (2026-04-30)

### Changed

- **Librarian activation scope**: softened the Bytes prompt overlay and `delegate_librarian` tool description to avoid over-delegating simple or local requests. Librarian is now framed for non-trivial external research that needs multiple sources, current docs/changelog verification, public code examples, library internals, or conflict reconciliation.
- **Direct lookup guidance**: simple one-hop docs/web/GitHub lookups now prefer direct tools when available, while local codebase exploration stays on local tools instead of `delegate_librarian`.

### Tests

- Updated librarian prompt regression tests to cover the narrower trigger wording and direct-tool availability guard.

## 0.2.10 (2026-04-29)

### Changed

- **Migrate `@sinclair/typebox` → `typebox`**: replaced all imports from `@sinclair/typebox` (v0.33) with the `typebox` package (v1.x) as recommended by pi docs. `typebox` is now a `peerDependency` (shared with the host pi runtime) instead of a bundled `dependency`, reducing install footprint.
- **Bump peer dependency**: `@mariozechner/pi-coding-agent` peer range updated from `^0.67` to `^0.69.0` (v0.69.0 introduced the `@sinclair/typebox` → `typebox` migration in its published types).

## 0.2.9 (2026-04-29)

### Added

- **Per-agent setup flow**: `/setup-models` wizard configures model and thinking level together for each agent before advancing to the next, replacing the previous two-loop flow (all models, then all thinking levels).
- **Grouped provider picker**: when more than 10 models are available, model selection uses a two-step flow — select a provider (e.g., `anthropic (8 models)`), then pick a model within that provider. Cancel at the model step returns to the provider list.
- **Batch shortcuts**: after the first agent, the wizard offers "⬆ Apply `<model>` to all remaining agents", "⬆ Apply `<level>` to all remaining agents", and "⏭ Skip thinking for all remaining agents" to reduce repetitive selections.
- **Summary confirmation**: a formatted summary table (agent → model → thinking) is displayed and confirmed before writing to `settings.json`.
- **Smart model ordering**: models selected earlier in the wizard session sort first in subsequent agent selections.
- **One-for-all reasoning modes**: when using one model for all agents, the wizard offers three reasoning sub-modes: same level for all, configure per agent, or skip.
- **Interactive `/blackbytes-status`**: the command opens an interactive section picker with a compact overview header (`Tools: N | Agents: N | Skills: N`). Users select one of 9 sections to view, or "Show All" for the full output.

### Removed

- Dead code: unused `selectAction` and `buildReasoningChoices` helper functions removed from setup-models.

### Fixed

- Summary display correctly shows existing reasoning levels for agents whose thinking configuration is skipped (previously showed "(default)" regardless).
- Provider labels in grouped picker use a reverse-lookup map, preventing theoretical label collision with static choices.

## 0.2.8 (2026-04-29)

### Added

- **Sub-agent tool activity tracking**: sub-agent progress header displays tool call count, current tool name with argument summary (`🔧 read src/config/schema.ts`), and `✓`/`✗`/`⚠` status icons for terminal states (completed/failed/cancelled/timed_out). Expanded view (`Ctrl+O`) renders a tool activity timeline showing the last 30 invocations with `✓`/`▸` icons, argument summaries, and per-call durations.
- **Extension tool result rendering**: all bundled and HTTP-backed tools (grep, glob, hashline_edit, ast_search, ast_replace, web_search, web_fetch, docs_resolve, docs_query, gh_search) render collapsed results with `✓`/`✗` status icons and display partial-state messages (`Searching...`, `Fetching...`, `Scanning...`, etc.) while executing.

### Changed

- **Tool icon deconfliction**: `web_search` uses 🌐, `web_fetch` uses 📥, and `reviewer` sub-agent uses 📋 to eliminate icon collisions with `grep` (🔍) and `gh_search` (🔎).

## 0.2.7 (2026-04-28)

### Fixed

- **Package prompt discovery**: declares bundled prompt templates in the Pi package manifest via `pi.prompts` so Pi loads the published `prompts/*.md` files as slash commands.

## 0.2.6 (2026-04-28)

### Added

- **Bundled prompt templates**: package-level prompt templates for fresh-eyes review, documentation refresh, project innovation ideation, and logical commit-and-push workflows. These templates are discovered by Pi as slash commands from the package `prompts/` directory.

## 0.2.5 (2026-04-28)

### Changed

- **Reasoning effort handling**: reasoning parameters are no longer mapped onto provider payloads in `before_provider_request`. The host session relies on Pi's native reasoning controls; sub-agent reasoning continues to be passed via the `--thinking <effort>` CLI flag.
- **`/setup-models` wizard**: skips thinking-level configuration for sub-agents whose assigned model does not advertise reasoning support.
- **Reasoning effort normalization**: invalid legacy `reasoningEffort` values in config are coerced to `undefined` rather than being forwarded to the nested Pi CLI. Only Pi-valid levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) are accepted.

### Removed

- `src/handlers/before-provider-request.ts` and its unit tests.

## 0.2.4 (2026-04-27)

### Improved

- **Librarian sub-agent activation**: strengthened tool description and prompt overlay so the primary agent delegates external-library/docs/API research to `delegate_librarian` more readily when users request research, investigation, or lookup (including Vietnamese phrases like "tìm hiểu", "tra cứu").
- **External Content Safety**: added a safety section to the librarian system prompt treating web pages, docs, GitHub files, and fetched URLs as untrusted data — the sub-agent will not follow instructions found in external content.
- **Prompt overlay**: session capabilities and conditional workflows now include librarian-specific guidance ("Prefer `librarian` for explicit, non-trivial research requests…") that only renders when the librarian sub-agent is enabled.
- **Scoped wording**: tool description uses "non-trivial external research" with explicit escape hatches (purely local, trivial, or user opts out) to avoid over-delegation.

### Changed

- Librarian resource-metadata description updated from "Multi-repo analysis, documentation lookup" to "External docs/library/API research and open-source examples".

### Tests

- Regression test for librarian-specific overlay guidance presence/absence.
- Regression test for tool description wording guards and external-content safety section.

## 0.2.3 (2026-04-27)

### Changed

- Increased builtin sub-agent timeout defaults: explore=600000, librarian=900000, oracle=1200000, reviewer=900000, general=1800000.

## 0.2.2 (2026-04-26)

### Fixed

- Package name in README title and install command reflects the current unscoped name (`pi-blackbytes`).
- Removed non-existent `tool_description` field from YAML sub-agent example.
- Listed all optional YAML fields (`model`, `reasoning_effort`, `timeout_ms`, `mutability`, `prompt_mode`, `fallback_models`) inline in README.
- Added `reviewer=240000` to the documented `timeoutMs` builtin defaults in AGENTS.md.
- Added `yaml` to the documented dependency list in AGENTS.md.
- Added `bun run typecheck` to the documented development scripts in both README and AGENTS.md.
- Removed stale `console.log` startup banner from `src/index.ts`.

## 0.2.1 (2026-04-26)

### Added

- **Branding widget**: a gradient `✦ Bytes ✦` badge renders right-aligned above the chat input editor in interactive mode. Uses fixed 24-bit RGB colors (violet → indigo → sky → cyan) with bold text, independent of the active theme. Skipped in print mode and JSON mode.

### Internal

- New `src/branding.ts` module with gradient rendering utilities and widget setup.
- `handleSessionStart()` calls `setupBranding()` after tool and sub-agent registration.

## 0.2.0 (2026-04-26)

### Added

- **Reviewer sub-agent**: new read-only code reviewer (`delegate_reviewer`) that produces severity-classified findings (High/Medium/Low) and a verdict for diffs, branches, and PRs.
- **Runtime overlay for read-only sub-agents**: lightweight (~4 KB) `prependSystemPrompt` overlay via `buildSubAgentRuntimeOverlay()` carrying current date, working directory, and finalized tool allowlist.
- **Enhanced sub-agent tool strategies**: explore, oracle, and librarian agents now include detailed tool-strategy sections mapping question types to the best primitive tools.
- **CI/CD**: GitHub Actions workflow to publish to npm on release creation.

### Changed

- **Package renamed** from `@blackbytes/pi-blackbytes` to `pi-blackbytes` (unscoped).
- **Package metadata**: added `repository`, `homepage`, and `bugs` fields to `package.json`.
- Sub-agent system prompts expanded with tool-strategy guidance and runtime overlay hooks.
- CI workflow installs `ripgrep` for grep integration tests.

### Removed

- Bundled skills (`blackbytes-overview`, `hashline-workflow`, `delegation`) — replaced by enhanced sub-agent prompts and runtime overlays.


### Added

- Optional `blackbytes.system_prompt_log` JSONL capture for full Pi-effective system prompts at `agent_start`, with optional provider-serialized system-field capture at `before_provider_request`.

### Changed

- `/setup-models` now maps Blackbytes sub-agents to models already available in Pi instead of collecting provider credentials or writing provider/package defaults into the Blackbytes config.
- Extension event wrappers now await handlers and preserve return values so return-based Pi hooks such as `before_agent_start` and `tool_result` work correctly.

### Phase 2 closure summary

All five Phase 2 beads are resolved:

| Bead | Feature | Status |
|---|---|---|
| pib-vyj.2.1 | Per-agent timeout (`timeoutMs` / `timeout_ms`) | Landed |
| pib-vyj.2.2 | `promptMode` schema (`static` \| `append`) | Landed (append reserved) |
| pib-vyj.2.3 | Append prompt mode for builtins | **Deferred** (no safe Pi inherited-context API) |
| pib-vyj.2.4 | Conservative model fallback for read-only agents | Landed |
| pib-vyj.2.5 | Streaming / progress support | **Deferred** (no structured Pi progress surface) |

### Deferred to Phase 3

The following items were investigated in Phase 2 and deferred. They should not be re-opened without the stated precondition:

- **Parallel fanout / background task lifecycle** — requires a Pi API for concurrent tool execution or a stable background task surface.
- **Worktree isolation** — requires Pi to expose per-delegate working-directory control.
- **Persistent agent memory** — requires a stable, bounded Pi session-state API.
- **Streaming progress** — becomes supportable when Pi exposes a structured progress surface (typed status events, not raw stdout) with a chunk-level redaction utility available.
- **Append prompt mode** — becomes supportable when Pi exposes a `parentContext` / `inheritedInstructions` field on the tool execute callback, bounded in size and scoped to the parent's static system prompt only.



**Decision: deferred** — no builtin (`oracle`, `general`, `explore`, `librarian`) is opted into `promptMode: "append"`.
All four builtins continue to use the implicit static default. `buildSystemPrompt()` still throws fail-loud on `"append"`.

**Why deferred:** the prompt-builder bead (pib-vyj.2.2) confirmed Pi exposes no safe inherited-context source.
`AgentSession.systemPrompt` exists on the class but is unreachable from the registered tool's `execute` closure
(signature `(toolCallId, params, signal, onUpdate, ctx?)` — no parent-session reference). Without a stable,
bounded API surfacing the parent's static system prompt, enabling append mode would require either reading
arbitrary files (out of scope, unsafe) or scraping transcripts (forbidden by 2.2 source-contract rule).

**Re-evaluation criteria** (when to revisit and enable append for `oracle`, then `general` separately):
1. Pi exposes a documented `parentContext` / `inheritedInstructions` field on the tool execute callback,
   bounded in size, scoped to the parent's static system prompt only (not transcripts, not tool outputs).
2. A chunk-level secret-redaction utility is available (or `redactFailureText` is broadened with bounded
   guarantees suitable for prompt content).
3. For `general`: extra validation that append context cannot conflict with the bounded safety overlay or
   loosen the no-recursive-delegation / mutating-tools boundary.

**No code change.** This entry documents the deferral so future implementers do not silently flip
`promptMode` on a builtin without re-running the source-contract analysis.

### Phase 2 conservative model fallback for read-only agents (pib-vyj.2.4)

Adds optional `fallbackModels` config for read-only sub-agents (explore, oracle, librarian,
YAML-defined read-only agents). When a `provider_or_model_unavailable` failure is returned,
`executeWithFallback` retries with each model in the chain within a shared timeout budget.

**New / changed files:**
- `src/sub-agents/fallback.ts` — `executeWithFallback` + `formatAttempts` (pure, injectable).
- `src/config/schema.ts` — `fallbackModels` per-agent field (max 5 non-empty strings, no dupes).
- `src/sub-agents/loader.ts` — `fallback_models` in YAML schema; folded into `staticOverrides`.
- `src/sub-agents/declaration.ts` — `fallbackModels` added to `ModelOverrides`.
- `src/sub-agents/snapshot.ts` — `fallbackModels` + `fallbackEligible` fields on `AgentSnapshot`.
- `src/sub-agents/register.ts` — replaces single `runNestedPi` call with `executeWithFallback`.
- `src/commands/blackbytes-status.ts` — shows fallback chain and eligibility in snapshot section.
- `src/sub-agents/__tests__/fallback.test.ts` — new test file.

### Phase 2 progress/streaming spike (pib-vyj.2.5)

**Decision: unsupported** — live streaming of nested sub-agent output into the parent session is intentionally not wired.

**Investigation findings** (all citations from `node_modules/@mariozechner/pi-coding-agent`):

- `AgentToolUpdateCallback<T>` (`pi-agent-core/dist/types.d.ts:255`):
  `(partialResult: AgentToolResult<T>) => void` — a structured callback that sends partial
  `{ content, details }` objects to the host runtime during tool execution.
- `ToolDefinition.execute` signature (`core/extensions/types.d.ts:307`): receives
  `onUpdate: AgentToolUpdateCallback<TDetails> | undefined` as a 4th parameter.
- Bash tool (`core/tools/bash.js:201–244`): proves `onUpdate` is a **pure UI streaming surface**.
  Intermediate `onUpdate` calls display partial output in the TUI; the final `execute()` return
  value is what enters the LLM context. Calling `onUpdate` does **not** append to the final
  tool result.
- `RunNestedPiOptions.onUpdate` (`src/sub-agents/types.ts`): `(chunk: string) => void`. Already
  wired internally — `runner.ts` calls `onUpdate?.(text)` on each stdout chunk (`runner.ts:238–239`).
- `register.ts:45–46`: the `execute` callback receives `_onUpdate?: unknown` (unused, `_` prefix,
  typed `unknown`). Never forwarded to `runNestedPi`.

**Why streaming remains unsupported:**

1. Nested-Pi stdout is the full agent conversation (reasoning, tool calls, results) — too verbose
   to surface in the parent TUI without filtering.
2. No chunk-level secret redaction exists on the streaming path (`redactFailureText` only
   covers failure detail strings).
3. Wiring raw stdout through `onUpdate` would dump the nested conversation into the parent
   visual context, violating the "do not dump nested stdout into parent context" design constraint.

**What would make streaming supportable:** a structured progress surface from Pi (typed status events
rather than raw stdout), or a nested-session `--json-progress` mode producing concise, filterable
events, combined with a chunk-level redaction utility.

**Code changes:** JSDoc added to `RunNestedPiOptions.onUpdate` in `src/sub-agents/types.ts`
explaining the internal-only contract. README gained a "Progress / streaming" section documenting
the decision. No behavioral change; `bun run lint && bun run build && bun run test` all pass.

### Phase 2 prompt-mode schema (pib-vyj.2.2)

- **`promptMode` field on `SubAgentDeclaration`** (`src/sub-agents/declaration.ts`): optional `"static" | "append"` discriminator. Default is `"static"`. Field is frozen with the declaration via `defineSubAgent()`.
- **YAML `prompt_mode` field** (`src/sub-agents/loader.ts`): Zod enum validates `"static"` and `"append"`; any other value is rejected as a schema error and produces a diagnostic through the existing YAML pipeline (file skipped, reason surfaced in `/blackbytes-status`). Omitting the field defaults to `undefined` (static by default).
- **`buildSystemPrompt()` function** (`src/sub-agents/prompt-builder.ts`): centralised system-prompt assembler. In `"static"` mode (default) returns `basePrompt` byte-for-byte unchanged — no trimming, no transformation. In `"append"` mode throws a clear `Error` immediately ("not yet supported") so the delegate tool call fails loudly. **Append mode is deferred to pib-vyj.2.3**: Pi's `ExtensionAPI` execute callback exposes only `(toolCallId, params, signal, onUpdate, ctx?)` — there is no stable, bounded API that returns the parent session's static system prompt from within a registered tool. `AgentSession.systemPrompt` exists on the class but is unreachable from the execute closure without unsafe global state. Until Pi surfaces a supported `parentContext` field, append mode stays deferred.
- **`register.ts` wired to `buildSystemPrompt()`**: replaced inline `systemPrompt` variable with `baseSystemPrompt` → `buildSystemPrompt({ basePrompt, declaration })` → `builtPrompt`. Static mode output is byte-for-byte identical to previous behaviour.
- **No builtin sets `promptMode`**: all four builtins (`explore`, `oracle`, `librarian`, `general`) continue to operate with the implicit static default.
- **Tests** (`src/sub-agents/__tests__/prompt-builder.test.ts`, additions to `loader.test.ts`): snapshot tests confirm each builtin's system prompt is unchanged through the builder; append-mode tests verify the error message content and road-map citation; YAML schema tests confirm valid/invalid `prompt_mode` values are accepted/rejected; register.ts integration tests pass unmodified (zero behaviour change in static mode).

### Phase 1 subagent hardening

- **Canonical delegable tool registry + finalizer** (`src/sub-agents/delegable-tools.ts`): explicit tool classes (`EXTENSION_TOOL_NAMES`, `PI_BUILTIN_TOOLS`, `READ_SEARCH_DOCS_TOOLS`, `MUTATING_EXEC_TOOLS`). `finalizeNestedTools` pipeline: dedupe → reject delegate\_\*/unknown (strict throws / lenient drops) → apply global `disabled_tools` denylist → enforce per-agent mutability → sort. Strict mode for builtins, lenient for YAML.
- **Tool resolvers fixed for builtins + YAML**: explore/oracle/librarian are read-only/research-only with strict mode; general has full-access (Pi built-ins + extension tools) with strict mode and a prepended bounded safety overlay. YAML default starting set is `READ_SEARCH_DOCS` only. YAML `allowed_tools` listing any mutating tool auto-promotes mutability to `full-access`. Optional YAML `mutability:` field. Globally-disabled tools never reach nested Pi.
- **General safety overlay** (`src/sub-agents/general-safety-overlay.ts`): bounded ~8 KB markdown overlay listing cwd, finalized tools, enabled/disabled resources, hard rules, and AGENTS.md-derived constraints (truncated, with secret redaction).
- **Temperature RESERVED**: Pi CLI does not accept `--temperature`. Schema accepts the field for forward-compat; runner never emits it. `/blackbytes-status` surfaces it under "Reserved / Unsupported Settings".
- **Per-agent config snapshot** (`src/sub-agents/snapshot.ts`): resolved once at `session_start`. Precedence: declaration staticOverrides < YAML < JSON. `AgentSnapshot` includes `name`, `source` (`'builtin'|'yaml'`), `sourcePath?`, `model?`, `reasoningEffort?`, `reserved`, `extra`, `allowedToolsSummary`. Disk changes after `session_start` do not affect the active session.
- **Idempotent session start** (`src/shared/session-state.ts`): `resetSessionRuntimeState()` clears EnabledSet, agent snapshot, sub-agent registry, model-family cache, and YAML diagnostics as the very first step in `handleSessionStart`.
- **YAML diagnostics + safe status output** (`src/sub-agents/diagnostics.ts`): YAML loader returns `{declarations, diagnostics}`. Conflicts (vs builtin or earlier YAML) are skipped with a diagnostic instead of throwing; non-conflicting agents in the same directory still load. `/blackbytes-status` renders new sections: **Sub-Agent Snapshot** (allowed tools summary, source, model/reasoning, reserved, extra) and **YAML Sub-Agents** (loaded files + skipped files with reasons).
- **Failure formatting / cancellation / bounded output**: runner exposes `formatDelegateFailure`, `classifyFailure`, `redactFailureText` with failure kinds: `failed`, `timed_out`, `cancelled`, `spawn_error`, `recursion_refused`, `cli_usage_error`, `invalid_tool_allowlist`, `provider_or_model_unavailable`.

## 0.1.0 (2026-04-18)

### Release surface

- Bundled local tools: `glob`, `grep`, `ast_grep_search`, `ast_grep_replace`, `hashline_edit`
- HTTP-backed tools: `websearch_search`, `websearch_fetch`, `context7_resolve_library_id`, `context7_query_docs`, `grep_app_search_github`
- Delegate tools: `delegate_explore`, `delegate_oracle`, `delegate_librarian`, `delegate_general`
- Pi commands: `/setup-models`, `/blackbytes-status`
- Bundled skills: `blackbytes-overview`, `hashline-workflow`, `delegation`

### Runtime behavior

- The enabled tool/sub-agent set is computed once at `session_start` and reused across registration and prompt augmentation.
- `before_agent_start` injects the Bytes prompt block and the current `<available_resources>` view.
- `tool_result` rewrites Pi `read` and `write` output for the hashline workflow.
- `before_provider_request` maps reasoning settings by model family and registers the GitHub Copilot initiator header when enabled.
- Delegate sessions run with runtime-enforced tool allowlists and a one-level recursion guard.

### Configuration

- Strict JSON configuration under `settings.json › blackbytes`
- Tool and sub-agent disabling via `disabled_tools` and `disabled_sub_agents`
- Websearch provider selection via `websearch.provider` with `exa_api_key` or `tavily_api_key`
- Optional Context7 API key under `context7.api_key`
- Per-agent overrides under `sub_agents.<name>`

### Constraints

- Node `>=20`
- Peer dependency: `@mariozechner/pi-coding-agent@^0.67`
- Package budget: `< 500KB` gzipped
