# Dynamic Context Pruning — Evidence-First PRD

| Field | Value |
|---|---|
| Status | Accepted |
| Owner | invoker |
| Created | 2026-07-14 |
| Updated | 2026-07-16 |
| Variant | Brownfield |
| Decision state | Cost-first proposal ended owner-accepted `NO-GO`; its runtime plan remains deferred |
| Successor PRD | [`agent-context-working-set.md`](agent-context-working-set.md) — separate quality-first product lineage |
| Related plan | [`../plans/context-pruning-implementation-plan.md`](../plans/context-pruning-implementation-plan.md) (deferred; not authoritative) |

## 1. Context

Pi users working on long, multi-stage coding tasks can accumulate high cumulative input-token
usage and repeatedly approach the model context limit. The owner has observed both effects in real
use. Pi already mitigates context exhaustion through native compaction, which summarizes older
history near the context limit while retaining recent work.

Selective compression could complement native compaction by replacing a completed, token-heavy
segment before the global threshold is reached. This may help when an investigation or
implementation phase is finished but the session continues for enough later requests to amortize
the cost of producing and carrying a summary.

That benefit is currently a **hypothesis**, not an established product fact. The project has not yet
measured:

- how often qualifying long-session patterns occur;
- whether selective summaries preserve facts and constraints as well as native Pi;
- total token and cost effects after all compression overhead;
- whether Pi session, branch, tool, and compaction lifecycles support a safe implementation; or
- whether the added runtime complexity is justified for the wider Pi user population.

The previous draft moved directly from the upstream DCP concept to a runtime design. This revision
changes Phase 1 to an evidence-first decision gate. No runtime context-pruning feature should be
implemented or shipped unless the evidence satisfies the quality, utility, applicability, and
feasibility criteria below.

## 2. Product Hypothesis

For Pi users running long parent-agent sessions that contain a completed, token-heavy work segment
followed by several additional model requests, selective compression can reduce cumulative input
tokens and delay context saturation **without reducing task completion or retention of important
facts and constraints compared with native Pi compaction**.

The hypothesis does not claim that selective compression benefits short sessions, every long
session, or sessions that end soon after a candidate segment closes.

### 2.1 Qualifying session

For Phase 1 evaluation, a session qualifies when all of the following are true:

1. It is a parent-agent session rather than a nested worker session.
2. It reaches at least 70% of the active model context window or triggers native Pi compaction.
3. It contains at least one clearly completed segment whose gross removable context is at least
   2,048 estimated tokens.
4. At least five subsequent model requests occur after that segment closes.

These criteria identify the cohort where compression has a plausible opportunity to break even.
They are evaluation criteria, not a commitment to future runtime thresholds.

## 3. Goals and Success Metrics

Phase 1 succeeds only if **all four gates** pass. Passing implementation tests alone is insufficient.

### G-001 — Preserve task quality (primary)

- Across the paired evaluation set, mean fact-and-constraint recall must not be more than five
  percentage points below the native-Pi baseline.
- Task completion must not be lower than the native-Pi baseline. Completion is determined by
  objective repository checks where available and a predeclared blinded rubric otherwise.
- No selective-compression run may introduce a severe safety regression, such as treating stale or
  revoked historical approval as current authorization.

A failure of this gate is an automatic `NO-GO`, regardless of token savings.

### G-002 — Demonstrate net utility

- For the declared target model/provider cohort, median total provider-equivalent cost reduction
  must be at least 10% versus the native-Pi baseline. Cost is calculated from actual reported input,
  output, and cache usage using a recorded pricing snapshot.
- If the provider does not expose enough actual usage data for that calculation, G-002 cannot pass;
  the decision is at most `REVISE` until the missing evidence is obtained.
- At least half of qualifying snapshots must break even by the fifth subsequent model request.
  Snapshots that do not break even by request five are recorded as `>5`, not excluded.
- Cost accounting must include all summary-generation and summary-carrier overhead, recurring
  prompt/tool metadata required by the evaluated approach, and observable prompt-cache effects.
- Cumulative input-token reduction is reported separately and cannot substitute for the cost gate.
- Gross context reduction must not be reported as net savings.

A failure of this gate means the runtime feature is not justified in its evaluated form.

### G-003 — Establish applicability

