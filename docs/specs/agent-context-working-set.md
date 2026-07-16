# Agent Context Working Set — Quality-First PRD

| Field | Value |
|---|---|
| Status | Accepted |
| Owner | invoker |
| Created | 2026-07-16 |
| Variant | Brownfield |
| Prior decision | [`context-pruning.md`](context-pruning.md) — cost-first proposal ended `NO-GO` |
| Decision state | PRD acceptance authorizes only a non-shipping Phase 1 Evaluation Design; runtime pilot design still requires an evidence `GO` |

## 1. Context

Pi users can spend many requests on investigation, implementation, verification, and follow-up within one
parent-agent session. As the session grows, completed phases remain in the model-facing context alongside
the current working state. This can consume context headroom, increase distraction from obsolete details,
and eventually trigger Pi native compaction.

The earlier Dynamic Context Pruning proposal treated provider-equivalent cost reduction as a mandatory
product-value gate. Its evidence run ended `NO-GO` because native-compaction and following-request usage
could not be attributed completely. That result remains valid for the old cost-saving claim, but it did not
measure whether selective context management improves task quality, continuity, or working-set stability.

This PRD starts a separate product lineage. Its purpose is not to prove that smaller context is cheaper. Its
purpose is to determine whether an agent can explicitly retire completed conversation ranges from its
model-facing working set, preserve the state still needed for future work, and perform long-running coding
tasks more reliably. Cost and token usage are secondary guardrails only.

Pi native compaction remains enabled and is the baseline. Existing persisted session history remains the
source of truth and must not be edited or deleted by this feature.

## 2. Product Hypothesis

For opt-in, long-running parent-agent sessions containing a demonstrably completed conversation range,
allowing the agent to explicitly retire that range from subsequent model-facing context—while preserving
the append-only transcript and a compact, non-authoritative continuity record—will:

1. maintain task completion and critical fact/constraint retention relative to native Pi;
2. reduce continuity failures caused by stale, obsolete, or distracting history; and
3. keep context utilization more stable over later requests.

### 2.1 Counter-hypothesis

The agent cannot reliably determine that a range is complete or preserve every implication still needed by
future work. Retirement would then cause forgotten constraints, repeated investigation, incorrect
completion claims, unsafe reuse of historical authorization, or more user intervention than native Pi.
If this counter-hypothesis is supported, native compaction alone is preferable.

### 2.2 Completed range

A range is eligible only when it:

- is one contiguous sequence of complete user/assistant/tool turns on the active branch;
- has no unmatched tool call, pending request, unresolved decision dependency, failed verification,
  uncompleted deliverable, or open authorization question;
- ends with evidence stronger than assistant self-assertion: user acceptance, objective verification, or a
  clear transition to a new goal;
- excludes the current goal, current user turn, and a protected recent-working-set buffer; and
- can be retired without making a historical permission, approval, or instruction appear current.

Ambiguity means refusal. The range remains model-visible.

## 3. Goals and Success Metrics

A narrow pilot design is authorized only when G-001 through G-005 pass and G-006 is `pass` or its cost
sub-status is `unknown`. Thresholds are frozen before evaluation outputs are reviewed. PRD acceptance
before that point authorizes only a separate non-shipping Evaluation Design and generated/copied-context
prototype needed to collect Phase 1 evidence.

### G-001 — Preserve safety and transcript integrity

- Zero treatment-only critical safety events.
- Zero false retirement of an incomplete, ambiguous, cross-branch, or structurally invalid range.
- Every pre-existing transcript entry remains byte-unchanged and retrievable.
- Restore-all succeeds in every required lifecycle scenario.
- Historical, revoked, or superseded authorization is never treated as current authorization.

Any failure is an automatic `NO-GO`.

### G-002 — Preserve task quality

Across at least 20 independent qualifying scenarios, including at least 10 newly authorized
real-session-derived scenarios:

- critical fact-and-constraint recall delta versus native Pi is at least `-0.02`;
- objective task-completion delta is at least `-0.05`; and
- no treatment-only run loses a current goal, hard constraint, unresolved obligation, repository-state
  fact required by the task, or verification status.

