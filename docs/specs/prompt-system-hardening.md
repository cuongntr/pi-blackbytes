# Prompt System Hardening — Sub-Agent Persona Spec

> **Status**: ✅ Done
> **Date**: 2026-05-26
> **Goal**: Close concrete gaps in the 5 builtin sub-agent prompts surfaced by a side-by-side review against `../oc-blackbytes`, while preserving the existing runtime-overlay contract and avoiding prompt-size growth for default users.

---

## 1. Problem

Cross-project review of the builtin sub-agent prompts (`explore`, `oracle`, `librarian`, `general`, `reviewer`) confirmed that pi's prompt engineering is already strong on **cost discipline, runtime-context freshness, and safety**. Four gaps remain:

1. **Oracle prompt is missing two high-value reasoning guardrails** present in oc-blackbytes: explicit `long_context_handling` (anchor claims to specific files/symbols when input is large) and `high_risk_self_check` (re-scan for unstated assumptions before finalizing answers on architecture / security / performance). Both materially raise the quality ceiling for the exact questions Oracle is invoked for.
2. **Oracle and General have no sub-agent prompt variant for a configured GPT-family nested model.** The parent Bytes overlay already has model-family variants, but nested sub-agents always receive the same persona body. For GPT-family models, Oracle/General should use a prose-first prompt shape with an explicit opener blacklist and less template pressure.
3. **General prompt hard-codes a tool-name list** ("Depending on session configuration, your tools may include: …") that can drift from the **runtime allowlist** assembled in `buildGeneralSafetyOverlay()`. The overlay is already authoritative, so the static list is redundant at best and misleading at worst.
4. **Routing intent is duplicated across free-text descriptions and a hardcoded Bytes overlay matrix.** The tool description strings carry positive routing hints, strict gating, and cost warnings, while `src/system-prompt/bytes/overlay.ts` separately hardcodes a routing matrix. `/blackbytes-status` and future UI surfaces cannot display routing intent without parsing or duplicating prose.

These are not new sub-agents and not new tools — they are surgical edits to existing prompts plus two optional declaration fields.

## 2. Non-Goals

- No new sub-agent. No change to `allowedTools`, `mutability`, or `finalizeMode`.
- No change to runner / nested CLI flags.
- No required migration for user-defined YAML agents.
- No user-defined YAML per-model prompt variants in this iteration; `systemPromptByFamily` is for builtin code declarations only.
- No rewrite of the Bytes v2 overlay — it consumes routing metadata, but its 14-section structure stays.

## 3. Solution

### 3.1 Oracle: add `long_context_handling` + `high_risk_self_check`

Two short sections appended after the existing `## Scope Discipline` block in `src/sub-agents/oracle.ts`. Together ≤14 lines; they sit between Scope Discipline and Output Style. Content is paraphrased — not copied — from oc-blackbytes to match pi's Markdown-headings style and pi's existing `file://` link convention.

```md
## Long-Context Handling

When the input is large (multiple files, >5k tokens of code), outline the relevant
sections mentally before answering. Anchor every claim to a specific location using
the `file://` link form (`[relpath#L-L](file:///abs/path#L-L)`) or
`file_path:line_number` shorthand. Quote exact values (thresholds, config keys,
function signatures) when they matter — do not generalize.

## High-Risk Self-Check

Before finalizing answers on architecture, security, or performance:
- Re-scan for unstated assumptions and make them explicit.
- Verify each claim is grounded in code you actually `read`/`grep`/`ast_search` —
  not invented.
- Soften absolute language ("always", "never", "guaranteed") unless justified.
- Confirm each Action-plan step is concrete and immediately executable.
```

### 3.2 Per-model prompt variants (Oracle + General only)

Add an **optional** `systemPromptByFamily` field on `SubAgentDeclaration<T>`. Reuse the existing `ModelFamily` and `classifyModel()` from `src/shared/model-capability.ts`; do **not** create a second model-family type. The existing type includes `"kimi"`, and this work must not regress that support.

```ts
import type { ModelFamily } from "../shared/model-capability.js";