- Analyze the first 40 representative long parent-agent sessions selected by the sampling protocol.
- Produce at least 10 qualifying session snapshots for paired evaluation.
- At least 25% of those 40 sessions must qualify. If fewer than 10 qualify, this gate fails.

This prevents optimizing the package for an exceptionally rare workflow without explicit evidence
that the narrow cohort is still worth supporting.

### G-004 — Establish technical feasibility

- Provenance evaluation must produce zero false-positive ownership or range assignments on the real
  evaluation corpus. Ambiguous content may remain unowned.
- The feasibility prototype must behave correctly across reload, native compaction, branch/fork/tree
  navigation, steering, duplicate messages, sequential tool calls, and coexistence with another
  context transformer.
- Measured p95 request-time processing overhead across replayed prototype invocations must remain
  below 25 ms, including invocations using the largest sampled session.
- Phase 1 must not modify persisted user sessions or existing Blackbytes runtime behavior.

## 4. Out of Scope

Phase 1 does not include:

- a user-facing or model-facing compression tool;
- transformation of live model context;
- context-reference injection into live messages;
- new Blackbytes runtime configuration, commands, status sections, or nudges;
- automatic range selection or automatic summary generation in production;
- decompression or recompression controls;
- nested sub-agent support;
- replacement, cancellation, or modification of Pi native compaction;
- provider-payload or reasoning-metadata manipulation;
- copying upstream DCP source, prompts, schemas, or content-parsing patterns; or
- shipping an experimental runtime capability before the evidence decision is accepted.

## 5. Personas

### Primary — Pi user running long coding sessions

An advanced Pi user works through investigation, implementation, testing, and follow-up in one
parent session. They experience high input-token usage and approach the context limit, but cannot
accept cheaper operation if the agent forgets constraints, fabricates completed work, or makes worse
decisions after summarization.

### Secondary — Blackbytes maintainer

The maintainer needs an evidence-backed decision before accepting permanent hooks, tools, state,
configuration, tests, and support burden. They need reproducible results, explicit stop conditions,
and no changes to normal users during evaluation.

### Tertiary — Evaluation owner

The evaluation owner curates local session samples, protects sensitive content, predeclares scoring
rules, and produces an auditable `GO`, `REVISE`, or `NO-GO` report without cherry-picking favorable
sessions.

## 6. User Journeys

### Journey 1 — Establish the native-Pi baseline

1. The evaluation owner selects representative long parent-agent sessions under explicit local-data
   handling rules.
2. The evidence tooling classifies each session against the qualifying-session criteria.
3. It reports context trajectory, native compaction events, available usage/cost data, candidate
   completed segments, and subsequent request count.
4. The owner reviews aggregate metrics and exclusions without publishing raw session content.
5. If the target workflow is too rare, the evaluation ends with `NO-GO` before runtime code is built.

### Journey 2 — Compare native Pi with selective compression

1. The owner creates equivalent evaluation snapshots from qualifying sessions.
2. Each snapshot is evaluated in a native-Pi condition and a selective-compression condition using
   the same model family, repository state, questions, and scoring rubric.
3. Evaluators measure fact/constraint recall, task outcome, total token/cost usage, and requests to
   break even.
4. Failures and regressions remain in the dataset; they are not removed because they are unfavorable.
5. Aggregate results are compared against all four success gates.

### Journey 3 — Make an explicit product decision

1. The evidence report presents methods, corpus characteristics, aggregate results, failure cases,
   limitations, and reproducibility instructions.
2. The owner records one outcome: `GO`, `REVISE`, or `NO-GO`.
3. `GO` permits a separate Technical Design for a narrow runtime pilot.
4. `REVISE` requires a new hypothesis or evaluation delta before more runtime planning.
5. `NO-GO` archives the proposal and retains the evidence to prevent repeating unsupported work.