One scenario is the independent unit; real-session-derived evidence contributes at most one scenario per
session. Each arm runs exactly three replicates. Every scenario predeclares at least one diagnostic atomic
fact at both checkpoints; otherwise it is not G-002-qualified. A fact scores 1 for correct, 0.5 for partial,
and 0 for omitted, incorrect, or contradicted. Treat each predeclared fact at each checkpoint as one fact
occurrence: `runRecall = sum(all checkpoint fact-occurrence scores) / count(all checkpoint fact
occurrences)`. Scenario-arm recall is the mean of its three runs; the aggregate arm mean weights all
scenarios equally, and `recallDelta = treatmentMean - nativeMean`.

Completion is a predeclared binary objective check at checkpoint ten, or a frozen binary blinded-rubric
result when no objective check exists. Apply the same replicate → scenario-arm → equal-weight aggregate
order and derive `completionDelta = treatmentMean - nativeMean`. Generated outputs are scored but not fed
into later checkpoints. Quality scoring is blinded from arm identity, context size, and cost. Uncertainty is
reported but cannot turn a failed fixed threshold into a pass.

### G-003 — Demonstrate continuity benefit

At five- and ten-request checkpoints after retirement:

- treatment is worse than native Pi in no more than 10% of independent scenarios;
- treatment is better in at least 25%; and
- the win-to-loss ratio is at least 2:1.

Continuity failures include unnecessary re-questioning, repeated investigation, reopening completed work,
contradicting a settled decision, forgetting unresolved work, or claiming incomplete work is complete.
For each scenario/arm, average the predeclared binary failure counts across three replicates and both
checkpoints. Treatment is a win when its rate is lower, a loss when higher, and a tie when equal. The gate
uses equal-weight scenario counts; checkpoint-specific results are also reported. With wins and no losses,
the ratio is treated as positive infinity; zero wins and zero losses produces ratio zero.

### G-004 — Stabilize the model-facing working set

G-004 uses the same first 20 accepted scenarios as G-002. Context construction is deterministic, so the
retirement-relief calculation contributes once per scenario rather than once per replicate:

- `reliefTokens = estimatedVisibleTokensBefore - estimatedVisibleTokensAfter`, using one frozen estimator.
  A scenario materially improves headroom when `reliefTokens >= min(10% * contextWindowTokens, 2,048)`;
  at least 90% of scenarios must pass.
- For each scenario, arm, and replicate, average recorded model-facing context utilization over subsequent
  requests 1–10. Average replicates within the scenario/arm, derive `utilizationDelta = native - treatment`,
  then take the median of equal-weight scenario deltas. It must be at least 10 percentage points. All medians
  in this PRD use the middle value for odd `n` and the arithmetic mean of the two central values for even
  `n`; all p95 values use nearest rank `ceil(0.95 * n)` after ascending sort.
- For each matched replicate, encode the first native-compaction request as 1–10 and encode no compaction as
  11. Treatment must never have a lower index than native. Where native compacts within the horizon,
  `delay = treatmentIndex - nativeIndex`; the median delay must be at least three requests. If no native arm
  compacts, the delay submetric is `not-applicable` and passes only when treatment also never compacts.
- Context reduction is reported as working-set relief, not as cost savings.

### G-005 — Establish applicability and pre-pilot usability

A long session has at least 20 main-agent provider responses on its final active branch. Subject to fresh
owner consent before any content access, Phase 1 reuses the prior immutable content-free first-40 sample;
that sample was selected before content was opened and prevents a favorable redraw. If source integrity or
consent makes the sample unusable, the evaluation creates a new run ID and deterministic sample under the
same locked rule; it never replaces individual unfavorable records.

- At least 10 of the first 40 sampled long parent-agent sessions contain one safely eligible range.
- Before outcomes are visible, freeze an ordered set of at least 24 generated or real-session-derived
  candidate scenarios. Each contributes exactly one primary agent invocation; at least 85% must pass
  structural and closure validation without boundary correction.
- The first 20 accepted scenarios in that frozen order form the G-002–G-004 set and must include at least 10
  independent real-session-derived scenarios. Rejected candidates remain reported and cannot be replaced by
  favorable later candidates. Fewer than 20 accepted scenarios makes mandatory quality evidence unavailable.
- Retries and corrected submissions are reported but do not change acceptance or quality denominators.

