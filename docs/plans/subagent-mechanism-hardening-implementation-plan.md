# Sub-Agent Mechanism Hardening — Implementation Plan

| Field | Value |
|---|---|
| Status | Draft |
| Owner | invoker |
| Source PRD | [`../specs/subagent-mechanism-hardening.md`](../specs/subagent-mechanism-hardening.md) |
| Source Technical Design | [`../specs/subagent-mechanism-hardening.md#9-technical-design`](../specs/subagent-mechanism-hardening.md#9-technical-design) |
| Related ADRs | None present in this repo |
| Phase | Phase 1 MVP |

> **Supersession (2026-08-03)**: The builtin Reviewer was later removed and its difficult-review contract merged into Oracle. See the current [`README`](../../README.md) and [`CHANGELOG`](../../CHANGELOG.md). This plan retains its historical five-agent acceptance wording.

---

## 1. MVP-Lock

In this phase:

- REQ-001: lifecycle records/events and failure classification.
- REQ-002: `/blackbytes-status` Sub-Agent Diagnostics section.
- REQ-003: builtin final-output contracts.
- REQ-006: tests, docs for Phase 1 behavior, and compatibility verification.

Out of this phase:

- Artifact capture for large outputs.
- Lightweight chain primitive.
- Background async job management.
- Mid-run steering of nested sessions.
- Cron/interval scheduled agents.
- Dynamic fanout or supervisor/intercom behavior.
- Replacing nested CLI execution with in-process Pi SDK sessions.

Exit criteria:

- Runner failures are classified into actionable categories and recorded in the delegation log.
- `/blackbytes-status` surfaces sub-agent diagnostics without leaking secrets.
- Builtin sub-agent prompts include compact final-output contracts and prompt regression tests.
- Existing delegate APIs remain backward compatible.
- `bun run check` passes.

Scope changes after this plan is promoted to Active require a delta-change doc.

## 2. Work Item Hierarchy

### Epic E-1: Runtime classification and lifecycle observability

#### Task T-1: Define classification model and event payloads

- **T-001 — Extend the existing failure-classification taxonomy (do not build a parallel one)**
  - **What + why**: `DelegateFailureKind` (8 values) and `classifyFailure()` already exist in `types.ts`/`runner.ts` and thread through every `DelegateResult`. Do **not** create a parallel `SubAgentFailureKind` or a new `failure-kind.ts`. Extend the existing type with the two genuinely missing distinctions — `malformed_jsonl` and `killed` — keeping current names (`spawn_error`, `failed`) to avoid churn across `runner.ts`, `register.ts`, `fallback.ts`, and tests.
  - **Related files / packages**: `src/sub-agents/types.ts` (extend `DelegateFailureKind`), `src/sub-agents/runner.ts` (`classifyFailure` + `close` handler), `src/sub-agents/__tests__/runner.test.ts`.
  - **Acceptance criteria**: `DelegateFailureKind` gains `malformed_jsonl` and `killed`; existing names unchanged; classifier output stays redaction-safe and serializable; no new parallel type or file is introduced.
  - **Definition of Done**: type extended, unit tests cover the new kinds, typecheck passes, no rename regressions.
  - **References**: [`subagent-mechanism-hardening.md#req-001--sub-agent-lifecycle-events-and-failure-classification`](../specs/subagent-mechanism-hardening.md#req-001--sub-agent-lifecycle-events-and-failure-classification).

- **T-002 — Thread failure classification through `runNestedPi()` results**
  - **What + why**: Attach structured classification details at the runner boundary where process, timeout, JSONL, and exit-code outcomes are known. This keeps classification close to the source and avoids fragile string parsing in status code.
  - **Related files / packages**: `src/sub-agents/runner.ts`, `src/sub-agents/fallback.ts`, `src/sub-agents/__tests__/runner.test.ts`, `src/sub-agents/__tests__/fallback.test.ts`.
  - **Acceptance criteria**: timeout returns `timed_out`; spawn failure returns `spawn_error` (existing name); non-zero child exit returns `failed` (existing name); malformed JSONL returns `malformed_jsonl` — **requires new detection logic**: `handleLine()` currently swallows `JSON.parse` errors silently; add a counter for lines starting with `{` that fail parse, and at process close, if `finalAssistantText` is empty (no valid `agent_end` received) **and** the malformed counter is > 0, classify as `malformed_jsonl` instead of `failed`; an externally-killed child returns `killed` — **requires reading the `signal` argument** in `child.on("close", (code, signal) => ...)` (only `_code` is captured today); when `signal` is non-null and was not requested by our own `requestTermination()`, classify as `killed`; provider/model fallback path preserves `provider_or_model_unavailable`; existing bounded stdout/stderr behavior remains unchanged.
  - **Definition of Done**: runner and fallback tests updated; no regression in existing timeout/SIGKILL tests.
  - **References**: [`subagent-mechanism-hardening.md#93-lifecycle-and-failure-classification`](../specs/subagent-mechanism-hardening.md#93-lifecycle-and-failure-classification).

#### Task T-2: Extend delegation log safely

- **T-003 — Record recent sub-agent failures, fallback attempts, and classification metadata**
  - **What + why**: Extend the session-scoped delegation log so `/blackbytes-status` can show recent actionable failures and fallback behavior without re-parsing raw tool results. The real gap is that `DelegationEntry` currently has **no** `failureKind` field (only `success: boolean`). Fallback attempt metadata already exists — reuse `AttemptSummary` / `FallbackResult.attemptedModels` / `formatAttempts()` from `fallback.ts` rather than recomputing it.
  - **Related files / packages**: `src/sub-agents/delegation-log.ts`, `src/sub-agents/register.ts`, `src/sub-agents/fallback.ts`, `src/sub-agents/__tests__/delegation-log.test.ts`, `src/sub-agents/__tests__/register.test.ts`.
  - **Acceptance criteria**: `DelegationEntry` gains an optional `failureKind`; the fallback attempt summary is sourced from the existing `AttemptSummary`/`formatAttempts()` data (not recomputed); entries include output length, cost, duration, and a redacted error hint; entries are capped to the most recent N entries (suggest 100) to bound session memory — the current log has **no** cap, so T-003 introduces one by evicting oldest entries when the limit is reached; successful entries remain as today.
  - **Definition of Done**: delegation-log tests cover success, failure, fallback, cap behavior, and redaction.
  - **References**: [`subagent-mechanism-hardening.md#92-architecture`](../specs/subagent-mechanism-hardening.md#92-architecture).

### Epic E-2: Status diagnostics

#### Task T-3: Build diagnostic data model

- **T-004 — Add sub-agent diagnostics summary builder**
  - **What + why**: Create a pure summary helper that gathers snapshots, YAML diagnostics, recent delegation failures, fallback eligibility, and timeout config. Nested Pi availability is provided separately by T-005 and composed at render time (T-006), not owned here. Keeping this pure makes status rendering testable and avoids UI code owning business logic.
  - **Related files / packages**: new `src/sub-agents/diagnostics-summary.ts`, `src/sub-agents/snapshot.ts`, `src/sub-agents/diagnostics.ts`, `src/sub-agents/delegation-log.ts`, `src/sub-agents/__tests__/diagnostics-summary.test.ts`.
  - **Acceptance criteria**: summary lists enabled/disabled agent status, configured/default timeout, fallback model count and eligibility, YAML skipped files/reasons, recent failures by kind, and delegation ROI summary; all string fields are redacted.
  - **Definition of Done**: pure helper tests pass with builtin, YAML, disabled-agent, fallback, and no-failure fixtures.
  - **References**: [`subagent-mechanism-hardening.md#req-002--blackbytes-status-sub-agent-diagnostics`](../specs/subagent-mechanism-hardening.md#req-002--blackbytes-status-sub-agent-diagnostics).

- **T-005 — Add lazy nested Pi availability check**
  - **What + why**: Surface common spawn problems early, but avoid slowing every status render. The check should use cached last-run errors first and only perform a lightweight availability check when the diagnostics section is opened or when no cached signal exists.
  - **Related files / packages**: `src/sub-agents/runner.ts`, new or existing diagnostics helper, `src/sub-agents/__tests__/diagnostics-summary.test.ts`.
  - **Acceptance criteria**: reports available/unavailable/unknown; unavailable includes a redacted actionable hint; compact status does not spawn Pi just to render; test seam avoids invoking the real CLI.
  - **Definition of Done**: tests prove lazy/cached behavior and redaction.
  - **References**: [`subagent-mechanism-hardening.md#94-status-diagnostics`](../specs/subagent-mechanism-hardening.md#94-status-diagnostics).

#### Task T-4: Render diagnostics in `/blackbytes-status`

- **T-006 — Add Sub-Agent Diagnostics section to `/blackbytes-status`**
  - **What + why**: Expose the diagnostics summary through the existing interactive status viewer so users can troubleshoot sub-agent issues without source inspection.
  - **Related files / packages**: `src/commands/blackbytes-status.ts`, `src/commands/__tests__/blackbytes-status.test.ts`.
  - **Acceptance criteria**: status menu includes Sub-Agent Diagnostics; the section **reuses** existing Snapshot (timeout/fallback), YAML Diagnostics, and Delegation ROI data rather than re-rendering duplicate copies — the genuinely new content is recent-failures-by-kind and nested Pi availability; disabled resources obey existing status conventions; no secrets appear in rendered output.
  - **Definition of Done**: status tests cover normal, no-agents, YAML-warning, failure, and redaction cases.
  - **References**: [`subagent-mechanism-hardening.md#94-status-diagnostics`](../specs/subagent-mechanism-hardening.md#94-status-diagnostics).

### Epic E-3: Builtin final-output contracts

#### Task T-5: Update prompts with compact contracts

- **T-007 — Add role-specific final-output contracts to builtin sub-agent prompts**
  - **What + why**: Make child output easier for the parent to consume and verify while preserving each agent's current specialty. The contracts must stay compact to avoid degrading worker quality.
  - **Related files / packages**: `src/sub-agents/explore.ts`, `src/sub-agents/oracle.ts`, `src/sub-agents/librarian.ts`, `src/sub-agents/general.ts`, `src/sub-agents/reviewer.ts`.
  - **Acceptance criteria**: `general` requires Summary, Files changed, Verification, Risks, Follow-up; `reviewer` preserves severity findings and verdict; `explore`, `oracle`, and `librarian` keep citation/source requirements and add caveat/confidence sections where appropriate; default and GPT prompt variants stay semantically aligned.
  - **Definition of Done**: prompts updated with minimal text and no runtime overlay changes.
  - **References**: [`subagent-mechanism-hardening.md#95-final-output-contracts`](../specs/subagent-mechanism-hardening.md#95-final-output-contracts), [`prompt-system-hardening.md`](../specs/prompt-system-hardening.md).

- **T-008 — Add prompt contract regression tests**
  - **What + why**: Guard the output-contract headings/phrases without snapshotting entire prompts, which would make future prompt edits noisy.
  - **Related files / packages**: `src/sub-agents/__tests__/general.test.ts`, `src/sub-agents/__tests__/reviewer.test.ts`, new or existing prompt tests for explore/oracle/librarian.
  - **Acceptance criteria**: tests assert required contract headings in default and GPT variants where applicable; tests avoid brittle full-prompt snapshots; existing routing and prompt-builder tests still pass.
  - **Definition of Done**: prompt tests pass and remain focused on contracts.
  - **References**: [`subagent-mechanism-hardening.md#req-003--builtin-final-output-contracts`](../specs/subagent-mechanism-hardening.md#req-003--builtin-final-output-contracts).

### Epic E-4: Documentation and verification

#### Task T-6: Document Phase 1 behavior

- **T-009 — Update repo docs for diagnostics and output contracts**
  - **What + why**: Keep project instructions and user-facing docs aligned with shipped behavior so future agents know where diagnostics live and what worker outputs should contain.
  - **Related files / packages**: `AGENTS.md`, `README.md`, possibly `CHANGELOG.md`.
  - **Acceptance criteria**: AGENTS documents Sub-Agent Diagnostics and final-output contract expectations; README or relevant docs mention how to use diagnostics for failures; no mention of Phase 2 artifact/chain features as shipped behavior.
  - **Definition of Done**: docs updated after implementation details settle.
  - **References**: [`AGENTS.md#sub-agents`](../../AGENTS.md#sub-agents).

- **T-010 — Run full verification and size check**
  - **What + why**: Ensure the Phase 1 changes do not break existing extension surfaces or package-size budget.
  - **Related files / packages**: all changed files; `package.json` scripts.
  - **Acceptance criteria**: `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test`, and `bun run check:size` pass, or failures are fixed/documented honestly.
  - **Definition of Done**: verification commands captured in final implementation report.
  - **References**: [`AGENTS.md#development`](../../AGENTS.md#development).

## 3. Dependencies

| Edge | Reason |
|---|---|
| T-002 depends on T-001 | Runner needs the classification type/helper. |
| T-003 depends on T-001, T-002 | Delegation log records classified outcomes. |
| T-004 depends on T-003 | Diagnostics summary consumes delegation log metadata. |
| T-005 independent of T-004 | Nested Pi availability is a standalone lazy check, not an input to the summary builder. |
| T-006 depends on T-004, T-005 | Status rendering composes the summary (T-004) and the standalone availability check (T-005). |
| T-008 depends on T-007 | Tests assert the prompt contracts after prompt edits. |
| T-009 depends on T-006, T-007 | Docs should match the implemented diagnostics and contracts. |
| T-010 depends on all implementation/doc tasks | Verify after code and docs settle. |

No cycles. Bottlenecks: T-001/T-002 establish the classification seam; T-004 blocks the status section; T-007 blocks prompt contract tests.

## 4. Test Strategy

- Unit tests with `node:test` and `node:assert/strict` for failure classification and diagnostics summary helpers.
- Runner tests using existing child-process test seams for timeout, malformed JSONL, non-zero exit, and spawn failure classification.
- Fallback tests ensuring `provider_or_model_unavailable` classification and fallback attempt metadata stay consistent.
- Delegation-log tests for recent failure cap, redacted hint, fallback summary, and success compatibility.
- `/blackbytes-status` tests for Sub-Agent Diagnostics rendering and secret redaction.
- Prompt contract regression tests for all builtin agents, including GPT variants where present.
- Verification commands in project order: `bun run lint && bun run typecheck && bun run build && bun run test`, plus `bun run check:size`; full final gate can use `bun run check`.

## 5. Migration / Rollback

Migration:

- No database migration.
- No required config migration.
- Existing YAML agents and builtin delegate tool schemas remain valid.

Backward compatibility:

- Existing delegate tool names and parameters remain unchanged.
- New classification/status details are additive.
- Final-output contracts are prompt-level expectations, not strict runtime parsers.

Rollback:

- Revert diagnostics/status section and prompt contract changes if they cause regressions.
- Classification helpers can be disabled from status without changing runner process control.

## 6. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | Classification requires brittle parsing of existing error strings. | Classify at runner/fallback boundary where typed control flow exists; avoid downstream string parsing — owner: invoker | open |
| R-002 | Status diagnostics duplicate existing Delegation ROI. | Reuse ROI summary and add only troubleshooting fields not already shown — owner: invoker | open |
| R-003 | Prompt contracts become too rigid. | Add compact headings only and test required presence, not full wording — owner: invoker | open |
| R-004 | Nested Pi availability check slows UI. | Use lazy/cached health checks with test seams — owner: invoker | open |
| Q-001 | Should lifecycle records be emitted on Pi event bus or kept internal first? | **Resolved: internal first.** The delegation log is already session-scoped in-memory; T-003 extends `DelegationEntry` with `failureKind` without event-bus exposure. Event bus can be revisited post-Phase 1 if diagnostics consumers emerge — owner: invoker | resolved |

## 7. Beads Handoff Notes

- Beads directory detected at `.beads/` with `beads.db` and `issues.jsonl`; use the `br`/`bv` ecosystem unless project tooling indicates otherwise.
- Suggested feature label: `feature:subagent-hardening`.
- Suggested service label: `service:sub-agents`.
- Convert after `plan-ready-for-beads` passes. Q-001 (event bus vs internal) resolved as "internal first" — no blocker.

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-06-07 | Bytes | Created Draft implementation plan from comparative sub-agent mechanism review |
| 2026-06-07 | Bytes | Gate review fixes: T-001 rewritten to extend existing `DelegateFailureKind` (no parallel type); T-002 AC clarified `malformed_jsonl`/`killed` detection requirements; T-003 scoped to reuse `AttemptSummary`/`formatAttempts()`; T-004/T-005 dependency corrected; T-006 AC narrowed to reuse existing data; Q-001 resolved as "internal first" |
| 2026-06-07 | Bytes | Plan review pass: T-002 AC expanded with concrete `malformed_jsonl` detection algorithm (malformed-line counter + no valid `agent_end` at close); T-003 cap specified (most recent ~100 entries, evict oldest) |