## 7. Functional Requirements

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-001 | Build a representative local evaluation corpus. | P0 | The first 40 long parent sessions selected by the sampling protocol are analyzed; inclusion, exclusion, source, model, and sampling order are recorded; raw content is not committed. |
| REQ-002 | Measure the native-Pi baseline. | P0 | Each sampled session has context-pressure, compaction, available usage/cost, duration, and task-outcome fields; missing provider data is marked missing rather than estimated as actual. |
| REQ-003 | Classify qualifying sessions and candidate ranges. | P0 | Classification applies the criteria in §2.1 consistently; each candidate range has a documented closure rationale and subsequent-request count; ambiguous ranges are excluded. |
| REQ-004 | Run a paired quality evaluation. | P0 | At least 10 qualifying snapshots are evaluated under both conditions with the same exact model, reasoning settings, repository state, questions, and predeclared rubric; each condition has at least three runs per snapshot unless the replay is deterministic; run order is randomized and all failures are retained. |
| REQ-005 | Score quality independently of token savings. | P0 | Results include fact/constraint recall, objective task checks where available, severe safety regressions, and blinded rubric scores where objective checks are unavailable. |
| REQ-006 | Account for complete token and cost effects. | P0 | The report separates gross context reduction, all summary-generation and carrier overhead, recurring prompt/tool metadata, observable cache effects, cumulative provider-equivalent cost, input-token reduction, and requests to break even. |
| REQ-007 | Validate Pi lifecycle feasibility. | P0 | A non-shipping prototype demonstrates the scenarios in G-004 on the minimum supported Pi version and the current supported version; failures are documented and block `GO`. |
| REQ-008 | Produce a reproducible decision report. | P0 | The report includes methodology, corpus summary, aggregate and per-scenario results, excluded samples, limitations, threshold outcomes, and exactly one `GO`, `REVISE`, or `NO-GO` recommendation. |
| REQ-009 | Protect evaluation data. | P0 | Evaluation remains local; generated reports redact secrets and omit raw conversation content; temporary artifacts have an explicit cleanup path. |
| REQ-010 | Preserve existing behavior. | P0 | Phase 1 registers no production hooks/tools, changes no user configuration, and passes the existing project verification suite. |

## 8. Non-Functional Requirements

- **Security and privacy**: session content remains local; no corpus or raw transcript is committed;
  reports and logs use existing secret-redaction behavior; destructive cleanup requires explicit
  confirmation.
- **Performance**: offline evidence collection must not affect normal Pi sessions. The lifecycle
  prototype must demonstrate measured p95 request-time overhead below 25 ms over replayed
  invocations that include the largest sampled session; extrapolation alone cannot pass the gate.
- **Availability**: Phase 1 introduces no runtime service. Missing or unreadable samples fail
  individually and cannot alter the source session.
- **Reproducibility**: sampling order, model identifiers, evaluation inputs, scoring version, and
  calculation formulas are recorded. Aggregate results can be regenerated from the same local
  corpus.
- **Integrity**: excluded and failed runs remain visible in the report. Threshold formulas are fixed
  before paired results are reviewed.
- **Compatibility**: existing tools, sub-agents, settings, prompts, and Pi native compaction behavior
  remain unchanged during Phase 1.
- **Package size**: Phase 1 adds no production dependency and does not weaken the existing package
  size gate.

## 9. Boundaries and Dependencies

- **Depends on**: locally available Pi session data, usage metadata exposed by the selected model or
  provider, Pi native compaction records, representative repositories/tasks, and access to both the
  minimum supported Pi version and the current supported version.
- **Does not own**: Pi's session format, native compaction policy, provider billing semantics, model
  determinism, or repository-specific definitions of task completion.
- **Does not assume**: that estimated tokens equal billed tokens, that prompt-cache behavior is the
  same across providers, or that a summary preserving token count also preserves task quality.
- **External services**: none are required. If an evaluation model requires a provider request, that
  request uses the user's existing Pi provider configuration and is recorded as evaluation cost.

## 10. Decision Rules

- **GO**: all four goals pass, no unresolved P0 feasibility defect remains, and the owner accepts the
  evidence report. The next artifact is a separate Technical Design for a narrow runtime pilot.
- **REVISE**: G-001 passes with no severe safety regression; every other non-quality gate passes;
  and exactly one non-quality gate instead lands in one predefined near-miss band: median cost
  reduction is at least 5% but below 10%; measured p95 overhead is 25–50 ms with a documented
  non-invasive optimization; or one non-provenance lifecycle scenario has a specific non-invasive
  fix. Applicability has no near-miss band because quality and utility evaluation require at least
  10 independent qualifying sessions. Missing provider usage data may also produce `REVISE`
  once for a specific collection extension when every measurable gate passes. The revised hypothesis
  and affected evidence must be rerun.