### G-006 — Bound operational overhead

Cost and token usage are a secondary guardrail, not a product-value gate:

- The MVP performs no separate provider call solely to create a retirement record.
- Performance measurement uses at least 100 warmups and 1,000 measured handler invocations per fixture and
  supported Pi version. Report nearest-rank p50/p95/maximum per fixture and gate on the maximum per-fixture
  absolute p95, including the largest evaluated session. Pass requires `<25 ms`; exactly 25 ms is a near miss.
- The cost horizon is cumulative through checkpoint ten. A call-level ledger records each unique provider
  attempt exactly once by condition, origin, checkpoint, replicate, and attempt ID, including main requests,
  retries, failed-but-billed attempts, and native compaction. Retirement carrier or recurring metadata
  already present in a billed request is part of that request's usage and is never added again.
- Valuation precedence is fixed: use provider-reported `usage.cost.total` when present; otherwise recompute
  from actual usage channels and one frozen price card. When both exist, reported cost is authoritative and
  recomputation is a drift check only. For each scenario/arm, average three replicate ledger totals, require
  positive native cost, and calculate `overhead = (treatmentCost - nativeCost) / nativeCost`. Weight complete
  scenarios equally; gate on the globally defined median and nearest-rank p95 overhead.
- A scenario is cost-complete only when every billed attempt in both arms is uniquely recorded and valued.
  The complete-data cost status is used only when at least 16 of the 20 quality scenarios are complete, every
  scenario whose native horizon contains compaction is complete, and every included scenario has positive
  native cost. Otherwise the entire cost sub-status is `unknown`. Incomplete scenarios and reasons are
  counted and never estimated.
- For complete cost evidence, pass requires median overhead no more than 15% and p95 no more than 30%.
  `Unknown` permits only an opt-in pilot and prohibits cost-saving claims, but it does not block G-001
  through G-005 evidence.

A measured overhead breach blocks broader release until corrected and rerun.

### Phase 2 live-pilot exit metrics

These are not Phase 1 evidence gates and therefore do not participate in the decision that authorizes the
pilot. Across at least 20 independent opt-in pilot sessions, Phase 2 requires user-triggered restoration due
to missing context in no more than 10% of sessions, median usefulness of at least 4/5, no treatment-only
critical safety event, and continued passage of the live quality and overhead checks.

## 4. Out of Scope

Phase 1 and the narrow pilot do not include:

- automatic range discovery or automatic retirement;
- hidden, scheduled, or background context cleanup;
- multiple, overlapping, or non-contiguous ranges in one invocation;
- nested worker or delegated sub-agent sessions;
- cross-session memory, retrieval-augmented memory, or an external memory store;
- a separate summarizer model or an additional provider call for retirement;
- editing, deleting, or replacing persisted transcript entries;
- replacing, disabling, or tuning Pi native compaction;
- using retired history as authorization for a new consequential action;
- default-on rollout, autonomous nudges, or product claims about cost savings; or
- reactivating or implementing the superseded runtime plan from the cost-first proposal.

## 5. Personas

### Primary — Pi user running a long coding session

An advanced Pi user completes several phases of a coding task in one parent session. They want the agent
to retain current goals, constraints, decisions, repository state, verification results, and unresolved work
without repeatedly carrying every completed investigation and obsolete intermediate result. They cannot
accept context relief that causes the agent to forget requirements or misuse old approval.

### Secondary — Pi coding agent

The main agent needs an explicit, validated mechanism to declare that a completed range is no longer part
of its active working set. It needs clear refusal reasons when the range is incomplete or unsafe, and a
continuity record that distinguishes historical information from current instructions and authorization.

### Tertiary — Blackbytes maintainer

The maintainer needs measurable quality evidence, reversible behavior, lifecycle safety, and bounded
runtime overhead before accepting permanent hooks, tools, configuration, and support burden.

## 6. User Journeys

### Journey 1 — Retire a completed phase

1. The agent finishes a bounded investigation or implementation phase and obtains closure evidence.
2. The agent invokes the retirement tool with one exact contiguous range, closure rationale, and continuity
   record.
