# Sub-Agent Mechanism Hardening — Phase 3a Deterministic Delivery Plan

| Field | Value |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-09-08 — Bytes; scoped WP-001–006 only |
| Owner | invoker; drafting: Bytes |
| Date | 2026-09-08 |
| Phase | Phase 3a — Reliable Delegation deterministic delivery; overall Phase 3 remains incomplete |
| Split provenance | 2026-09-08 — invoker explicitly chose “Tách phần kỹ thuật (Recommended)” after the whole-plan gate review |
| Routing decision | [Canonical §13.1](../specs/subagent-mechanism-hardening.md#131-routing-decision): brownfield, consumed contracts and writer boundaries; plan → converter → standard feature-done |
| Requirements source | [Accepted §13](../specs/subagent-mechanism-hardening.md#13-phase-3-mvp--reliable-delegation-product-amendment), plus existing REQ-006 |
| Technical Design source | [Active §14](../specs/subagent-mechanism-hardening.md#14-phase-3-technical-design--reliable-delegation); D-01–D-05 approved, design-ready PASS 2026-09-08 |
| Related ADRs | N/A — §14 identifies no governing/new ADR; approved decisions stay in the design |
| Authority | Planning / partial delivery map only; accepted §13 requirements and Active §14 design remain authoritative and unchanged. No implementation, tracker mutation, pilot, installation, or release authorization |

## 1. MVP-Lock and Delivery Gates

**Conversion scope: WP-001–WP-006 only.** This Phase 3a plan delivers deterministic implementation,
not overall Phase 3 acceptance. Deferred Phase 3b (§5) is not executable or conversion scope.

**Locked requirements mapping:** REQ-007 predictable model; REQ-008 consistent agent home; REQ-009 relevant
instructions/provenance; REQ-010 conservative writer admission; REQ-011 critical escalation;
REQ-012 truthful handoff; applicable REQ-006 documentation, tests, and compatibility. All acceptance
criteria in §13.4 and evidence obligations in §14.9–14.10 remain required, not just the summaries below;
deterministic evidence is delivered here and required behavioral evidence is deferred, not waived.
D-01–D-05 are authority: this plan sequences their delivery without reopening their design.

**Out of phase:** shipped Phase 1/2 work; public chains; background/persistent workers; Supervisor or
restored Reviewer; steering/scheduling/fanout; recursive delegation; worktree lifecycle; cross-session
locks; semantic completion parser; acceptance registry; OS isolation; blanket successful-output
redaction; automatic writer retries; mandatory YAML fields, JSON handoffs, or workspace protocol files.
Internal chain/direct runner callers remain outside registered admission/model/instruction policy;
runner-wide home/environment changes still reach them. No additional model calls by default.

**Deterministic delivery exit (WP-001–WP-006):** all mapped fixtures, consumer compatibility, security
negative checks, documentation, and the version matrix have recorded outcomes; `bun run check` passes
including gzip <500 KB. This is code/contract evidence, not proof of worker obedience or phase acceptance.

**Overall Phase 3 acceptance exit (deferred Phase 3b gate):** deterministic delivery plus invoker-approved behavioral pilot
results satisfying §13.6, OR a dated invoker-owned explicit exception naming missing evidence and
accepted limits. An exception is not an unqualified PASS. Neither exit grants release/deploy authority.

**Default checkpoint posture:** follow [§14.8](../specs/subagent-mechanism-hardening.md#148-compatibility-data-and-rollback).
Contain by disabling affected delegates. Before package rollback, drain/cancel delegates, restore the
prior version, then restart Pi; never reset a worktree or move credentials. Rollback does not undo
worker edits and loses new admission/handoff protection. No data migration/backfill or irreversible
cutover; R3 coordinated/destructive rollout is N/A. Execution of rollback is separately authorized.

Historical [Phase 1](subagent-mechanism-hardening-implementation-plan.md) and
[Phase 2](subagent-mechanism-hardening-phase2-plan.md) plans remain unchanged. The supplied read-only
`.beads/issues.jsonl` snapshot has 189 closed entries and 23 tombstones, no Phase 3 graph; this is not
live tracker proof. Do not import or create a graph in this drafting unit. Conversion requires a dated
Plan-ready PASS and Active transition by the owning workflow; exact leaves remain converter-owned.

## 2. Work Packages

Each stable WP maps 1:N execution atoms. Paths are integration seams, not mandatory bead boundaries.
Every WP owns focused regression evidence alongside its outcome; WP-006 joins rather than defers tests.
All work is in this repository's TypeScript/Pi extension stack. Independent DAG branches are not
permission for concurrent edits to shared registration, types, or handler files.

### WP-001 — One selected agent home across consumers

- **Outcome / coverage:** deterministic parent/child home selection and compatibility diagnostics;
  REQ-008, REQ-006. **Design refs:** §14.4 D-02, §14.8–14.10.
- **Prerequisites:** none.
- **Seams:** proposed `src/shared/agent-home.ts`; `src/config/loader.ts`,
  `src/commands/setup-models.ts`, `src/sub-agents/loader.ts`, `artifacts.ts`, `runner.ts`,
  `src/tools/hashline-edit/read-renderer.ts`, and session state/handlers.
- **Boundary:** shared resolver before its settings/cache, wizard-write, YAML, artifact/stats/cleanup,
  and SettingsManager consumers; selected session snapshot before nested env integration. Audit all
  remaining legacy-home uses. Preserve explicit unrelated log paths and restricted env forwarding.
- **Exit evidence:** default/official/legacy/equal/conflicting/empty/relative/tilde/invalid/unreadable
  fixtures use startup cwd and reload boundaries, preserve valid path whitespace, and never search or
  write a fallback home. Child cwd differs; both child aliases agree without parent env mutation.
  Missing/malformed settings/YAML keep existing diagnostics; artifact failures remain best-effort.
  Conflict/source and legacy parent-registry divergence are bounded/redacted; restart guidance exists.

### WP-002 — Invocation-local exact model intent and attempt evidence

- **Outcome / coverage:** correct primary/fallback identity and prompt family without saved-child
  default drift; REQ-007, REQ-006. **Design refs:** §14.3 D-01, §14.8–14.10.
- **Prerequisites:** none; home/provider-divergence integration joins in WP-006.
- **Seams:** proposed `src/sub-agents/invocation-context.ts`; `snapshot.ts`, `register.ts`,
  `fallback.ts`, `prompt-builder.ts`, `runner.ts`, `types.ts`, config schema and YAML loader.
- **Boundary:** normalization/resolution contract before per-attempt integration and metadata producer;
  use typed invocation context and an immutable local snapshot, including fallback's overwrite path.
  No registry credential lookup/refresh, new dependency, parent-thinking inheritance, or provider loading.
- **Exit evidence:** JSON/YAML/declaration blank and trimmed model/reasoning parity; invalid blank
  fallback entries including direct bypass; exact provider/id, unique bare ID, slash/colon literal IDs,
  suffix precedence, ambiguous/fuzzy/wildcard/unknown rejection. Capture invocation model before awaits;
  snapshot immutability, switch/queued capture, explicit override, and missing-parent synthetic failure.
  Assert canonical argv, reasoning omission/default and explicit precedence, reserved settings intact,
  read-only fallback family/suffix changes within total budget, and zero writer retry.
  Typed reported-model missing/mismatch stays distinct from requested identity; redact/bound metadata.

### WP-003 — Deadline-bound writer admission through shutdown/reload

- **Outcome / coverage:** no overlapping registered managed writers; REQ-010, REQ-006.
  **Design refs:** §14.2, §14.6 D-04, §14.8–14.10.
- **Prerequisites:** none; entry capture contract follows D-01 and is cross-tested with WP-002 later.
- **Seams:** proposed `src/sub-agents/writer-admission.ts`; `register.ts`, `progress-reporter.ts`,
  `types.ts`, `src/shared/session-state.ts`, `src/handlers/index.ts`, existing runner/fallback cleanup.
- **Boundary:** controller contract → registered lifecycle integration → shutdown/reload settlement
  barrier are distinct evidence seams. A lease is not released on abort notification or agent_end.
  Mutation classification reuses declaration plus finalized mutating-tool metadata, not agent names.
- **Exit evidence:** FIFO capacity one, waiting cap 100/overflow, builtin/YAML/different-cwd writers,
  explicit parallel still serialized, readers bypass. Deadline begins at execute entry, includes setup
  and queueing, uses YAML unset default 300000ms, and passes only remaining budget to runner/fallback.
  Deferred hooks cannot spawn after timeout; queued abort/deadline and abort-grant/pre-spawn races
  produce zero calls. Throw/spawn failure/timeout/cancel settle and release; all timers/listeners dispose.
  Queue progress/wait duration distinguish queue from child timeout; termination grace may outlast deadline.
  Shutdown closes synchronously, cancels queued/active calls, drains at most 5000ms, diagnoses incomplete
  drain, and retains the retired lease barrier across same-process reset/reload/controller generations.
  Delayed settlement beyond the cap blocks new writers; stale callbacks release only their own lease.

### WP-004 — Recoverable writer instructions and evidence-backed escalation

- **Outcome / coverage:** all registered full-access agents receive mandatory discovery/recovery policy;
  both General families stop only affected critical work; REQ-009/011, REQ-006.
  **Design refs:** §14.5 D-03, §14.6 preparation ordering, §14.9–14.10.
- **Prerequisites:** WP-001 selected home; WP-003 admission-before-filesystem-preparation lifecycle.
- **Seams:** proposed `src/sub-agents/instruction-context.ts`; `register.ts`,
  `general-safety-overlay.ts`, `general.ts`, prompt regression and temporary filesystem fixtures.
- **Boundary:** manifest discovery is host evidence, not file-read/obedience evidence. Worker paginated
  reads and per-target rediscovery are prompt obligations, requiring behavioral evidence at the deferred Phase 3b gate.
  Mandatory block is independent of optional persona hooks and applies to YAML writers too.
- **Exit evidence:** global and each ancestor's override/AGENTS/CLAUDE precedence; unreadable higher
  candidate is not replaced; physical/lexical cwd, symlink source/target, new target parent, missing,
  nested and beyond-old-prefix rules. Test 64-directory depth and separate 8192-character block caps,
  nearest-first retention/global ordering/deduplication, omitted counts/intervals, root-not-reached,
  redacted paths and full-rediscovery fallback when exact boundaries cannot fit. No full-file injection,
  recursive enumeration, persistent manifest cache, or usable-looking truncated paths.
  Optional hook failure leaves mandatory recovery; builder recovery failure refuses spawn. General's
  own safety cap retains hard rules without duplicate excerpts or worker resource-scarcity warnings.
  Both families require dirty/untracked preservation, full reads and new-scope rechecks, evidence/impact/
  smallest decision/partial edits for critical blockers, and harmless in-scope defaults. Tools never widen.

### WP-005 — Process-unverified handoff and all consumers

- **Outcome / coverage:** worker claims, process outcome, verification, and acceptance remain distinct;
  REQ-012/011, REQ-006. **Design refs:** §14.7 D-05, §14.5 labels, §14.8–14.10.
- **Prerequisites:** WP-002 requested/reported metadata; WP-004 writer prompt/escalation integration
  (and its WP-003 lifecycle metadata prerequisite).
- **Seams:** `register.ts`, `general.ts`, `render.ts`, `delegation-log.ts`, `diagnostics-summary.ts`,
  `src/commands/blackbytes-status.ts`, `src/system-prompt/bytes/overlay.ts`, associated tests.
- **Boundary:** producer additive details/prefix → TUI/log/status consumers → parent instructions.
  Preserve `DelegateResult.success`, taxonomy, fallback decisions, public inputs and legacy YAML prose.
  No semantic parser, verified flag, completed-task counter, or mandatory output schema.
- **Exit evidence:** exit-0 blocker, failed/unrun checks, partial edits, contradictory completion,
  malformed/free-form/missing task evidence all remain host-unverified. Both General families expose
  Outcome/Summary/Files changed/Verification/Risks/Follow-up without unconditional TASK COMPLETE;
  other roles retain their contracts. Prefix sits outside the existing return cap; successful worker
  content remains byte-preserved within that cap and report tail stays understandable without artifacts.
  Failures retain classification plus unverified distinction; TUI says process completed and General
  task unverified; expanded text/metadata separate; ROI/status say process success rate. Old details
  lacking queue/model fields render conservatively. No raw worker reports enter new diagnostic fields.
  Parent guidance reconciles claims with checks and uses candidate diff/requirements/actual checks for
  difficult Oracle review, never author summary alone; General self-review is not independent review.

### WP-006 — Deterministic integration, compatibility, and operational documentation

- **Outcome / coverage:** independently auditable code/contract delivery evidence and usable migration/
  containment guidance; REQ-006 and cross-cutting REQ-007–012. **Design refs:** §14.8–14.10, §13.5–13.6.
- **Prerequisites:** WP-001–WP-005 completed producer/consumer behavior and focused fixtures.
- **Seams:** existing `src/**/__tests__`, `src/sub-agents/runner.test.ts`, `src/test-utils/`,
  repository verification scripts; `README.md`, `AGENTS.md`, release-note documentation in `CHANGELOG.md`.
- **Boundary:** integrated host/CLI matrix evidence is distinct from implementation unit tests and
  provider-backed behavior. Reconcile stale version prose with package.json, without changing floors.
- **Exit evidence:** §3 obligation rows and §4 matrix have recorded results; existing delegate, chain,
  artifact redaction/capping/retention, recursion/tool-policy and environment tests remain green.
  Security review explicitly covers path leakage, symlink scope, cancelled launches and false verified
  labels. `bun run check` passes; supported-contract mismatch blocks affected work for a design delta.
  Docs cover model selector manual migration, no parent-thinking inheritance, home restart/conflicts,
  serialized writers even with parallel hint, queue/deadline behavior, process-only metrics, provenance
  versus reads/obedience, successful-content sensitivity, and rollback/external-writer/platform limits.
  No publication/version bump or release action is included; behavioral claims remain pending the deferred Phase 3b gate.

## 3. Coarse DAG and Evidence Coverage

| Consumer depends on producer | Required producer outcome |
|---|---|
| WP-004 ← WP-001 | Selected session home for global instruction discovery |
| WP-004 ← WP-003 | Admission and abort-aware preparation lifetime before filesystem manifest work |
| WP-005 ← WP-002 | Requested/reported model metadata contract for result consumers |
| WP-005 ← WP-004 | Shared writer instruction/escalation contract and integrated lifecycle metadata |
| WP-006 ← WP-001, WP-002, WP-003, WP-004, WP-005 | Complete behavior to verify together and document |

A valid topological order is WP-001, WP-002, WP-003, WP-004, WP-005, WP-006.
There is no pilot prerequisite for these packages. Transitive edges are intentionally redundant only
at the delivery evidence join;
converter owns precise atom/root/terminal lifting and shared-file sequencing, not product decisions.

| Design test obligation | Deterministic owner | Deferred behavioral evidence / residual gate (not conversion scope) |
|---|---|---|
| D-01 / §14.9 REQ-007, §14.10 blank-source remediation | WP-002; queued switch joins WP-003 in WP-006 | Deferred Phase 3b gate: intended/reported models, honest unavailable parent-only provider |
| D-02 / §14.9 REQ-008 complete env/consumer matrix | WP-001, WP-006 | No credential-bearing live migration needed or authorized |
| D-03 / §14.9 REQ-009, §14.10 depth/global retention remediation | WP-004 | Deferred Phase 3b gate: actual paginated/nested/long reads or safe blocking; provenance alone insufficient |
| D-04 / §14.9 REQ-010, §14.10 YAML deadline/delayed reload remediation | WP-003, WP-006 | Document external writers/descendants; no OS isolation claim |
| D-03 / §14.9 REQ-011 both families and preservation language | WP-004, WP-005 | Deferred Phase 3b gate: paired harmless/critical cases and partial-edit preservation |
| D-05 / §14.9 REQ-012 unknown outcomes, cap, all consumers/old details | WP-005 | Deferred Phase 3b gate: parent verification and independent-review evidence discipline |
| §14.8 security/compatibility and §14.9 full delivery checks | WP-006 with WP-001–005 regressions | Platform caveats and final owner disposition retained at the deferred Phase 3b gate |

## 4. Verification and Compatibility Matrix

Use `node:test`, `node:assert/strict`, existing Pi mocks and spawn/JSONL fixtures; temporary homes and
repositories only. Admission tests use fake clocks/deferred promises, not timing sleeps. No new test
or runtime dependencies. No percentage coverage target is invented: every mapped obligation is required.

| Pi host/CLI contract | Node declared floor | Current development Node | Method |
|---|---|---|---|
| 0.83.0 | 22.19.0 | 24.18.0 observed at drafting; record actual version at delivery | Typecheck and controlled no-provider host/CLI fixtures |
| 0.85.1 | 22.19.0 | Same recorded current runtime | Same fixtures, isolated dependencies/homes |

[`package.json`](../../package.json), not stale AGENTS prose, declares Node >=22.19.0 and Pi peers
>=0.83.0 <1. Exercise all four cells without replacing global installations or reaching providers.
Source/type inspection is not matrix execution; missing runtimes/cells stay explicitly not run and
block their compatibility proof. Do not silently raise peer/Node floors to make tests pass.
Linux process-group fixtures and Windows-compatible mock path/termination branches are required.
A real Windows run, if unavailable, must be recorded as **not run**; mocks are not real Windows proof.
Run focused checks during delivery, then `bun run check` (lint → typecheck → build → test → package size).

## 5. Deferred Phase 3b Follow-up, Risks, and Handoff

### Deferred Phase 3b — Protocol, behavioral evidence, and overall phase closure

**Not conversion scope:** this follow-up retains the former pilot checkpoint and closure obligations;
it is neither an executable WP nor part of the Phase 3a DAG. No new plan file is needed until the
protocol is drafted. **Coverage:** behavioral REQ-007/009/011/012 and §13.6 value measurement; final
REQ-007–012 and applicable REQ-006 closure. **Authority:** §13.6–13.7, §14.7–14.10.

- **Protocol / owner gate (P3-Q-006):** Bytes prepares the protocol; invoker alone approves spend and
  workspace authority or records an evidence exception. Preparation may proceed independently, but
  no protocol, models/settings, repetitions/run count, budget, or approval is invented here. Dated
  approval must identify paired baseline/candidate cases and revisions, disposable checkout boundaries,
  models/settings, repetitions/run count, spend/time ceilings, stop conditions, intervention/rework
  definitions, and evidence retention/redaction. Use equivalent inputs/settings and record intentional
  resolution differences. Cases cover clear tasks; false premise/missing dependency/conflicting
  instructions; dirty/untracked work and nested/long instructions; partial edits; failed/unrun
  verification; and evidence-based parent review. Record intended/reported models and raw interventions,
  rework, time-to-acceptable-result, and cost, not tool-call-count ROI proxies.
- **Execution / evidence gate:** requires Phase 3a deterministic evidence and a separately approved
  protocol. Model-backed runs use only approved disposable checkouts, never user homes or
  credential-bearing migration. Exact run leaves await approved parameters in later planning; the
  converter must not invent them or hide undefined pilot scope in code leaves. Compare approved
  baseline/candidate cases, report raw results, tradeoffs and failures, and check actual paginated/
  nested/long instruction reads or safe blocking, preservation, escalation, and parent refusal of
  failed required checks. Prompt/provenance fixtures alone do not prove obedience. Approval is not results.
- **Overall §13.6 acceptance / exception gate:** invoker evaluates results against accepted scenarios;
  failed pilots require remediation/retest or an explicit invoker-owned exception, not automatic
  closure. Alternatively, a dated invoker-owned explicit exception records missing/unmeasured evidence,
  scenarios, rationale and accepted behavioral/ROI limits; it authorizes no pilot and is recorded as
  **Exception**, never unqualified PASS. Without approved pilot evidence or that exception, overall
  Phase 3 remains incomplete. Standard feature-done joins deterministic results, docs and owner
  disposition; no measured ROI without comparative data, acceptance from old closed Beads, or release
  authority. Splitting delivery grants no evidence waiver or pilot approval.

### Risks and scoped handoff

| Item | Owner / mitigation | Status and affected gate |
|---|---|---|
| P3-Q-006 protocol and resources | invoker; deferred Phase 3b protocol approval or explicit exception | Open; blocks live execution/overall phase acceptance, not defined WP-001–006 scope |
| Cost/throughput and over-escalation | invoker / Bytes; document accepted tradeoff, pair clear and critical cases | Deferred behavioral evidence pending; no ROI/speedup claim |
| Provenance/checkmarks mistaken for safety | Bytes; negative consumer tests plus instruction/read/acceptance distinctions | WP-004–006 review and deferred Phase 3b behavioral evidence |
| API/platform incompatibility or drain races | Bytes; isolated matrix, deterministic late-settlement tests, retain limits | Any design mismatch blocks affected work; seek approved delta, not silent redesign |
| Phase 3a plan activation and conversion | Bytes; scoped checklist assessment following invoker-approved split | Plan-ready PASS; Active for WP-001–006 only. Conversion/implementation not performed in this planning task |

**Historical gate review (2026-09-08):** one read-only Oracle pass found the former WP-008 could not
be decomposed into implementation-ready run leaves without unapproved protocol parameters; its
WP-007 prerequisite did not cure that conversion-time gap. The whole-eight-WP Draft received
`plan-ready-for-beads: FAIL`; no other material coverage or DAG gap was reported. This remains a
historical verdict, not PASS or the verdict for the newly scoped plan.

**Split revision (2026-09-08):** invoker chose “Tách phần kỹ thuật (Recommended)”. This revision bounds
Phase 3a to WP-001–006 and defers the pilot/overall acceptance to Phase 3b without changing §13/§14.
**Scoped gate assessment: `plan-ready-for-beads: PASS` — 2026-09-08 — Bytes.** Metadata/sources,
locked deterministic scope, six outcome-based WPs, producer prerequisites, acyclic DAG, exits,
compatibility/security evidence, containment, and deferred acceptance boundary satisfy the checklist.
The reviewed blocker is excluded from conversion by the explicit invoker-approved split, not waived.
No scope/design decision remains for the converter to invent in WP-001–006. Plan is now Active;
this freezes Phase 3a scope, not overall Phase 3 acceptance. Scope/design drift
returns to its owning artifact; the converter chooses atomic boundaries and exact dependencies only.
No unresolved pilot parameters enter Phase 3a code slices; overall closure retains approved pilot
evidence or invoker-owned explicit exception provenance.

## 6. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-08 | Bytes | Created Draft/Pending Phase 3 delivery map from accepted §13 and Active §14; no implementation, graph, pilot, or release action |
| 2026-09-08 | Bytes | Recorded bounded Oracle review: whole-plan Plan-ready FAIL for unapproved WP-008 run parameters; kept Draft, awaiting invoker choice of protocol-first or separate deterministic conversion scope |
| 2026-09-08 | Bytes; invoker-directed split | Applied “Tách phần kỹ thuật (Recommended)”: Phase 3a deterministic WP-001–006 only; retained Phase 3b protocol/evidence/exception obligations outside conversion scope; fresh scoped gate Pending parent assessment, overall Phase 3 incomplete |
| 2026-09-08 | Bytes | Scoped checklist PASS after invoker-approved split; activated and froze WP-001–006 conversion scope. Pilot/overall acceptance remains separately gated; no Beads or implementation performed |
