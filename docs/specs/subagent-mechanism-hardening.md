# Sub-Agent Mechanism Hardening — Product + Technical Spec

> **Status**: Accepted (Phase 3 product amendment only; Phases 1–2 remain shipped)
> **Date**: 2026-06-07
> **Owner**: invoker
> **Variant**: brownfield (extends the existing Blackbytes sub-agent runtime and status surfaces)
> **Source / Motivation**: comparative review of `tintinweb/pi-subagents`, `nicobailon/pi-subagents`, and the current `pi-blackbytes` sub-agent implementation
> **Related docs**: [`README.md`](../../README.md), [`AGENTS.md`](../../AGENTS.md), [`prompt-system-hardening.md`](prompt-system-hardening.md)
> **Supersession (2026-08-03)**: The builtin Reviewer was later removed and its difficult-review contract merged into Oracle. See the current [`README`](../../README.md) and [`CHANGELOG`](../../CHANGELOG.md). Historical requirements below retain the five-agent phase wording.
> **Phase 3 amendment (2026-09-08)**: [§13](#13-phase-3-mvp--reliable-delegation-product-amendment) owns the current Intake and accepted product requirements. Sections 1–12 retain the historical baseline; their technical design and implementation plans do not authorize Phase 3. Phase 3 design §14 is Active following invoker approval; implementation and pilots remain unauthorized.

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
| 2026-09-08 | Bytes | Added Phase 3 Reliable Delegation Intake/product amendment (§13), canonical routing, REQ-007–REQ-012, acceptance scenarios, and approval/design questions; moved spec to Review without changing shipped requirements or plans |
| 2026-09-08 | invoker / Bytes | Invoker approved scope and all three proposed defaults via the Intake questionnaire; recorded P3-Q-001 answered and `prd-ready: PASS`, accepting product requirements only; design, implementation, and pilot approvals remain separate |

## 13. Phase 3 MVP — Reliable Delegation Product Amendment

**Status:** Accepted — scope/defaults approved by invoker on 2026-09-08; not a design or implementation approval.

**Owner:** invoker; drafting and gate self-assessment: Bytes.

**Date:** 2026-09-08.

**Scope of this amendment:** accepted product requirements only. The separate-status [Phase 3 Technical Design](#14-phase-3-technical-design--reliable-delegation) is drafted in §14; product approval does not activate that design.

### 13.1 Routing Decision

- **Variant preset:** brownfield — harden the existing one-level delegation experience.
- **Triggered risks:** materially changed product behavior; consumed model/config and result contracts; cross-module design ambiguity; writer execution boundaries. Delivery contains multiple independently verifiable outcomes and a design → implementation handoff, not one settled local edit.
- **Required artifacts/gates:** this PRD amendment → `prd-ready`; a Phase 3 extension of this spec's technical design → `design-ready`; a phase-specific plan under `docs/plans/` → `plan-ready-for-beads`; conversion and standard `feature-done` closure. An ADR is conditional on design introducing a durable architectural decision beyond the current conventions; none is required at Intake.
- **Execution path:** plan → converter, only after product approval and design/plan gates. No Phase 3 Beads are created at Intake; existing approved plans remain unchanged.
- **Exceptions:** none. No gate is waived by the earlier successful repository audit.
- **Decided:** 2026-09-08 — Bytes selected the workflow route; invoker approved the product scope/defaults through the Intake questionnaire (see §13.8).
- **Supersedes:** no prior persisted Phase 3 Routing Decision was found. This accepted amendment replaces the proposed [Phase 3 async evaluation](#phase-3-evaluation--asyncsteeringscheduling-spike) as the next delivery scope; those platform features remain deferred. Phases 1–2 are not reopened.

### 13.2 Intake Evidence and Reuse

The user requested a careful assessment of what an orchestration upgrade would actually improve,
then authorized the next workflow step. The recommendation is **reliable delegation**, not more
agents or a larger orchestration platform. Neither implementation nor live worker pilots have been
authorized by this Intake.

Baseline reviewed: commit `e138229`, Blackbytes `3.0.0`, installed Pi `0.85.1`. Earlier in this session,
`bun run check` passed with 912 tests and the package-size gate. This establishes a regression
baseline, not evidence that the proposed behavior already works. Supported version requirements must
be taken from the current [`package.json`](../../package.json); the installed Pi observation is not
proof for every supported Pi version.

| Reusable source / evidence | Phase 3 treatment |
|---|---|
| This spec and [Phase 1 plan](../plans/subagent-mechanism-hardening-implementation-plan.md), [Phase 2 plan](../plans/subagent-mechanism-hardening-phase2-plan.md) | Reuse the same product/runtime owner and existing diagnostics, prompt contracts, artifact support, and tests; do not duplicate their shipped work. |
| [Production-readiness spec](production-readiness-hardening.md) and [plan](../plans/production-readiness-hardening-implementation-plan.md) | Preserve process-group cancellation, valid terminal-event checks, and per-attempt fallback prompts. Their historical Draft labels alone do not mean implementation is missing. |
| [Prompt-system spec](prompt-system-hardening.md) and [v3.0.0 changelog](../../CHANGELOG.md) | Keep four builtin agents. Model inheritance will require an explicit design delta to the historical no-override prompt-family behavior; do not silently reinterpret its tests. |
| `.beads/issues.jsonl`, inspected read-only | Snapshot contains 189 closed entries, 23 tombstones, and no open/in-progress entries. Related epics `pib-subagent-hardening-cikr`, `pib-t4am`, and `pib-production-readiness-hardening-r72t` are closed. No `.beads/beads.db` exists in this checkout, so this is snapshot evidence only, not a claim about external/live tracking state. No import, export, or tracker mutation was performed. |
| Supplied `codex-agent-orchestration-deep-dive` research | Inspiration, not a Pi API contract or proof of ROI. The newer personal guide explicitly lacks live verification; historical scripts/config are not installation instructions for Blackbytes. |

The audit identified concrete gaps:

- Without an explicit delegate model, the child may choose its own saved/default model instead of
  the parent's active model. A model-specific prompt must correspond to the actual child model.
- Blackbytes recognizes a legacy agent-home variable while installed Pi uses the official one;
  configuration and nested runtime resolution can therefore diverge.
- General receives a prefix of the working directory's `AGENTS.md`, not guaranteed relevant
  ancestor/nested instructions; truncation can omit an important constraint.
- Write-capable delegates share the working directory and can run in parallel by default. Local
  file-edit queues do not coordinate separate child processes.
- General is encouraged to use defaults even for critical missing details, risking implementation
  against a false premise. A successful child process does not prove task completion or verification.

Source pointers: [`register.ts`](../../src/sub-agents/register.ts),
[`runner.ts`](../../src/sub-agents/runner.ts), [`snapshot.ts`](../../src/sub-agents/snapshot.ts),
[`config/loader.ts`](../../src/config/loader.ts),
[`general-safety-overlay.ts`](../../src/sub-agents/general-safety-overlay.ts),
[`general.ts`](../../src/sub-agents/general.ts), and
[`Bytes overlay`](../../src/system-prompt/bytes/overlay.ts).

### 13.3 Outcomes, Actors, and Journeys

Reuse [the existing affected actors](#3-personas--users): the parent needs a trustworthy handoff,
the maintainer needs diagnosable behavior, and advanced users need their model/config/YAML choices
respected. No new supervisor/operator role is introduced.

| Outcome | User benefit | Observable success evidence |
|---|---|---|
| Delegate correctly | Fewer surprises about the model, agent home, and applicable instructions. | Every deterministic model/config fixture uses the expected resolution or reports an actionable failure; instruction fixtures disclose omissions rather than asserting complete coverage. |
| Execute within limits | Less wrong-premise rework and lower accidental writer-collision risk. | No overlapping managed writer executions under the default same-parent policy; critical-premise scenarios return evidence before incompatible work, while clear tasks need no new approval round trip. |
| Hand off honestly | Less transcript inspection and fewer false completion claims. | All incomplete/failed-verification fixtures remain distinguishable from verified completion; handoffs expose actual checks and remaining work. |

**Clear implementation journey:** the parent delegates a bounded change in natural language. The
child receives the intended execution context, inspects applicable instructions and existing changes,
implements within scope, self-reviews, and reports checks actually run. The parent can accept the
result or request proportionate independent review without first reconstructing the entire transcript.

**False-premise journey:** repository evidence contradicts a critical assumption in the assignment.
General does not invent a new API contract, dependency, or scope. It returns the contradiction,
consequences, any partial work, and the smallest decision needed. The parent resolves it; there is no
persistent worker waiting for a reply and no automatic resumption.

**Concurrent-work journey:** the parent submits two write-capable delegates. The default policy
prevents their managed executions from overlapping within that parent session. Independent read-only
research remains eligible for parallel execution. The user is explicitly told that another Pi session,
the parent itself, an external editor, or a background process is not covered by this protection.

**Value measurement:** later compare equivalent, invoker-approved tasks against the baseline using
user interventions, rework cycles, time to an acceptable result, and model cost. Report raw counts,
case selection, and tradeoffs; do not infer savings from tool-call count or execution success rate.
No percentage speedup, token reduction, or ROI improvement is claimed at Intake.

### 13.4 Functional Requirements

These are **accepted product requirements**, not an implementation-ready API. Wire formats, configuration
precedence details, enforcement mechanisms, and status rendering belong in Technical Design.

#### REQ-007 — Predictable effective model

**Priority:** P0. **Acceptance criteria:**

- An explicit per-agent model continues to win. Without one, the delegate uses the parent's active
  model at invocation time; a parent model switch affects the next invocation, not an already-running
  child. The child must not silently select an unrelated saved/default model.
- Each attempt's prompt family matches its effective model, including existing eligible read-only
  fallback attempts. Explicit model and reasoning settings remain respected; automatic retry of a
  write-capable delegate remains prohibited.
- If the intended model cannot be resolved or used, the outcome is actionable and does not claim
  that model ran. Existing explicitly configured read-only fallback remains allowed and visible.
- Tests cover explicit override, inheritance, parent model switch, unavailable model, and fallback
  family changes. The design must distinguish resolved intent from evidence of the actual attempt.

#### REQ-008 — Consistent agent-home configuration

**Priority:** P0. **Acceptance criteria:**

- Default-home, official Pi custom-home, and legacy Blackbytes custom-home setups each have
  deterministic, documented behavior across parent configuration, user-defined agents, nested Pi,
  and optional artifact location. A custom home must not silently fall back to the unrelated default.
- When both home settings exist and disagree, precedence or refusal is explicit and tested; diagnosis
  identifies the selected configuration source without revealing credentials or configuration content.
- Existing configurations remain usable through a documented compatibility path. No automatic
  credential copying, user-home rewriting, or settings migration occurs.

#### REQ-009 — Relevant instructions with visible provenance

**Priority:** P0. **Acceptance criteria:**

- A write-capable delegate receives a discoverable account of applicable project instructions and
  their source paths. Fixtures include a repository invoked from a subdirectory, nested target-file
  instructions, and a critical constraint beyond the current short root-file prefix.
- Before changing a target, the worker is directed to obtain that target's applicable instructions;
  discovering new target scope requires checking its instructions too. An omitted, unreadable, or
  bounded source is disclosed, not represented as fully loaded. If it affects safe execution and
  cannot be recovered, the affected work follows REQ-011 instead of silently proceeding.
- Higher-priority host/user instructions and current tool permissions still govern. Project files
  cannot grant additional tools or authorize scope expansion. Reported provenance is not proof that
  an LLM obeyed every instruction; prompt behavior and runtime enforcement must be described separately.

#### REQ-010 — Conservative writer scheduling

**Priority:** P0. **Acceptance criteria:**

- By default, no more than one Blackbytes-managed write-capable delegate executes at a time within
  a parent session. Apply the policy by mutation capability, including YAML agents, not only the
  builtin General name. Read-only delegates retain their parallel eligibility.
- Any retained explicit parallel-writer opt-in is documented as an escape hatch with weaker protection,
  not proof of isolated workspaces. Existing execution-mode configuration requires a compatibility
  decision before implementation; it must not silently bypass a claimed safety guarantee.
- Cancellation, failures, and waiting work do not leave the session permanently unable to delegate;
  a cancelled waiting invocation must not start later. Deterministic fixtures verify overlap and
  recovery rather than relying on prompt wording alone.
- The documented boundary is this parent session's managed delegates only: no cross-session/repo
  lock, parent/editor coordination, background-descendant ownership, or OS sandbox is promised.

#### REQ-011 — Evidence-backed critical escalation

**Priority:** P0. **Acceptance criteria:**

- If evidence invalidates a required behavior/API assumption, shows a missing necessary dependency,
  requires an unauthorized destructive action, or exposes an unresolved instruction conflict,
  General stops the affected work and returns evidence plus the smallest parent decision needed.
- The handoff distinguishes a premise needing reconsideration, a dependency/scope decision, and an
  external blocker. These are outcomes, not permission to alter the plan, install dependencies,
  expand scope, or contact another agent. Exact labels are a design decision.
- Missing harmless implementation details still use reasonable in-scope defaults; clear-task fixtures
  must not acquire unnecessary clarification rounds or mandatory plan files.
- Existing dirty/untracked work is inspected and preserved. If a blocker is discovered after safe
  partial edits, report those edits and verification limits; do not hide them, reset unrelated work,
  or claim the checkout is unchanged.

#### REQ-012 — Truthful, lightweight handoff

**Priority:** P0. **Acceptance criteria:**

- General's handoff distinguishes completed work, incomplete/blocked work, and required decisions.
  It names changed scope, verification commands and observed outcomes, checks not run with reasons,
  material risks, and any remaining work. Other builtin roles retain their role-specific contracts.
- A successful process, an agent's completion claim, observed verification, and parent/user acceptance
  remain distinct. Runtime success alone never becomes a claim of verified task completion or deploy
  authorization. Missing, malformed, or contradictory task-outcome evidence remains unknown rather
  than being optimistically treated as complete; legacy YAML agents are not required to adopt a new
  output format merely to remain callable.
- Tests include a successful process reporting a blocker, a failed check, an unrun check, partial
  edits, and a legacy/free-form output. The normal bounded result remains understandable without
  requiring a transcript or artifact read for routine tasks.
- General self-review is not advertised as independent review. Difficult/high-risk independent review
  still uses read-only Oracle with enough evidence to evaluate the changed candidate; passing the
  author's summary alone does not establish independence. Full candidate snapshotting is out of scope.

### 13.5 Constraints, Data Policy, and Non-Goals

- **Usability/performance:** keep natural-language delegate inputs, four builtin roles, one-level
  synchronous execution, and no additional model calls by default. No mandatory workspace protocol
  file or JSON-only handoff. Bound added context/metadata structurally; never inject token/context
  scarcity awareness into workers. Writer serialization may reduce throughput; measure and disclose it.
- **Security:** preserve tool allowlists, recursion protection, restricted environment forwarding, and
  existing redaction of diagnostics/progress/errors/artifacts. General's bash and ambient extension
  execution are not OS-isolated. No new privilege or ambient-resource isolation claim is introduced.
- **Successful-output policy:** successful content is currently returned without blanket redaction;
  preserve that behavior for this phase rather than silently corrupting code snippets. Such content
  may contain sensitive data and may persist in parent session history. New diagnostic metadata must
  be redacted. Any broader successful-output filtering requires a separately approved data policy and
  content-integrity evidence; this phase does not promise secret-free successful output.
- **Availability:** retain timeout/cancel cleanup and existing read-only fallback behavior; no new SLA,
  retry for writers, crash-recovery service, or recovery after abrupt host death is promised.
- **Compatibility/quality:** existing public delegate names and natural-language calls remain valid;
  YAML agents need no mandatory new fields. Model/home resolution, default writer scheduling, and
  completion interpretation are deliberate behavior changes requiring design-level compatibility
  tests, user-facing documentation, and rollback guidance. Preserve the package's supported platforms
  and versions; `bun run check` and the existing <500 KB gzip gate remain mandatory at delivery.
- **Explicitly out of scope:** persistent/background workers, async scheduler, Supervisor, restored
  Reviewer, recursive delegation, automatic worktree lifecycle, cross-session locks, full candidate
  snapshot engine, acceptance registry, and default always-on independent review. The internal chain
  remains internal; do not expose it or assume it already follows all registered-delegate policies.

**Dependencies:** current Pi nested-CLI/tool scheduling behavior, model/provider availability, local
project instruction files, and Blackbytes configuration/registration/output surfaces. Phase 3 owns
Blackbytes-managed resolution, policy, and handoff behavior; it does not own Pi core, external provider
correctness, repository-wide isolation, or the user's final acceptance/deploy authority.

### 13.6 Acceptance Evidence and Phase Exit

The delivery plan must map every requirement to deterministic tests and identify which semantic
claims also require an approved model-backed pilot. Prompt-string tests alone do not prove that an
agent honors an escalation or preservation instruction.

| Scenario | Required evidence |
|---|---|
| Intended model/config | Fixture captures for override, inherited model switch, unavailable model, fallback, default/custom/conflicting homes; no silent unintended resolution. |
| Clear task | An in-scope implementation completes without new mandatory files or unnecessary permission questions; actual checks are reported. |
| False premise / missing dependency | Evidence-backed decision handoff before incompatible work; harmless ambiguity remains non-blocking. |
| Dirty checkout / nested instructions | Pre-existing dirty/untracked work preserved; applicable instruction beyond the former prefix/nested scope is obtained, or affected work explicitly blocked. |
| Writer concurrency | Deterministic overlap and cancellation/recovery checks for builtin and YAML writers; read-only parallel eligibility preserved; escape-hatch behavior explicit if retained. |
| Incomplete verification | Blocked/partial/unverified/legacy results are not presented as verified completion merely because the process exits successfully. |

**Phase 3 MVP exit:** REQ-007–REQ-012 and applicable existing REQ-006 compatibility/documentation checks
are satisfied; full repository verification passes; changed defaults and residual safety limits are
documented. Required behavioral evidence is run under an approved pilot protocol, or its absence is
recorded as an explicit invoker-owned exception, never an unqualified PASS. A result cannot claim
measured ROI without comparative data. No Phase 3 acceptance is inferred from closed Phase 1/2 Beads.

**Pilot approval boundary:** define representative paired cases, models/settings, isolated disposable
checkouts, intervention/rework counting rules, run count, and cost/time ceiling before execution.
Baseline and candidate must use comparable task inputs and model settings; intentional model
resolution differences must be recorded. No model-backed pilot, implementation/review pilot, sandbox
installation, or source/configuration change has been performed as part of this Intake; the only
checkout edit is this spec amendment.

**Later evaluation, not a committed phase:** consider async/persistent orchestration only if measured
usage demonstrates a need that this synchronous model cannot meet. Entry requires a new scope/routing
decision and approval; there is no implicit platform roadmap in this amendment.

### 13.7 Open Decisions and Risks

| ID | Decision / risk | Owner | Status / gate |
|---|---|---|---|
| P3-Q-001 | Approve the scope and three consequential defaults: inherit active parent model when unset; serialize managed writers by default; preserve successful-output content rather than blanket-redact it. | invoker | Answered — approved 2026-09-08 via Intake questionnaire; product requirements only, no implementation or live-pilot authorization. |
| P3-Q-002 | Set exact model/reasoning behavior when parent identity is unavailable, official/legacy home precedence and conflict handling, and supported-version compatibility proof. | Bytes drafts; invoker approves design | Resolved — D-01/D-02 approved 2026-09-08; compatibility execution remains a delivery obligation. |
| P3-Q-003 | Define applicable instruction discovery/ordering, symlink/path boundaries, missing/oversized-source recovery, and provenance without pretending prompt instructions are OS enforcement. | Bytes drafts; invoker approves design | Resolved — D-03 approved 2026-09-08; instruction coverage requires delivery evidence. |
| P3-Q-004 | Select writer enforcement and cancellation behavior, treatment of existing explicit parallel configuration, and exclusions for internal chain/direct runner paths. | Bytes drafts; invoker approves design | Resolved — D-04 approved 2026-09-08; no cross-session guarantee. |
| P3-Q-005 | Set the smallest task-outcome/handoff representation and consumers, unknown/legacy behavior, diagnostic redaction, and default/GPT prompt parity; no mandatory JSON protocol. | Bytes drafts; invoker approves design | Resolved — D-05 approved 2026-09-08; text claims remain distinct from host verification. |
| P3-Q-006 | Approve pilot cases, isolated workspace scope, repetitions and spend/time ceiling, or explicitly accept unmeasured behavioral/ROI limits. | invoker | Open — required before live pilot; no release/pilot date or budget assumed. |
| P3-R-001 | More escalation can create needless questions and slow normal work. | Bytes | Open — constrain to critical, evidence-backed decisions; pair false-premise and clear-task scenarios. |
| P3-R-002 | Inherited models can change cost/quality; writer serialization can reduce throughput. | invoker | Tradeoff accepted 2026-09-08 — compatibility documentation and outcome measurement remain delivery obligations; no speed/ROI claim. |
| P3-R-003 | Users may mistake status/provenance for sandboxing or independent verification. | Bytes | Open — explicit scope and evidence distinctions in design, tests, prompts, and docs. |

### 13.8 Intake Gate Record

**2026-09-08 — `prd-ready` self-assessment by Bytes:** content checks pass: explicit status and owner,
canonical routing, reused actors and end-to-end journeys, three observable outcomes, six identified/
prioritized requirements with scenario AC, performance/security/availability boundaries, non-goals,
phase exit, owned questions, and revision history. No implementation schemas or selected mechanisms
are introduced in this product amendment.

**Approval provenance:** initially held in Review for P3-Q-001. The invoker then selected
“Duyệt ba mặc định (Recommended)” in the Intake questionnaire on 2026-09-08, approving the scope and
three defaults described in P3-Q-001. The choice explicitly covered inheritance cost implications,
same-parent writer protection/throughput limits, and the residual sensitive-content risk of preserving
successful output. It explicitly excluded implementation and live-pilot authorization.

**Gate disposition: `prd-ready: PASS` (2026-09-08).** Product amendment Accepted; no gate exception.
Next: prepare the Phase 3 Technical Design and resolve P3-Q-002–P3-Q-005 before `design-ready`.
Existing historical §9 does not satisfy that gate. At Intake closure, no Phase 3 design, plan, Beads,
code/config change, or live pilot had been produced. The later design record is in §14.

## 14. Phase 3 Technical Design — Reliable Delegation

**Status:** Active — D-01–D-05 approved by invoker on 2026-09-08; implementation and pilots remain separately gated.

**Owner:** invoker. Design and gate assessment: Bytes. **Date:** 2026-09-08.

**Sources:** [accepted requirements §13.4](#134-functional-requirements),
[canonical routing §13.1](#131-routing-decision), [project conventions](../../AGENTS.md),
[package compatibility contract](../../package.json), [historical design §9](#9-technical-design).
No governing ADR, architecture directory, or project design template was found. No new technology,
storage service, or reversal of an active ADR is introduced; decisions remain in this design extension.
Sections 1–12 and shipped plans remain historical baselines, not the Phase 3 implementation authority.

### 14.1 Boundary and Current Evidence

Owns registered `delegate_*` invocation context, same-parent writer admission, discoverable project
instructions, and truthful parent/UI handoff. Reuses nested CLI isolation, tool finalization, runner
cleanup, read-only fallback, redaction, and bounded artifacts. No new public tool or required YAML field.

Does not own Pi model/provider internals, OS sandboxing, external editors, parent writes, independent
Pi sessions, background descendants, or acceptance/deployment authority. Internal `executeChain()` and
direct `runNestedPi()` callers remain outside registered-delegate admission/model inheritance and
instruction policy; runner-wide env changes still apply to them. No public chain or automatic retry of writers.

Verified source seams on 2026-09-08:

| Seam | Existing behavior / proposed owner |
|---|---|
| `registerSubAgent()` in `src/sub-agents/register.ts` | Tool callback narrows ctx to cwd; prepares overlays, finalized tools, progress, fallback, return text. Own invocation-time model and writer gate here. |
| `executeWithFallback()` in `src/sub-agents/fallback.ts` | Both fast and retry paths overwrite runOpts.model with snapshot.model. Feed an invocation-local snapshot copy; changing runOpts alone is insufficient. |
| `buildGeneralSafetyOverlay()` | Reads only cwd/AGENTS.md and embeds its first 4096 characters. Replace that excerpt with a bounded discovery manifest and recovery instructions. |
| `runNestedPi()` / `DelegateResult` | Exit 0 plus agent_end determines success; not a verification verdict. Keep that meaning and existing failure taxonomy. |
| `resetSessionRuntimeState()` / session handlers | Reset synchronous singleton state; new admission controller needs explicit asynchronous shutdown/drain before reset, not a blind mutex reset. |
| Pi package versions | Local node_modules is 0.83.0; installed global package is 0.85.1. Both expose tool ctx.model/modelRegistry, executionMode, and PI_CODING_AGENT_DIR. package.json peers are >=0.83.0 <1 and Node >=22.19.0; older AGENTS version prose is stale, not the compatibility floor. |

Pi evidence: package-relative `dist/core/extensions/types.d.ts`, `dist/core/model-registry.d.ts`,
`dist/config.js`, README environment/CLI sections; installed `docs/extensions.md`,
`docs/environment-variables.md`, and `examples/extensions/model-status.ts`. These are source/type
observations, not completed compatibility tests or a promise about every future version <1.

### 14.2 Components and Interaction

```text
session_start -> shared agent-home resolver -> config / YAML / snapshot / registration
                                           -> admission controller for this parent runtime

delegate execute -> capture cwd + parent model + snapshot at entry
                 -> finalize allowlist + resolve exact model intent
                 -> writer? acquire FIFO admission : bypass
                 -> build mandatory writer instruction manifest + optional persona overlay
                 -> invocation-local snapshot -> existing fallback -> per-attempt prompt -> runner
                 -> process outcome + unchanged worker prose -> parent / TUI / delegation log
                 -> finally release admission and dispose listeners/deadline

session_shutdown -> close admission -> cancel queued + active calls -> await settlement -> reset
```

Proposed small modules: `src/shared/agent-home.ts`, `src/sub-agents/invocation-context.ts`,
`src/sub-agents/writer-admission.ts`, and `src/sub-agents/instruction-context.ts`. Integrate through
existing registration/session handlers, not another runner or orchestration framework. Module names
are implementation seams, not separately mandated task/bead boundaries.

### 14.3 D-01 — Model Intent and Reasoning (REQ-007, P3-Q-002)

Capture `ctx.model.provider` and `.id` synchronously at execute entry, before queueing or awaits.
Use typed `ExtensionContext`-compatible input rather than a raw family cache or shell PI_MODEL.
Queued invocations retain that captured identity; the next invocation sees a model switch.
Config snapshot stays immutable: JSON override > YAML/declaration default > captured parent model.
For primary model and reasoning fields, empty/whitespace-only values mean absent at every source
(JSON, YAML, declaration); normalize before precedence so absence can reveal the lower-priority
value. Normalize leading/trailing whitespace on non-empty selectors/levels. A blank fallback entry
is invalid, never an inheritance request: reject it through existing config/YAML diagnostics (and
reject direct internal bypasses before execution). Include parity fixtures for each source.
Missing parent identity with no explicit model is a controlled `provider_or_model_unavailable`
outcome before spawn, never omission of --model or fallback to the child's saved/default model.

Resolve configured references from the current registry catalogue (`getAll()`, no credential lookup
or network refresh). Compare full provider/id first, then an exact bare id only if unique across
providers. Preserve IDs containing slash/colon: match the entire reference before interpreting an
optional recognized thinking suffix. Reject ambiguous, fuzzy, wildcard, or unknown references with
an actionable request for an exact provider/id; do not guess a latest model. This is an intentional
compatibility tightening: schema remains string, but legacy patterns need manual replacement using
`/setup-models` or an exact catalogue ID. No automatic settings rewrite or new resolver dependency.

Reasoning priority: explicit agent reasoningEffort > recognized :thinking suffix on that attempt's
configured model reference > current child/Pi default (omit --thinking). Parent thinking is NOT
automatically inherited in this phase. Preserve current schema-supported levels and reserved
temperature/promptMode behavior; report requested reasoning, not a claim Pi honored an unsupported
level. Pi remains responsible for capability clamping. Exact matching precedes suffix removal so a
literal model ID ending in a colon segment is not corrupted.

Build a local snapshot copy with the resolved primary model, never mutate the session snapshot.
Each fallback reference is resolved immediately before its attempt with the same rules; the existing
eligible read-only chain and total run budget remain the retry authority. A resolution failure is a
synthetic unavailable attempt (no spawn) and may advance only an already-configured eligible
read-only fallback. Missing parent identity is treated the same way. Writers always return the first
failure. Rebuild the prompt family from each resolved model ID, not the unresolved config pattern.

Runner receives canonical provider/id via --model and, when selected, --thinking; never place
credentials on argv or copy registry authentication into the child. A parent-only dynamically
registered provider may be absent in nested Pi: return unavailable with guidance to configure the
provider in the selected child home. Do not auto-load code or grant project trust to make it work.

Observability uses distinct labels: `requested model` (resolved intended provider/id) versus
`reported model` (provider/id from typed assistant message_end/agent_end metadata when available).
Missing observation stays unknown; a mismatch is shown as a warning, never relabeled as intended
model success. Do not infer the upstream model behind a proxy. Retain only bounded redacted model
identifiers in progress/log metadata; no raw provider registry, auth, headers, or full events.

This explicitly supersedes the historical no-explicit-model/default-prompt-family behavior documented
in the prompt-system spec for registered delegates only. It does not enable promptMode append.

### 14.4 D-02 — Agent Home (REQ-008, P3-Q-002)

One pure resolver chooses non-empty `PI_CODING_AGENT_DIR` > non-empty legacy `PI_AGENT_DIR` >
`~/.pi/agent`. Expand a leading ~/ (or platform equivalent), resolve relative paths against the
parent process startup cwd, and normalize once to an absolute path. Empty string means unset;
do not trim valid whitespace from path names. Reject invalid values without reading another home.
If both variables disagree after normalization, official wins with one redacted diagnostic; no
merging, symlink-based credential search, or file migration. Do not require realpath for a new home.

Use the same selected home for Blackbytes settings read/cache keys, `/setup-models` writes, YAML
loading, artifacts/stats/cleanup, and `SettingsManager.create()` in the read renderer. Existing
explicit path overrides (e.g. configured log paths) continue to win; do not relocate unrelated logs.
Audit remaining PI_AGENT_DIR consumers/comments rather than assuming only the config loader uses it.
Snapshot the selected home/source at session start; reload is the boundary for environment changes.
Pre-session consumers use the same resolver and startup cwd, not whichever child cwd happens to run.

Pass both home variables set to this normalized path in the otherwise-restricted child env.
Do not mutate the parent's process.env. Show source (`official`, `legacy`, `default`) and conflict
warning in existing diagnostics, not credential content. Missing settings/YAML retains existing
empty-config behavior at the selected home; unreadable/malformed files retain existing diagnostics
and never trigger a search of the default home. Artifact failure stays best-effort, not run failure.

Legacy-only launch cannot retroactively change the parent Pi's already-loaded auth/model registry.
Blackbytes and the child select the legacy home, but diagnose the possible parent/child divergence.
Document the compatibility path: restart Pi with PI_CODING_AGENT_DIR set to the same directory
(optionally retain the legacy alias). No credential copy or implicit second parent runtime.

### 14.5 D-03 — Instructions and Escalation (REQ-009/011, P3-Q-003)

Inject a mandatory host-owned instruction-discovery block for EVERY registered full-access agent,
including YAML, independently of optional declaration.prependSystemPrompt. Final tool policy remains
unchanged. The existing catch-and-continue for an optional overlay must not silently remove this
mandatory block: on builder failure inject a fixed recovery block; if that also cannot be constructed,
return a controlled setup failure without spawn. Read-only runtime overlays stay as they are.

Use a manifest, not a supposedly complete excerpt: discover selected-home global instructions and
the absolute cwd ancestor chain. Global candidates are exactly `<selectedHome>/AGENTS.override.md`,
then `<selectedHome>/AGENTS.md`, then `<selectedHome>/CLAUDE.md`; select the first existing candidate.
Use that same filename precedence within every project ancestor directory. An unreadable higher-precedence candidate is
recorded as unreadable, not replaced by a lower-priority file. Global comes first, then ancestor
to descendant; more-specific project constraints apply within scope, below host/user authority.
This is Blackbytes' explicit discovery policy, not a claim to reproduce every Pi resource-loader version.

Manifest entries contain exact source path plus `available`, `unreadable`, `symlink`, or `omitted`
state. Do not read/inject full file contents at parent startup or recursively enumerate a repository.
Resolve cwd physically for ancestor discovery and disclose lexical/physical differences. Do not
follow symlinked instruction files automatically: report the link for worker inspection and recovery.
For a target reached through a symlink, the worker checks both lexical and physical instruction
ancestries; out-of-assignment physical targets or conflicting scope require escalation before edits.
New files use the nearest existing physical parent; no OS authorization is implied.

Fixed discovery limits: inspect cwd and up to 63 immediate parents, plus the global directory.
Collect nearest-to-farthest; if the filesystem root is not reached, record the first unvisited parent
and say ancestor coverage is incomplete (do not invent a count of files never inspected).
The complete instruction block is capped at 8192 characters. Reserve fixed recovery text and omission
metadata first, then retain whole project entries nearest-first, followed by the global entry if it
fits. Render retained entries global-first, then ancestor-to-descendant; deduplicate identical paths.
Report the number of discovered-but-unrendered entries and the covered depth interval; workers must
re-enumerate any omitted interval and the global source. If exact boundary/path text itself cannot fit,
use an explicit full-rediscovery notice with depth indexes, never a truncated usable-looking path.
No persistent cache: build after admission so an earlier writer's instruction changes are visible.

Worker preflight: inspect dirty/untracked work; fully read applicable manifest sources with paginated
read; before each target mutation discover instructions below cwd through that target's directory.
Repeat when scope expands. A prefix or read truncation is not a completed read. Missing files are
not a blocker by themselves; unreadable/omitted/symlink sources require recovery, and an unresolved
safety-relevant source blocks affected work. Use only the finalized allowed tools. An agent unable
to inspect the required sources must report the limitation, not assume instructions are absent.
Paths changed by redaction are disclosed as redacted; recover through allowed filesystem discovery.

Keep General's existing 8192-character safety block bounded; factor shared instruction text out
rather than concatenate duplicate excerpts. Cap the shared mandatory instruction block separately
at 8192 characters; neither truncation may remove host hard rules or its own omission notice.
No worker-facing token/context-budget warnings. Provenance means discovered sources, not proof of
reads or obedience, and is never summarized as `all instructions followed`.

Both General prompt families replace unconditional task-complete language with the same semantic
contract. Critical contradiction, missing required dependency, destructive action without authority,
or unresolved instruction conflict stops affected work. Return source evidence, impact, smallest
decision, and partial edits/check limits. Labels: `needs-decision` for premise/dependency/scope;
`blocked` for an external obstacle; `partial` for unfinished work not awaiting a decision;
`completed` only as the worker's own claim. Harmless choices still use in-scope defaults.
No persistent wait, automatic resume, recursive delegation, unrelated cleanup, or reset of dirty work.

### 14.6 D-04 — Writer Admission and Lifecycle (REQ-010, P3-Q-004)

One in-memory FIFO capacity-one controller per parent extension runtime protects all registered
full-access delegates regardless of cwd or agent name. Conservative classification uses declaration
mutability plus any finalized mutating tool; reuse existing mutating-tool metadata, not a new list.
Read-only delegates bypass admission and remain eligible for host parallel execution.

Keep `executionMode` as the Pi host scheduling hint. Existing explicit parallel settings remain
parseable and are shown as such, but NEVER bypass writer admission. There is no parallel-writer
escape hatch in this phase. Status/docs distinguish `host scheduling: parallel` from
`writer admission: serialized`. This trades writer throughput for a real registered-delegate guarantee.

Acquire after capturing invocation context/finalizing tools and before filesystem-dependent overlay
preparation or spawn. FIFO order is admission-request order, not tool-call source order. Queue entries
hold invocation-local context and a cancellation/deadline handle; cap waiting writers at 100.
Overflow returns existing `failed` with an actionable busy diagnostic, no launch and no auto-retry.

Set `effectiveTimeoutMs = resolved timeoutMs ?? 300000` (existing runner default) from the execute-entry
timestamp, including YAML with no timeout. This invocation deadline covers setup, queueing, and nested
execution. Abort-aware setup awaits must stop waiting at that deadline and prevent late continuations
from spawning; optional hooks that ignore cancellation do not gain launch authority. Pass only
remaining time into existing runner/fallback; their timeout cleanup/grace can
extend settlement beyond that deadline. Add `queued` progress state and queueWaitMs; elapsed duration
includes waiting and diagnostics must distinguish queue timeout from child timeout. No default polling
process or queue persistence. Remove timers/listeners on EVERY terminal path.

Abort/deadline while waiting removes the entry and returns cancelled/timed_out with zero child tool
calls. Recheck after granting admission and immediately before spawn: aborted waiters never launch.
Active cancellation reaches the existing runner; release in finally only after its promise settles
(including termination handling), not on first abort notification or agent_end. Prompt/setup throws
also release the lease. A worker may leave safe partial edits even when the runtime fails.

Shutdown closes admission synchronously, rejects queued calls, aborts active calls via a controller
linked to their tool signal, and awaits active settlement for at most 5000ms. At that cap, emit a
redacted drain-incomplete diagnostic and retain the retired closed controller until settlement;
never reset its active lease. New writer admission remains closed while any retired writer is active.
The retired-controller barrier must survive same-process reset/reload (process-local state retained
across extension generations, not disk storage); a new registration generation consults it before
admission. Keep only lease/settlement state, not prompts or credentials. Stale callbacks release
only their own lease. Test delayed settlement beyond 5000ms across controller replacement explicitly.
No recovery promise after hard host death; existing platform-specific cleanup limits remain explicit.

Protection covers managed invocation lifetimes, not all OS writes: parent/editor changes, internal
chains/direct runner callers, extensions with ambient execution, and escaped descendants can still
conflict. Prompt the parent not to edit the worker's scope while delegating; that is cooperation, not
a runtime lock over the repository.

### 14.7 D-05 — Process Outcome Is Not Acceptance (REQ-011/012, P3-Q-005)

Choose NO semantic success parser in this phase. Arbitrary prose cannot be robustly turned into
verified completion by scanning headings, exit status, or a worker-supplied marker. Keep
`DelegateResult.success`, failureKind, and fallback decisions as process-level contracts. Add no
`verified: true`, acceptance registry, JSON-only handoff, or hidden model call.

General ends with a compact natural-language handoff: `Outcome` (one of the labels in D-03),
`Summary`, `Files changed`, `Verification` (commands, observed results, unrun checks with reasons),
`Risks`, and `Follow-up` (remaining work/decision, or none). Status is explicitly worker-reported.
Other roles and legacy YAML may return their existing formats; no parser rejects them. Both default
and GPT prompts share the same escalation/handoff obligations. Do not emit TASK COMPLETE on every
path. Partial edits and failed/unrun checks stay visible even under a completed worker claim.

Registered final text receives a short host-owned prefix, e.g. `Process: succeeded. Task outcome:
not host-verified; assess the worker report below.` Failures use the existing classified formatter
with the same distinction. Preserve successful worker content byte-for-byte within the existing
return cap; the small prefix is outside it, not a reason to re-redact or rewrite snippets. Missing,
malformed, contradictory, truncated, or legacy task evidence is always unknown to the host.

TUI completed status/checkmark means `process completed`, made explicit in the collapsed result
line; General's result also says `task unverified`. Expanded view separates reported text from
process metadata. ROI and diagnostics label success rate as process success rate, never acceptance
rate; no automated completed-task counter. Stored older details lacking new queue/model fields
render conservatively. No full worker report is copied into new diagnostic fields.

Parent Bytes instructions consume the report: reconcile Outcome against failed/unrun checks and
remaining work; run proportionate verification before claiming completion. A claimed completed
outcome with a failing required check is not acceptance. Difficult/high-risk independent review uses
read-only Oracle supplied with bounded candidate diff, requirements, and actual verification evidence;
the General summary alone is insufficient. This is a prompt-level contract and needs behavioral
evidence, not merely a string test.

### 14.8 Compatibility, Data, and Rollback

| Consumed contract | Delta and compatibility proof |
|---|---|
| Public delegate names/arguments | Unchanged natural-language schemas; test builtin and YAML invocations. No new commands/tools. |
| Model config / setup wizard | Unset now inherits active model, no parent identity refuses; exact-only selectors have actionable migration. Test provider/id, unique bare ID, slash/colon IDs, suffix reasoning and ambiguous/pattern rejection. Wizard writes existing exact IDs. |
| Home paths | Official precedence replaces split resolution; legacy alias supported with parent-restart warning. Test settings read/write, YAML and artifact paths with differing child cwd and both vars. |
| executionMode | Parse unchanged, explicit parallel no longer permits writer overlap. Test concurrent registered callbacks directly, without relying on host scheduling. |
| Result/progress/log | success remains process-only; queued and optional queue/model metadata are additive. Update renderer/diagnostics consumers together; old free-form content remains callable and unknown, old details must render. |
| Prompt family / instructions | Invocation intent controls family, replaces cwd prefix with recoverable sources; both General families plus YAML full-access coverage tested. |

No persistence schema, database migration, backfill, auth flow, credential relocation, or config-format
migration. Legacy fuzzy model selectors do require the manual value update documented in D-01. Existing artifact retention/redaction stays intact. Paths/model IDs in
new metadata pass existing redaction and display bounds; successful output remains potentially
sensitive in parent history by the approved policy. Do not log manifests' file contents or registry
objects. Project instructions never widen tools or trust. Security review must check negative
fixtures for path leakage, symlink scope, canceled-launch races, and false verified labels.

Rollout is a versioned extension release after all delivery gates, with release notes for changed
defaults/selector migration/legacy-home restart. Before rollback, drain or cancel registered delegates,
restore the prior package version, then restart Pi; no worktree reset or credential movement.
Existing explicit model and official-home settings can stay. Prior versions lose writer admission
and honest handoff labeling; disabling affected delegates is the containment option until fixed.
R3 destructive/coordinated rollout: N/A — no shared data cutover or irreversible action; owner invoker.
Rollback does not undo a worker's edits. No automatic rollback command is executed by this design.

### 14.9 Evidence Strategy and Phase Scope

Use existing node:test/assert helpers and mocked spawn/JSONL streams; filesystem fixtures live in
temporary directories and never mutate real user homes. Add fake-clock/deferred-promise admission
tests so overlap/cancel assertions do not depend on timing sleeps. No new dependency required.

| Requirement | Deterministic delivery evidence | Additional behavioral evidence |
|---|---|---|
| REQ-007 | Registry fixtures + argv captures for override/inheritance/switch while queued; missing parent; primary snapshot overwrite regression; fallback family/suffix changes; ambiguity and unknown selectors; requested vs reported model absent/mismatch. | Pilot records actual intended/reported models; unavailable parent-only provider remains an honest failure. |
| REQ-008 | Env matrix (default, official, legacy, equal/conflicting, empty, relative, tilde, unreadable); shared settings/wizard/YAML/artifact/read-renderer consumers and child env allowlist; no writes/copies to fallback home. | No credential-bearing live migration test. |
| REQ-009 | Ancestor/subdirectory/nested target fixtures; missing/unreadable/higher-priority file, symlink cwd/source/target, new target, cap exhaustion and critical rule beyond old prefix; mandatory block survives optional hook failure; YAML writer coverage. | Worker actually reads nested/long instructions, or blocks safely; manifest alone is not obedience evidence. |
| REQ-010 | Builtin+YAML writers never overlap, even explicit parallel/different cwd; readers bypass; FIFO; deadline while queued; abort-grant race; throw/timeout/spawn failure releases; overflow; shutdown/reload cannot start stale waiters or reset an active lease. | Disclose external-writer/descendant exclusions, no OS isolation test claim. |
| REQ-011 | Both prompt families require evidence and smallest decision; dirty/untracked preservation and harmless-default language. | Paired clear-task vs false-premise/missing-dependency/instruction-conflict cases, including partial edits. |
| REQ-012 | Exit-0 fixtures with blocker/failing check/unrun check/contradictory completion/free-form/no output remain host-unverified; bounded output preserves report tail; process labels in TUI/log/status and legacy details. | Parent does not accept failed required checks; review uses candidate evidence rather than author summary alone. |

Compatibility proof at delivery: typecheck and controlled no-provider-call host/CLI contract fixtures
against Pi 0.83.0 and installed 0.85.1, on Node's declared floor and current development runtime.
Use isolated dependencies/homes for the matrix, not replacement of a user's global installation.
Linux process-group tests plus Windows-compatible mock paths/termination branches preserve existing
platform boundaries; a real Windows run, if unavailable, must be explicitly reported as not run.
Do not describe source/type inspection in §14.1 as the matrix passing.

Full delivery verification remains `bun run check` (lint -> typecheck -> build -> test -> size <500 KB
gzip). Package/version prose inconsistencies in AGENTS/README belong in the delivery documentation
update, not an unrelated source edit now. Plan must map the above evidence, not replace it with generic
`tests pass`. Any supported-contract mismatch discovered during implementation blocks the affected
work and requires a design delta, not a silent peer-version increase.

Phase scope is REQ-007–REQ-012 plus existing REQ-006 compatibility/docs. Pilot approval P3-Q-006
remains required before live behavioral evaluation: representative paired cases, isolated checkouts,
run count/models, spend/time ceiling, and intervention/rework measures. No pilot or ROI proof is
claimed by design review; absence needs an invoker-owned delivery exception, not an unqualified PASS.

### 14.10 Decisions, Gate, and Revision Record

| Decision | Accepted resolution | Owner / disposition |
|---|---|---|
| P3-Q-002 | D-01/D-02: invocation ctx, exact model identity, no parent-thinking inheritance, official-home precedence, legacy restart path; compatibility matrix specified. | Invoker approved 2026-09-08. |
| P3-Q-003 | D-03: mandatory recoverable manifest for all writers, explicit precedence/path/cap behavior, worker per-target reads. | Invoker approved 2026-09-08. |
| P3-Q-004 | D-04: FIFO registered-writer gate, no parallel escape hatch, deadline includes waiting, drain before reset. | Invoker approved 2026-09-08. |
| P3-Q-005 | D-05: prose report, no semantic acceptance parser; host outcome always unverified, process-only success. | Invoker approved 2026-09-08. |
| P3-Q-006 | No live pilot authorized by this design task. | Invoker owns later pilot budget/protocol approval. |

`design-ready` self-assessment (2026-09-08): Active status, owner, routing/requirements/convention links,
boundaries, interaction/error flows, consumed contracts, security/reliability, compatibility/rollback,
and requirement-specific evidence are specified. Persistence migration/auth integration/R3 modules
are N/A for the reasons in §14.8. Deterministic delivery tests remain future obligations, not tests
already run. **Gate disposition: `design-ready: PASS` (2026-09-08).** No exception.

Approval provenance: after receiving the five-decision summary and its explicit planning-only boundary,
the invoker replied “Duyệt tất”, approving D-01–D-05. This activates the design and permits preparation
of the Phase 3 Implementation Plan. `plan-ready-for-beads` remains required before conversion;
implementation, live pilots (P3-Q-006), and release are not authorized by this approval.

One read-only Oracle design/reader review found three medium gaps: timeout default/bounded drain,
blank selector normalization, and deterministic global/ancestor retention. These were addressed in
D-01/D-03/D-04 with explicit rules. Delivery fixtures must include blank JSON/YAML/declaration fields
and invalid blank fallback entries, YAML's 300000ms default, delayed drain beyond 5000ms across reload,
and global/ancestor retention at both caps. This records author remediation, not a second reviewer PASS.
Reader review correctly recovered writer parallel semantics, process-versus-task meaning, and official
home conflict policy. Final document integrity checks cover links, tables, scope, and retained baseline.

Revision: 2026-09-08 — Bytes drafted §14 from the accepted amendment and local runtime/Pi source
inspection. Product acceptance in §13 stays intact; historical plans and Beads are untouched.

Revision: 2026-09-08 — invoker approved all five technical decisions (“Duyệt tất”); Bytes recorded
Active design, resolved P3-Q-002–P3-Q-005, and `design-ready: PASS`. Next: Phase 3 Implementation Plan.