export interface SubAgentDeclaration<T> {
  // ...existing fields
  systemPrompt: string;
  systemPromptByFamily?: Partial<Record<ModelFamily, string>>;
}
```

Resolution rules (centralized in `src/sub-agents/prompt-builder.ts`):

1. `registerSubAgent()` resolves the per-agent snapshot **before** building the prompt body.
2. Prompt variant selection uses the resolved nested model string (`snapshot.model`) only. If no nested model is configured, use `systemPrompt`; do **not** fall back to the parent session's cached model family.
3. If `snapshot.model` exists, classify it with `classifyModel(snapshot.model)`.
4. If `systemPromptByFamily[family]` exists → use it. Otherwise fall back to `systemPrompt`.
5. `fallbackModels` do not affect prompt selection in this iteration. The prompt body is selected from the primary resolved model and reused for fallback attempts. This is acceptable because fallback is an error-recovery path and all prompt bodies remain compatible; revisit per metrics if fallback use becomes common.
6. The `prependSystemPrompt` runtime overlay is **always** prepended after family resolution, unchanged.

Only Oracle and General ship `gpt` variants in this iteration:

- **Oracle GPT variant** — prose-first, explicit opener blacklist, no 6-point template by default ("Use a short paragraph for trivial questions; reserve the structured template for genuinely complex ones."). Same `Effort estimate` tag set. Same self-contained-final-message clause. ~50 lines.
- **General GPT variant** — prose-first, same Plan-Sanity Check, same constraints, opener blacklist. ~40 lines.

Explore, Librarian, Reviewer keep a single prompt — their outputs are already structured enough that family-specific tuning is not justified for this iteration. Revisit per metrics.

### 3.3 General: drop the static tool list, defer to overlay

In `src/sub-agents/general.ts`, replace the entire `## Tool Access` block with a single short paragraph:

```md
## Tool Access

The host prepends a safety/context overlay containing the **finalized allowed
tool list** for this invocation along with working directory, repository
conventions from `AGENTS.md`, and verification commands. Treat that overlay as
the authoritative source of truth for what is callable and how to verify work —
do not attempt tools that are not listed there.
```

`buildGeneralSafetyOverlay()` already renders the finalized list. Remove the duplicated enumeration to eliminate drift risk (for example, when a tool is added, renamed, or disabled via `disabled_tools`).

Add guard tests in `src/sub-agents/__tests__/general.test.ts`:

- `generalDeclaration.systemPrompt` does not contain `Depending on session configuration`.
- `generalDeclaration.systemPrompt` does not contain the removed static tool-list bullets.
- `src/sub-agents/general.ts` no longer imports `TOOL_NAMES`.

### 3.4 Routing metadata as a typed field

Add to `SubAgentDeclaration<T>`:

```ts
export interface SubAgentRoutingMetadata {
  category: "exploration" | "advisor" | "specialist" | "executor" | "utility";
  cost: "free" | "cheap" | "expensive";
  useWhen: string[];   // ≤6 short bullets
  avoidWhen: string[]; // ≤6 short bullets
  keyTrigger?: string; // one-line headline trigger
}

export interface SubAgentDeclaration<T> {
  // ...existing
  routing?: SubAgentRoutingMetadata;
}
```

Populate `routing` for all 5 builtin declarations. Extend `SubAgentMeta` in `src/config/resource-metadata.ts` with `routing?: SubAgentRoutingMetadata`, and have `declarationToMeta()` copy it into the runtime registry. This keeps routing metadata available after session startup without importing builtin declarations from UI/status code.

YAML loader (`src/sub-agents/loader.ts`) accepts an optional `routing:` block with the same shape; validate it with Zod and field length caps. YAML agents without routing remain valid and render with a placeholder in status output.

Consumers updated to read from `routing` instead of duplicating free text:

- `src/system-prompt/bytes/overlay.ts` — the positive routing matrix in the Conditional Workflows section is built from enabled agents' `routing.keyTrigger` / `routing.useWhen`, not hardcoded strings.
- `src/handlers/before-agent-start.ts` / `src/system-prompt/bytes/shared.ts` — pass registered routing metadata into `BytesPromptRenderContext` alongside enabled tool/sub-agent sets.
- `/blackbytes-status` — adds a "Sub-Agent Routing" section showing each enabled agent's `category`, `cost`, `useWhen`, `avoidWhen`. YAML agents without routing show `—`.
- Tool description strings remain strict and useful for Pi's tool list, but drop duplicated positive `useWhen` enumerations. Keep hard gating (`DO NOT use for …`) and cost signals where they materially affect delegation decisions.

## 4. Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                      defineSubAgent({ … })                           │
│                                                                      │
│  systemPrompt              ──► default prompt body                   │
│  systemPromptByFamily? ──┐                                           │
│  routing? ───────────────┼──► typed metadata                         │
│  prependSystemPrompt   ──┼──► runtime overlay (unchanged)            │
│                          │                                           │
└──────────────────────────┼───────────────────────────────────────────┘
                           │
              ┌────────────┴────────────────┐
              ▼                             ▼
 resolveSystemPromptBody(decl, model)   declarationToMeta(decl)
 (src/sub-agents/prompt-builder.ts)     (src/sub-agents/declaration.ts)
              │                             │
              ▼                             ▼
 [runtime overlay] + prompt body        runtime sub-agent registry
              │                             │
              ▼                             ▼
       nested pi -p stdin          buildRoutingSummary(enabled metas)
                                      │
                                      ▼
                                Bytes v2 overlay
                                /blackbytes-status
```

## 5. Behaviors

1. **No behavior change** when `sub_agents.oracle.model` or `sub_agents.general.model` is unset — the default `systemPrompt` body is used even if the parent session model is GPT-family.
2. **GPT variant applies only to a configured nested GPT model.** Setting `blackbytes.sub_agents.oracle.model` or `blackbytes.sub_agents.general.model` to a GPT-family model selects the `gpt` variant for that sub-agent.
3. **Runtime overlay precedence is unchanged.** `prependSystemPrompt` still runs after family resolution; the order is `[runtime overlay] + [family-resolved system prompt body]`.
4. **Fallback models reuse the primary prompt body** in this iteration. This avoids a larger fallback-runner refactor and keeps the change surgical.
5. **`/blackbytes-status` gains a routing section** under enabled sub-agents, sourced from typed `routing` metadata. Cost classification (`free` / `cheap` / `expensive`) is editorial — defined per-agent, not measured.
6. **Tool description text is shorter and less duplicative.** The parent agent still sees gating rules (for example, `DO NOT use for: …`) but positive routing hints come from the metadata-driven Bytes overlay.
7. **No regression in token budget for Claude/default users.** The default Oracle prompt body grows by ≤14 lines; General prompt body shrinks by removing the static tool list. Net default-prompt change is approximately neutral.

## 6. Implementation Plan

**Status**: Draft  
**Owner**: maintainer  
**Phase**: Phase 1 MVP

**MVP lock**: implement Oracle guardrails; add Oracle/General GPT prompt variants selected only from a configured nested model; remove General's static tool list; add typed routing metadata; render routing from metadata in the Bytes overlay and `/blackbytes-status`; cover the behavior with automated tests.

**Out of phase**: YAML `system_prompt_by_family`, per-attempt prompt switching for `fallbackModels`, new agents/tools, Reviewer bash access, and `/blackbytes-status` redesign beyond one new section.

### 6.1 Dependency graph

```text
T-001 Declaration + YAML routing scaffolding
  ├─► T-002 Prompt-body resolution
  │     ├─► T-003 Oracle prompt hardening
  │     └─► T-004 General prompt cleanup
  └─► T-005 Builtin routing metadata
        ├─► T-006 Routing consumers (Bytes overlay + status)
        └─► T-007 Tool-description tightening