- **NO-GO**: any gate failure that does not satisfy the complete `REVISE` rule above results in
  `NO-GO`. This includes G-001 failure; any severe safety or provenance false-positive; fewer than
  half of snapshots breaking even by request five; median cost reduction below 5% or increased cost;
  fewer than 10 of the first 40 sessions qualifying; p95 overhead above 50 ms; more than one
  non-quality miss; unavailable required evidence after the agreed extension; or lifecycle
  reliability that lacks a specific non-invasive remedy.

No implementation plan for the runtime feature may become `Active` before a `GO` decision.

## 11. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| Phase 1 MVP — Evidence Spike | Local baseline analysis, qualifying-session classification, paired quality/cost evaluation, Pi lifecycle feasibility prototype, and decision report. | REQ-001 through REQ-010 complete, or a predeclared hard-stop condition is verified and reported; all available goal gates are evaluated; owner records `GO`, `REVISE`, or `NO-GO`. |
| Phase 2 MVP — Narrow Runtime Pilot | Only after `GO`: opt-in pilot for one contiguous completed range, with complete cost accounting and no automatic selection, commands, or nudges. Exact behavior requires a separate accepted Technical Design. | Pilot-specific quality and utility gates pass on live opt-in sessions; rollback is verified; existing behavior remains compatible. |
| Phase 3 — Productization Decision | Evaluate broader range support, visibility/controls, automation, and package-wide defaults based on pilot evidence. | Each accepted capability has explicit requirements; unsupported ideas are rejected or deferred; release readiness is reviewed separately. |

## 12. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | Are 40 representative long parent sessions available under the local-data rules? | invoker | resolved — 40 sessions were deterministically frozen from 182 eligible sources |
| Q-002 | Which repositories provide objective task-completion checks for paired evaluation? | invoker | terminal `not-applicable` — T-009B blocked fixture review before sampled content was opened |
| Q-003 | Which configured providers expose actual input, output, and cache usage needed for complete accounting? | invoker | resolved `blocking-incomplete` — the selected target did not expose completely attributable native-compaction/following-main usage |
| Q-004 | What blinded rubric and evaluator will be used when objective repository checks are unavailable? | invoker | terminal `not-applicable` — annotation and scoring were not authorized after T-009B |
| Q-005 | What license will govern pi-blackbytes distribution and the clean-room documentation? | invoker | deferred; does not affect Phase 1 local evidence work |

## 13. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-14 | Bytes | Created the initial solution-led Draft PRD and Technical Design from DCP research. |
| 2026-07-14 | Bytes | Replaced the combined draft with an evidence-first PRD; made task quality the primary gate, net utility secondary, and changed Phase 1 from runtime implementation to an evidence spike. |
| 2026-07-14 | Bytes | Resolved review findings: aligned the 40-session sample math, made provider-equivalent cost authoritative, defined deterministic decision bands, and clarified measured performance. |
| 2026-07-14 | Bytes | Made decision rules exhaustive and mutually exclusive: `REVISE` permits exactly one bounded near-miss with all other gates passing; every other failure is `NO-GO`. |
| 2026-07-14 | Bytes | Removed the unreachable applicability near-miss; fewer than 10 qualifying sessions is now unambiguously `NO-GO`. |
| 2026-07-14 | invoker | Accepted the evidence-first PRD; requested corpus inventory as the first Phase 1 activity. |
| 2026-07-14 | Bytes | Completed metadata-only inventory: 351 candidate session files found with valid structural/usage data; qualification remains pending. |
| 2026-07-14 | invoker | Activated the Phase 1 Evaluation Design; clarified that a verified hard-stop can complete Phase 1 with `NO-GO`. |
| 2026-07-16 | Bytes / invoker | Completed the verified hard-stop path after mandatory compaction usage remained unattributable; downstream stages were authenticated as not applicable, the terminal report verified, and invoker accepted the mechanical `NO-GO`. Runtime implementation remains deferred. |
| 2026-07-16 | Bytes / invoker | Linked the accepted [`agent-context-working-set.md`](agent-context-working-set.md) successor PRD. The new quality-first lineage does not reinterpret this cost-first `NO-GO` or reactivate its runtime plan. |