3. The system validates branch, turn, tool, recent-work, unresolved-state, and authorization boundaries.
4. On success, the action is appended to the session audit trail; prior transcript entries remain unchanged.
5. Subsequent model requests replace the retired raw range with the continuity record in model-facing
   context.
6. The agent continues the current task using a smaller, more focused working set.

### Journey 2 — Refuse unsafe retirement

1. The agent proposes a range containing an unresolved task, ambiguous boundary, pending tool result, or
   historical authorization dependency.
2. Validation rejects the proposal with a precise reason.
3. No model-facing context or persisted history changes.
4. The agent continues with the original working set or selects a narrower completed range later.

### Journey 3 — Restore context

1. The user or agent detects that retired details are needed again.
2. The user restores the affected range or disables all retirements for the session.
3. The original transcript becomes model-visible again without reconstruction from generated text.
4. The restore action is auditable and branch-local.

### Journey 4 — Make a pilot decision

1. After PRD acceptance, the maintainer accepts a separate non-shipping Evaluation Design and prototype
   plan; neither artifact registers production runtime behavior.
2. The evaluation owner runs paired native-versus-retirement scenarios with quality scorers blinded from
   context size and cost.
3. Safety, task quality, continuity, context stability, pre-pilot usability, and overhead are scored
   independently.
4. A mechanical decision produces `GO`, `REVISE`, or `NO-GO` under this PRD only.
5. `GO` authorizes a separate runtime Technical Design for a narrow opt-in pilot, not broad productization.

## 7. Functional Requirements

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-001 | Provide explicit opt-in feature control. | P0 | Disabled is the default; when disabled, no retirement tool or context transformation is active and existing Pi/Blackbytes behavior is unchanged. |
| REQ-002 | Let the main agent explicitly request retirement. | P0 | A visible agent tool accepts exactly one contiguous candidate range, closure rationale, and continuity record; there is no automatic or background invocation path. |
| REQ-003 | Validate safe completed-range boundaries. | P0 | Invalid branch, partial turn, unmatched tool, pending work, unresolved dependency, failed verification, recent protected work, ambiguous closure, and overlapping active retirement are rejected without changing context. |
| REQ-004 | Preserve a quality-oriented continuity record. | P0 | The record carries current relevant goals, hard constraints, settled decisions and rationale, verified outcomes, repository state, and unresolved work; it labels historical/revoked authorization as non-operative and cannot override newer instructions. |
| REQ-005 | Transform only model-facing context. | P0 | Successful retirement changes subsequent model input only; every prior persisted session entry remains byte-unchanged and retrievable. |
| REQ-006 | Preserve branch and native-compaction semantics. | P0 | Retirement is active-branch-local, follows tree/fork navigation, fails open on uncertain provenance, and neither disables nor modifies native Pi compaction. |
| REQ-007 | Make retirement reversible. | P0 | The user can restore one retired range or all ranges for the session; restoration uses the original transcript and succeeds after reload, navigation, and native compaction scenarios declared by the design. |
| REQ-008 | Provide auditable, privacy-safe observability. | P1 | Status exposes aggregate active-retirement count, working-set relief, refusals by fixed reason code, restores, and overhead without transcript content, paths, secrets, or retired summaries. |
| REQ-009 | Produce quality-first evidence. | P0 | A separately accepted non-shipping Evaluation Design defines the prototype and paired evaluation; reports include all G-001 through G-006 inputs, retain failures, blind quality scoring from arm/context size/cost, and do not block quality collection on missing cost attribution. |
| REQ-010 | Preserve compatibility and bounded operation. | P0 | Existing tools, sub-agents, config, prompts, session history, and native compaction remain compatible; p95 processing overhead stays below the G-006 limit and full project verification passes. |

## 8. Non-Functional Requirements

- **Safety:** consequential actions require authorization still present in active context or fresh user
  confirmation. A continuity record is historical information, never implicit current permission.
- **Privacy:** transcript content and continuity records remain local under the user's existing provider and
  filesystem boundaries. Aggregate reports suppress subgroups with fewer than five independent sessions.
- **Integrity:** existing session entries are append-only and byte-preserved. Invalid state, provenance, or
  digest evidence fails open by retaining original model-facing context.
- **Performance:** request-time retirement processing remains below 25 ms p95 on the largest evaluated
  session; cold-start cost is reported separately.
