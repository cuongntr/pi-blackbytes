# Sub-Agent Mechanism Hardening — Product + Technical Spec

> **Status**: Active (Phase 2 shipped)
> **Date**: 2026-06-07
> **Owner**: invoker
> **Variant**: brownfield (extends the existing Blackbytes sub-agent runtime and status surfaces)
> **Source / Motivation**: comparative review of `tintinweb/pi-subagents`, `nicobailon/pi-subagents`, and the current `pi-blackbytes` sub-agent implementation
> **Related docs**: [`README.md`](../../README.md), [`AGENTS.md`](../../AGENTS.md), [`prompt-system-hardening.md`](prompt-system-hardening.md)
> **Supersession (2026-08-03)**: The builtin Reviewer was later removed and its difficult-review contract merged into Oracle. See the current [`README`](../../README.md) and [`CHANGELOG`](../../CHANGELOG.md). Historical requirements below retain the five-agent phase wording.

---

## 1. Context

`pi-blackbytes` already has a strong sub-agent foundation: typed declarations, YAML user agents, strict tool isolation, nested `pi -p --mode json` execution, progress rendering, fallback models for eligible read-only agents, timeout enforcement, bounded output, secret redaction, routing metadata, and `/blackbytes-status` visibility.

The comparison against two independent `pi-subagents` implementations shows that Blackbytes should not copy either repo wholesale:

- `tintinweb/pi-subagents` is strongest at sub-agent lifecycle control: in-process low-latency execution, background jobs, queueing, steering, scheduling, and lifecycle events.
- `nicobailon/pi-subagents` is strongest at workflow orchestration: chains, async job reconciliation, artifact capture, intercom-like supervision, diagnostics, and acceptance gates.

Blackbytes' advantage is a simpler and safer process-isolated model. This feature selectively ports the highest-value, lowest-risk ideas while preserving the current design: process isolation, minimal dependencies, package budget, no recursive delegation, and predictable synchronous delegation by default.

## 2. Goals and Success Metrics

- **Improve observability**: sub-agent lifecycle events and diagnostics make failures easier to understand without reading debug logs.
- **Improve execution quality**: builtin agents return a more consistent final contract including verification evidence and risks.
- **Reduce context loss for large outputs**: optional artifact capture preserves full sub-agent output when the returned result is capped.
- **Enable simple multi-step delegation**: add a lightweight sequential chain primitive without turning Blackbytes into a full workflow engine.
- **Keep current safety/performance posture**: no new heavy runtime dependencies, no recursive delegation, no default async behavior, and no change to existing delegate tool contracts unless explicitly additive.

Measurable acceptance:

- `/blackbytes-status` has a Sub-Agent Diagnostics section covering nested Pi availability, recent failures, fallback attempts, timeout defaults/overrides, YAML loader diagnostics, and delegation ROI.
- Every builtin sub-agent prompt has a documented final-output contract tested by prompt regression checks.
- Large sub-agent outputs can be persisted to a session artifact file with a returned summary and path; secrets are redacted before persistence.
- A new chain executor can run 2–5 sequential steps using existing registered sub-agents, pass prior output to the next step, enforce a total timeout budget, and stop on first failure by default.
- Existing `delegate_explore`, `delegate_oracle`, `delegate_librarian`, `delegate_general`, and `delegate_reviewer` behavior remains backward compatible.
- `bun run check` passes and package size stays under the 500 KB gzipped budget.

## 3. Personas / Users

- **Primary — Bytes as parent agent**: needs clearer delegation diagnostics, consistent child output, and a safe way to compose small multi-step workflows.
- **Secondary — Blackbytes maintainer**: needs operational visibility into nested Pi spawn failures, fallback behavior, timeout causes, YAML loader issues, and output truncation.
- **Tertiary — advanced Pi user**: may define YAML agents and wants failures to be actionable without reading source code.

## 4. User Journeys

### Journey 1 — Diagnose a failed delegation

1. A parent agent calls `delegate_general` and the nested process times out.
2. The returned tool result classifies the failure as timeout, includes partial redacted output when available, and records the failure in the delegation log.
3. The user opens `/blackbytes-status` and sees the recent failed delegation, configured timeout, nested Pi availability, and recommended next action.

### Journey 2 — Review a large worker output

1. A sub-agent produces output larger than the return cap.
2. Blackbytes returns the bounded summary as today, plus an artifact path containing the full redacted output.
3. The parent can read the artifact when needed instead of losing detail or bloating the immediate context.

### Journey 3 — Run a simple multi-step chain

1. The parent asks for a sequence such as explore → oracle → reviewer.
2. A chain primitive runs each step sequentially using existing delegate infrastructure.
3. Each step receives the prior step's output under a clear heading.
4. The chain stops on failure unless configured to continue, returns a compact per-step summary, and records normal delegation metrics.