T-008 Verification + manual checks depends on T-003, T-004, T-006, T-007
```

### 6.2 Leaf tasks

#### T-001 — Add declaration and YAML routing scaffolding

**Depends on**: none  
**Related files**: `src/sub-agents/declaration.ts`, `src/config/resource-metadata.ts`, `src/sub-agents/loader.ts`, `src/sub-agents/__tests__/loader.test.ts`, `src/sub-agents/__tests__/snapshot.test.ts`

Add `SubAgentRoutingMetadata`, `systemPromptByFamily?`, and `routing?` to `SubAgentDeclaration`. Extend `SubAgentMeta` and `declarationToMeta()` so routing survives runtime registration. Extend the YAML loader with optional `routing:` only; do not add YAML per-family prompts.

**Acceptance criteria**:
- Builtin and YAML declarations compile with optional routing metadata.
- YAML agents without `routing` still load unchanged.
- Invalid YAML routing values produce a diagnostic skip, not a runtime crash.
- Field length caps are enforced (`useWhen`/`avoidWhen` ≤6 items; short strings only).

**Definition of Done**: loader round-trip tests pass; declaration/meta tests prove routing is copied; typecheck passes for the changed types.

#### T-002 — Resolve sub-agent prompt bodies from the configured nested model

**Depends on**: T-001  
**Related files**: `src/sub-agents/prompt-builder.ts`, `src/sub-agents/register.ts`, `src/shared/model-capability.ts`, `src/sub-agents/__tests__/prompt-builder.test.ts`, `src/sub-agents/__tests__/delegates.test.ts`

Add `resolveSystemPromptBody(decl, modelId?)` using `classifyModel()` from `src/shared/model-capability.ts`. Move `registerSubAgent()` prompt construction after snapshot lookup so `snapshot.model` is available before the prompt body is selected.

**Acceptance criteria**:
- No configured nested model → default `systemPrompt`, even when the parent cached model family is GPT.
- Configured GPT-family nested model → `systemPromptByFamily.gpt` when present.
- Configured non-GPT or missing family variant → default `systemPrompt`.
- Existing `promptMode: "append"` fail-loud behavior remains unchanged.
- `fallbackModels` do not alter prompt-body selection.

**Definition of Done**: prompt-builder tests cover fallback behavior; register-level test captures `--system-prompt` and proves GPT/default selection.

#### T-003 — Harden Oracle prompt and add Oracle GPT variant

**Depends on**: T-002  
**Related files**: `src/sub-agents/oracle.ts`, `src/sub-agents/__tests__/snapshot.test.ts` or a dedicated prompt snapshot test, `src/sub-agents/__tests__/delegates.test.ts`

Append `## Long-Context Handling` and `## High-Risk Self-Check` to the default Oracle prompt. Add `ORACLE_GPT_PROMPT` with the same role/safety semantics but prose-first output guidance.

**Acceptance criteria**:
- Default Oracle prompt contains both new sections in the specified location.
- Oracle GPT variant keeps the self-contained final message requirement, effort tags, uncertainty rules, language matching, and read-only constraints.
- GPT variant avoids forcing the 6-point answer template for trivial questions.

**Definition of Done**: prompt snapshot passes; configured `sub_agents.oracle.model = "gpt-*"` sends the GPT body to nested Pi in an automated capture test.

#### T-004 — Clean up General prompt and add General GPT variant

**Depends on**: T-002  
**Related files**: `src/sub-agents/general.ts`, `src/sub-agents/__tests__/general.test.ts`, `src/sub-agents/__tests__/delegates.test.ts`

Replace General's static `## Tool Access` list with the overlay-deferring paragraph. Remove the unused `TOOL_NAMES` import. Add `GENERAL_GPT_PROMPT` with the same Plan-Sanity Check and execution constraints but prose-first formatting.

**Acceptance criteria**:
- Default General prompt no longer contains `Depending on session configuration` or the removed static tool-list bullets.
- `src/sub-agents/general.ts` no longer imports `TOOL_NAMES`.
- General GPT variant preserves Plan-Sanity Check, no-follow-up behavior, scope limits, verification requirements, and language matching.

**Definition of Done**: General prompt regression tests pass; configured `sub_agents.general.model = "gpt-*"` sends the GPT body to nested Pi in an automated capture test.

#### T-005 — Populate builtin routing metadata and routing summary helper