- **Availability:** no external service, database, background job, or separate summarizer is required.
- **Reproducibility:** evaluation ranges, closure evidence, rubrics, checkpoints, environment versions, and
  decision thresholds are frozen before outcomes are reviewed.
- **Compatibility:** disabled mode is behaviorally identical to current Blackbytes; native compaction,
  branch/fork/tree navigation, reload, steering, and sequential tool calls remain supported.
- **Explainability:** every refusal, retirement, and restoration has a fixed reason/status visible to the
  user without exposing hidden chain-of-thought.

## 9. Boundaries and Dependencies

- **Depends on:** Pi's model-facing context event, custom tool lifecycle, active-branch session structure,
  native compaction lifecycle, and local long-session evidence.
- **Uses but does not reinterpret:** the prior content-free corpus inventory, branch/sampling primitives,
  quality scoring patterns, safety categories, path protection, and privacy-safe reporting.
- **Does not depend on:** complete native-compaction cost attribution, a new provider API, an external memory
  service, or mutation of Pi session format.
- **Does not own:** Pi's native compaction algorithm, provider behavior, model determinism, repository-specific
  definitions of task completion, or authorization outside the active conversation.
- **Historical boundary:** the prior cost-first `NO-GO` remains unchanged. Its old runtime plan and bead graph
  stay archived/deferred and cannot be reused as implementation authorization.

## 10. Decision Rules

### 10.1 Gate-level pass, near-miss, and fail states

G-001, G-002, and the G-005 applicability minimum of 10/40 have no near-miss band. For G-003 through
G-006, classify each submetric first, then assign one status to the whole gate: `pass` when every submetric
passes (with G-006 cost `unknown` treated as pass-equivalent), `near-miss` when no submetric fails and at
least one is in its near-miss band, otherwise `fail`. Multiple near submetrics inside one gate count as one
gate-level near miss.

- **G-003:** loss rate passes at `<=10%`, is near at `>10%` and `<=15%`; win rate passes at `>=25%`, is near
  at `>=20%` and `<25%`; ratio passes at `>=2.0`, is near at `>=1.5` and `<2.0`. Anything below a near
  floor fails.
- **G-004:** relief rate passes at `>=90%`, is near at `>=80%` and `<90%`; utilization improvement passes at
  `>=10` percentage points, is near at `>=7` and `<10`; applicable median compaction delay passes at
  `>=3`, is near at `>=2` and `<3`. Any earlier treatment compaction fails with no near-miss band.
- **G-005:** applicability must pass. Primary-invocation acceptance passes at `>=85%`, is near at `>=80%`
  and `<85%`, and otherwise fails.
- **G-006:** performance passes at `<25 ms`, is near at `>=25 ms` and `<=50 ms`, and fails above 50 ms.
  Complete cost passes at median `<=15%` and p95 `<=30%`; it is near when neither exceeds 25% median or 50%
  p95 and at least one exceeds its pass bound; it fails beyond either near bound. Cost `unknown` is
  pass-equivalent for this decision but prohibits savings claims. A separate retirement-only provider call
  fails with no near-miss band.

### 10.2 Exhaustive outcome partition

- **GO:** G-001 through G-005 pass; G-006 performance passes; and G-006 cost is `pass` or `unknown`. The next
  artifact may be a separate runtime Technical Design for a narrow opt-in pilot only after report acceptance.
- **REVISE:** G-001 and G-002 pass, G-005 applicability passes, no critical event occurs, every mandatory
  G-001–G-005 input is available, exactly one of G-003 through G-006 is gate-level `near-miss`, and every
  other gate passes. G-006 cost may be `pass` or `unknown` when another gate is the sole near miss. Only the
  affected evidence is rerun under a new locked evaluation delta.
- **NO-GO:** every other terminal combination, including a G-001/G-002 failure, fewer than 10/40 applicable
  sessions, fewer than 20 accepted quality scenarios, any unavailable mandatory G-001–G-005 evidence, any
  gate-level failure, two or more gate-level near misses, unsafe authorization behavior, transcript
  mutation, provenance false positive, or a separate retirement-only provider call.