### Journey 4 — Verify implementation work consistently

1. `delegate_general` implements a bead or plan leaf.
2. Its final response includes summary, files changed, verification commands and outcomes, risks, and follow-ups.
3. The parent can decide whether to call `reviewer` or run additional verification without parsing free-form prose.

## 5. Functional Requirements

### REQ-001 — Sub-agent lifecycle events and failure classification

Priority: P0

Acceptance criteria:

- Emit internal lifecycle records/events for start, progress snapshot, fallback attempt, completion, failure, timeout, and artifact persistence.
- Extend the existing `DelegateFailureKind` taxonomy (already defined in `src/sub-agents/types.ts` and emitted by `classifyFailure()` in `runner.ts`) instead of adding a parallel type. The two genuinely missing distinctions are malformed JSONL (requires new detection — `handleLine()` currently swallows `JSON.parse` errors) and an externally-killed child (requires capturing the `close` handler's `signal` argument). Keep existing names such as `spawn_error` and `failed`; do not rename them.
- Preserve existing tool-result shape for callers; classification is additive through `details` and status summaries.
- Redact secrets in all event payloads and diagnostics.

### REQ-002 — `/blackbytes-status` sub-agent diagnostics

Priority: P0

Acceptance criteria:

- Add a Sub-Agent Diagnostics section to `/blackbytes-status`.
- Show nested Pi command availability or last spawn error without exposing env secrets.
- Show configured/default timeout per builtin and YAML agent, fallback eligibility, fallback model counts, YAML skipped-file diagnostics, recent failures, and delegation ROI.
- Disabled sub-agents are clearly marked or omitted consistently with existing status conventions.

### REQ-003 — Builtin final-output contracts

Priority: P0

Acceptance criteria:

- Each builtin prompt defines a compact final-output contract appropriate to its role.
- `general` includes summary, files changed, verification run, result, risks, and follow-ups.
- `reviewer` preserves severity-classified findings and verdict.
- `explore`, `oracle`, and `librarian` preserve citation/source requirements while adding explicit uncertainty/limits where relevant.
- Regression tests guard the required headings/contract language without overspecifying full prompt text.

### REQ-004 — Redacted artifact capture for large outputs

Priority: P1

Acceptance criteria:

- When a nested result exceeds the existing return cap, Blackbytes can persist the full redacted output to a session-scoped artifact directory.
- Returned result includes summary, cap/truncation note, and artifact path.
- Artifact path is deterministic enough for status/debugging but does not leak secrets.
- Artifact capture is opt-in or conservative by default and bounded by file-size/retention limits.

### REQ-005 — Lightweight sequential chain primitive

Priority: P1

Acceptance criteria:

- Provide a chain executor that runs named existing sub-agents sequentially.
- Supports passing previous step output to the next step.
- Supports total timeout budget and per-step timeout inherited from snapshots unless overridden.
- Stops on first failed step by default.
- Rejects recursive `delegate_*` tool leakage and reuses the existing finalization/runtime overlay path.
- Does not implement dynamic fanout, cron scheduling, background polling, or inter-agent chat in Phase 1.

### REQ-006 — Documentation, tests, and compatibility

Priority: P1

Acceptance criteria:

- README/AGENTS document diagnostics, artifact capture, and chain limitations if shipped.
- Tests cover lifecycle classification, status diagnostics, prompt contracts, artifact redaction/capping, and chain execution.
- Existing delegate tests continue to pass.
- `bun run check` passes.

## 6. Roadmap Phases

### Phase 1 MVP — observability + output quality

Exit criteria:

- Lifecycle/failure classification is recorded and surfaced.
- `/blackbytes-status` has Sub-Agent Diagnostics.
- Builtin final-output contracts are updated and tested.
- No public delegate API breakage.

### Phase 2 MVP — artifact capture + lightweight chains

Exit criteria:

- Large redacted outputs can be saved as artifacts.
- A simple sequential chain primitive exists and is tested.
- Chain scope remains intentionally narrow: no dynamic fanout, scheduler, async job polling, or supervisor intercom.

### Phase 3 Evaluation — async/steering/scheduling spike

Exit criteria:

- Decide whether background jobs, steering, or scheduling justify their complexity in Blackbytes.
- Any accepted item gets a separate spec/change before implementation.

## 7. Non-Functional Requirements

- **Safety**: nested sessions still receive no `delegate_*` tools; read-only/full-access boundaries remain enforced.
- **Security**: all diagnostics, artifacts, and lifecycle payloads run through existing secret redaction.
- **Performance**: no default extra nested process; diagnostics and artifact writes must be cheap and bounded.
- **Maintainability**: prefer small modules and tests over a large orchestration file.
- **Compatibility**: existing delegate tools and YAML agents remain valid.
- **Package budget**: no new heavy runtime dependency; keep gzipped package under 500 KB.

## 8. Out of Scope

- Replacing nested CLI spawning with in-process SDK sessions.
- Full background async job management with polling and result retrieval.
- Mid-run steering of existing nested Pi sessions.
- Cron/interval scheduled agents.
- Dynamic fanout from structured output.
- Supervisor/intercom chat between parent and child.
- User-defined chain YAML format in Phase 1.

## 9. Technical Design

### 9.1 Boundaries

This design owns:

- Additional sub-agent runtime observability and status diagnostics.
- Failure classification around the existing nested Pi runner.
- Prompt-level output contracts for builtin sub-agents.
- Optional artifact persistence for large returned outputs.
- A small sequential chain executor built on existing delegate machinery.

This design does not own:

- Pi core session lifecycle or provider internals.
- A full workflow engine.
- Cross-repository orchestration.
- Any weakening of tool isolation or nested recursion protection.

### 9.2 Architecture

```text
src/sub-agents/runner.ts
  └─ classify child process failures + expose structured details

src/sub-agents/delegation-log.ts
  └─ extend session-scoped metrics with classification, fallback attempts, artifact path

src/sub-agents/artifacts.ts        # new
  └─ session artifact dir, redacted bounded writes, retention helpers

src/sub-agents/final-output.ts     # new or test helper
  └─ shared constants/tests for builtin final-output contracts

src/sub-agents/chain.ts            # new, Phase 2
  └─ sequential step executor using existing register/run path semantics

src/commands/blackbytes-status.ts
  └─ Sub-Agent Diagnostics section

src/sub-agents/{explore,oracle,librarian,general,reviewer}.ts
  └─ prompt contract updates only
```

### 9.3 Lifecycle and failure classification

`runNestedPi()` already has the core enforcement points: spawn, JSONL parsing, timeout, kill grace, stdout/stderr bounding, and result construction. It **already classifies failures** via the existing `DelegateFailureKind` type (`src/sub-agents/types.ts`) and the `classifyFailure()` helper (`src/sub-agents/runner.ts`), threaded through every `DelegateResult` and surfaced by `formatDelegateFailure()`. Phase 1 **extends** that existing taxonomy rather than introducing a parallel `SubAgentFailureKind`.

Current `DelegateFailureKind` values:

```ts
type DelegateFailureKind =
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "recursion_refused"
  | "cli_usage_error"
  | "invalid_tool_allowlist"
  | "provider_or_model_unavailable";
```

Phase 1 adds only the distinctions the runner cannot currently make. Keep the established names (do **not** rename `spawn_error`→`spawn_failed` or `failed`→`child_exit_nonzero`) to avoid churn in `runner.ts`, `register.ts`, `fallback.ts`, and tests:

- `malformed_jsonl` — **new behavior required**: `handleLine()` swallows `JSON.parse` errors silently (intentional, to skip banner lines). This kind means detecting that the stream produced no valid `agent_end` while malformed `{...}` lines were seen — not relabeling an existing path.
- `killed` — **new capture required**: distinguish an externally killed child (OS/OOM signal) from our own timeout/cancel. `child.on("close", ...)` must read the `signal` argument (only `_code` is captured today); a non-null signal we did not request maps to `killed`.

The classification feeds both the returned `details` and the delegation log. Existing fallback classification for `provider_or_model_unavailable` (in `fallback.ts`) remains the source of truth for fallback eligibility.

### 9.4 Status diagnostics

`/blackbytes-status` already reports enabled resources, redacted config, routing, and delegation ROI. The new section should reuse existing data where possible:

- agent snapshot: model, reasoning effort, timeout, fallback count, execution mode;
- YAML loader diagnostics;
- delegation log summary and recent failure list;
- nested Pi spawn health, checked lazily or from the last runner error;
- artifact count/path summary when artifact capture is enabled.

Do not run expensive health checks on every status render. Cache lightweight checks per session or compute only when the section is opened.

### 9.5 Final-output contracts

Prompt changes should be short and role-specific. Avoid verbose schemas that make workers overfit formatting. The minimum contracts are:

- `general`: `Summary`, `Files changed`, `Verification`, `Risks`, `Follow-up`.
- `reviewer`: existing `Findings` with severity groups and `Verdict`.
- `explore`: `Where to look`, `Key findings`, `Caveats` with file references.
- `oracle`: `Answer`, `Reasoning`, `Assumptions`, `Actionable next steps` for complex cases.
- `librarian`: `Sources`, `Findings`, `Recommendation`, `Confidence / gaps`.

Tests should assert required headings or phrases, not entire prompt snapshots.

### 9.6 Artifact capture

Artifact capture should run after the nested result is redacted and before `boundReturnContent()` discards the middle/tail detail. Store artifacts under a session-scoped directory, for example:

```text
$PI_AGENT_DIR/blackbytes/artifacts/sub-agents/<session-or-date>/<agent>-<timestamp>.md
```

The exact path should use project conventions and avoid secrets. If `$PI_AGENT_DIR` is unavailable, fall back to a safe directory under the user Pi agent directory.

Retention and limits:

- cap single artifact size;
- avoid writing empty/small outputs;
- write with safe permissions where possible;
- include metadata header: agent, startedAt, duration, model, classification, redaction note.

### 9.7 Lightweight chain executor

Phase 2 adds a narrow chain executor, not a full chain DSL. Initial API can be internal or exposed as a tool only after tests prove the contract.

Conceptual input:

```ts
interface ChainStep {
  agent: "explore" | "oracle" | "librarian" | "general" | "reviewer" | string;
  task: string;
  context?: string;
  timeoutMs?: number;
}
```

Execution rules:

1. Resolve each agent through the existing snapshot/enablement path.
2. Compose step input from `task`, optional `context`, and previous output under a clear `## Previous step output` heading.
3. Run sequentially under one total budget.
4. Stop on first failure by default.
5. Return compact per-step summaries and artifact paths if any.

No dynamic fanout, background mode, user YAML chain files, or inter-agent communication in this phase.

### 9.8 Backward Compatibility

- Existing delegate tool names, schemas, and output success/failure semantics stay valid.
- New diagnostics are additive.
- Artifact capture must not force callers to read files to get the normal bounded result.
- Chain support must not alter individual delegate behavior.
- YAML agents remain optional and do not need new fields.

### 9.9 Testing Strategy

Use the project test stack: `node:test`, `node:assert/strict`, existing Pi mocks, and focused module tests.

- Unit tests for failure classification and redaction.
- Runner tests for timeout, malformed JSONL, non-zero exit, and spawn failure classification.
- Delegation-log tests for recent failure/fallback/artifact metadata.
- Status tests for diagnostics rendering and redaction.
- Prompt tests for final-output contracts.
- Artifact tests for cap behavior, safe path construction, redaction, and no-write-for-small-output behavior.
- Chain tests with mocked sub-agent runner for sequential execution, previous-output propagation, failure stop, disabled agent rejection, and total timeout budget.
- Final verification: `bun run check`.

### 9.10 MVP Scope Summary

Phase 1 includes REQ-001, REQ-002, REQ-003, and the compatibility/test portions of REQ-006. Phase 2 includes REQ-004 and REQ-005. Async background jobs, steering, scheduling, dynamic fanout, and intercom-like supervision are deliberately deferred to a later decision.

## 10. Migration / Rollback

Migration:

- No data migration.
- No required config migration.
- New artifact capture settings, if added, default to conservative/off behavior.

Rollback:

- Disable any new chain/artifact settings if exposed.
- Revert prompt-contract changes if they degrade worker quality.
- Existing delegate tools continue to work without the new diagnostics because diagnostics are additive.

## 11. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | Diagnostics become noisy and duplicate existing Delegation ROI/status sections. | Keep one dedicated section; reuse existing summaries instead of adding parallel concepts — owner: invoker | open |
| R-002 | Prompt output contracts make agents too rigid. | Require compact headings only; avoid JSON-only output or over-specified templates — owner: invoker | open |
| R-003 | Artifact capture writes sensitive content. | Redact before write; add tests with representative secret keys; document that local artifacts may still contain user-provided non-secret sensitive context — owner: invoker | open |
| R-004 | Chain primitive grows into a workflow engine. | Phase 2 explicitly excludes fanout, async polling, scheduler, intercom, and YAML chain DSL — owner: invoker | mitigated |
| R-005 | Status health checks slow session UI. | Lazy/cache health checks; do not spawn Pi just to render the compact overview — owner: invoker | open |
| Q-001 | Should chain be exposed as a public tool or remain internal first? | Decide during Phase 2 after internal tests — owner: invoker | open |
| Q-002 | Where exactly should artifacts live under `$PI_AGENT_DIR`? | Confirm against Pi conventions before implementation — owner: invoker | open |

## 12. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-06-07 | Bytes | Created Draft spec from comparative sub-agent mechanism review |
| 2026-06-07 | Bytes | Gate review fixes: §9.3 rewritten to reference existing `DelegateFailureKind`/`classifyFailure()` and extend (not replace); REQ-001 AC updated to require extending existing taxonomy; `malformed_jsonl` and `killed` detection requirements made explicit |