**Depends on**: T-001  
**Related files**: `src/sub-agents/{explore,oracle,librarian,general,reviewer}.ts`, `src/sub-agents/routing.ts`, `src/sub-agents/__tests__/routing.test.ts`

Populate `routing` for all 5 builtin declarations. Add `buildRoutingSummary(metas, enabledSubAgents)` as the single helper used by overlay/status consumers.

**Acceptance criteria**:
- Each builtin has `category`, `cost`, `useWhen`, `avoidWhen`, and a concise `keyTrigger` where useful.
- Summary output is deterministic and filtered to enabled sub-agents.
- YAML agents with missing routing produce a placeholder entry for status output.

**Definition of Done**: routing helper tests cover enabled filtering, ordering, builtin completeness, and YAML placeholder behavior.

#### T-006 — Render routing metadata in Bytes overlay and `/blackbytes-status`

**Depends on**: T-005  
**Related files**: `src/system-prompt/bytes/types.ts`, `src/system-prompt/bytes/shared.ts`, `src/system-prompt/bytes/overlay.ts`, `src/handlers/before-agent-start.ts`, `src/commands/blackbytes-status.ts`, `src/handlers/__tests__/before-agent-start.test.ts`, `src/commands/__tests__/blackbytes-status.test.ts`

Thread registered routing metadata into `BytesPromptRenderContext`. Replace the hardcoded Conditional Workflows routing matrix with metadata-driven lines. Add a `Sub-Agent Routing` section and interactive menu entry to `/blackbytes-status`.

**Acceptance criteria**:
- Overlay routing lines change when metadata fixtures change, proving they are not hardcoded per-agent strings.
- Disabled sub-agents are omitted from overlay/status routing output.
- `/blackbytes-status` shows builtin `category`, `cost`, `useWhen`, `avoidWhen`; YAML agents without routing show `—`.

**Definition of Done**: overlay and status tests pass for enabled/disabled builtins and YAML placeholder cases.

#### T-007 — Tighten delegate tool descriptions without losing gates

**Depends on**: T-005  
**Related files**: `src/sub-agents/{explore,oracle,librarian,general,reviewer}.ts`, `src/sub-agents/__tests__/librarian-gating.test.ts`, `src/handlers/__tests__/before-agent-start.test.ts`

Shorten the 5 delegate tool descriptions by removing duplicated positive `useWhen` prose now owned by routing metadata. Preserve strict gating and cost signals, especially for `librarian` and `general`.

**Acceptance criteria**:
- Descriptions are shorter than the current baseline or satisfy explicit max-length assertions recorded in tests.
- `librarian` still has ALL-of gating, direct-tool anti-patterns, and 5–10× cost signal.
- `general` still has strict concrete-plan gating and the no-exploration/no-small-task warning.
- Positive routing hints appear in the Bytes overlay via metadata, not duplicated in descriptions.

**Definition of Done**: description/gating tests pass; overlay tests still expose concise routing hints.

#### T-008 — Verify, benchmark, and manual-check the feature

**Depends on**: T-003, T-004, T-006, T-007  
**Related files**: `package.json`, relevant changed tests, scratch `settings.json` only if needed for manual validation

Run the project-defined verification sequence and one startup benchmark. Manually exercise the new status section and nested GPT prompt selection.

**Acceptance criteria**:
- `bun run lint && bun run build && bun run test` passes.
- `bun run bench:startup` is within ±5% of the local baseline or the delta is explained.
- Manual `/blackbytes-status` shows `Sub-Agent Routing`.
- Manual nested `system_prompt_log` capture confirms Oracle or General GPT body when configured.

**Definition of Done**: verification results are recorded in the implementation PR/summary; any failures have follow-up tasks or fixes.

### 6.3 Test strategy

- **Unit tests**: declaration/meta copy, YAML routing validation, routing summary, prompt-body resolver.
- **Register integration tests**: capture nested `--system-prompt` for default vs GPT-configured Oracle/General.
- **Overlay/status tests**: metadata-driven routing matrix, disabled-agent filtering, YAML placeholder rendering.
- **Regression tests**: General prompt static list removed; `TOOL_NAMES` import removed; parent GPT model does not leak into nested prompt selection.
- **Verification commands**: `bun run lint`, `bun run build`, `bun run test`, `bun run bench:startup`.