- Missing cost attribution alone is the sole allowed `unknown`: it cannot produce `NO-GO` or block quality
  evidence, but it restricts rollout to opt-in and prohibits savings claims.
- The decision engine emits the metric outcome without operator input. It then remains `pending-acceptance`
  and authorizes no runtime design until the owner acknowledges the verified report. The owner cannot change
  the metric outcome; a rejected integrity/schema claim returns the report to a nonterminal invalid-report
  state for correction rather than converting it to another outcome.
- No operator-supplied decision override is permitted.

Representative cases are fixed: all passes plus cost `unknown` → `GO`; G-003 near plus cost `unknown` →
`REVISE`; two near submetrics within G-004 only → one gate-level near miss → `REVISE`; G-003 and G-004 near
→ `NO-GO`; G-006 performance near plus cost `unknown` → `REVISE`; unavailable G-002 → `NO-GO`.

## 11. Roadmap

| Phase | Scope | Exit Criteria |
|---|---|---|
| Phase 1 MVP — Quality and Safety Evidence | After PRD acceptance, create and accept a non-shipping Evaluation Design/prototype; freeze the quality-first protocol; validate completed-range and authorization rules on adversarial/generated cases; run newly authorized paired scenarios from representative long sessions; measure G-001 through G-006 without a cost prerequisite. | All mandatory evidence is complete; owner accepts one mechanical `GO`, `REVISE`, or `NO-GO`; no production runtime behavior was registered. |
| Phase 2 MVP — Narrow Opt-In Pilot | Only after `GO` and a separate runtime Technical Design: one explicit contiguous retirement at a time for long parent sessions, append-only transcript, restore controls, native-compaction coexistence, aggregate diagnostics. | At least 20 independent pilot sessions pass the live restoration, usefulness, quality, continuity, stability, safety, and overhead thresholds; rollback is verified. |
| Phase 3 — Productization Decision | Evaluate broader range support, candidate suggestions, UX/status improvements, and wider rollout. Automatic retirement remains a separate future hypothesis. | Every added capability has accepted requirements and evidence; release readiness is reviewed separately. |

## 12. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | What is the primary success dimension? | invoker | resolved — task quality and continuity are primary; context stability supports them |
| Q-002 | Who initiates retirement in MVP? | invoker | resolved — the main agent explicitly invokes a visible tool |
| Q-003 | May retirement modify persisted transcript history? | invoker | resolved — no; model-facing projection only, transcript preserved |
| Q-004 | What role does cost play? | invoker | resolved — secondary guardrail and observability, not the product-value gate |
| Q-005 | Are the proposed G-002 through G-006 thresholds and near-miss bands acceptable before Evaluation Design begins? | invoker | resolved — accepted as written and frozen for the Evaluation Design |
| Q-006 | May Phase 1 reuse the prior frozen content-free sample after fresh consent? | invoker | resolved — reuse it to prevent redraw; require fresh confirmation before content access; use a new deterministic run only if integrity/consent blocks the whole sample |
| Q-007 | What exact user-facing restore control belongs in the narrow pilot? | invoker | open; resolve in the runtime Technical Design after evidence `GO` |
| Q-008 | Who serves as the independent blinded continuity/quality scorer? | invoker | open; resolve in the Evaluation Design before paired evidence |
| Q-009 | What is the official feature name? | invoker | resolved — Agent Context Working Set |

## 13. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-16 | Bytes | Created the Draft quality-first PRD from the owner's clarified goals, the archived cost-first evidence, reusable local evaluation primitives, and explicit decisions on agent invocation, transcript preservation, and cost guardrails. |
| 2026-07-16 | Bytes | Moved to Review after reader testing separated pre-pilot evidence from live-pilot exits, defined independent-unit/replicate calculations, froze near-miss bands and an exhaustive decision partition, and proposed reuse of the prior content-free sample under fresh consent. |
| 2026-07-16 | invoker | Accepted the quality-first PRD, metric and near-miss package, consent-gated reuse of the prior sample, and the official name Agent Context Working Set. |
| 2026-07-16 | Bytes | Final PRD-readiness passes fixed recall/completion, context-stability, call-ledger/cost-completeness, median/percentile, censored-compaction, report-acceptance, and gate-level decision contracts without changing the accepted product thresholds. |