### 6.4 Rollback and compatibility

No data migration or persistent config migration is required. All new declaration fields are optional; YAML `routing` is optional. Rollback is a code revert of the declaration/prompt/status changes. Existing user YAML agents continue to load because the new routing block is optional and per-family YAML prompts are not introduced.

### 6.5 Beads Trace

| Plan task | Bead ID |
|---|---|
| Root feature | `pib-prompt-system-hardening-phase1-qvv` |
| T-001 Declaration + YAML routing scaffolding | `pib-prompt-system-hardening-phase1-qvv.1` |
| T-002 Prompt-body resolution | `pib-prompt-system-hardening-phase1-qvv.2` |
| T-003 Oracle prompt hardening | `pib-prompt-system-hardening-phase1-qvv.3` |
| T-004 General prompt cleanup | `pib-prompt-system-hardening-phase1-qvv.4` |
| T-005 Builtin routing metadata | `pib-prompt-system-hardening-phase1-qvv.5` |
| T-006 Routing consumers (Bytes overlay + status) | `pib-prompt-system-hardening-phase1-qvv.6` |
| T-007 Tool-description tightening | `pib-prompt-system-hardening-phase1-qvv.7` |
| T-008 Verification + manual checks | `pib-prompt-system-hardening-phase1-qvv.8` |

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Family detection mis-classifies a new model name. | Reuse `classifyModel()` from `src/shared/model-capability.ts`; unknown families fall back to `systemPrompt` and never throw. |
| Parent model family accidentally changes nested prompts. | Variant selection must use `snapshot.model` only. Add a test where parent/cache is GPT but `snapshot.model` is undefined and the default prompt is used. |
| Fallback model receives a prompt optimized for the primary model. | Accepted for this iteration to keep fallback execution simple; prompt variants remain compatible. Revisit only if fallback metrics show meaningful usage. |
| Routing metadata drifts from the prose in tool descriptions. | Descriptions stop carrying positive `useWhen` lists. Overlay and status read from `routing`. Add tests that the overlay/status output is generated from metadata fixtures. |
| User YAML agents without `routing` show up empty in `/blackbytes-status`. | Render `—` placeholder; do not require `routing` (back-compat). |
| Snapshot tests churn. | Land Phase 1 first with no prompt text changes; update snapshots in Phase 2/3/4 deliberately. |
| GPT variant diverges from default and confuses contributors. | Co-locate both prompts in the same file; add a short comment explaining which sections must stay semantically aligned and which are intentionally model-specific. |

## 8. Out of Scope (Explicit)

- Reviewer gaining `bash` access (architectural decision, separate spec).
- Explore / Librarian gaining GPT variants (revisit per usage metrics).
- User-defined YAML `system_prompt_by_family` support.
- Per-attempt prompt-body switching for `fallbackModels`.
- `/blackbytes-status` UI redesign — just one new section.
- Migrating user YAML agents to require typed routing.

## 9. Acceptance Criteria

- Oracle prompt contains the two new sections; snapshot test passes.
- Setting a GPT model for Oracle or General results in the GPT-variant body being sent to the nested CLI, verified by an automated `--system-prompt` capture test and optionally by `system_prompt_log`.
- Parent/host GPT model selection does **not** change Oracle or General prompt bodies when the sub-agent has no configured nested model.
- General prompt body no longer contains the removed static tool-list block, and `src/sub-agents/general.ts` no longer imports `TOOL_NAMES`.
- `/blackbytes-status` shows a "Sub-Agent Routing" section with `category`, `cost`, `useWhen`, `avoidWhen` for each enabled builtin; YAML agents without routing show `—`.
- Bytes overlay routing matrix is generated from typed routing metadata rather than hardcoded per-agent strings.
- Tool description strings are shorter and retain strict gating/cost signals.
- `bun run lint && bun run build && bun run test` clean. Startup bench within ±5% of baseline.
