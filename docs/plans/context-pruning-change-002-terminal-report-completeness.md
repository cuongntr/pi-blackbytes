# Change Request — Complete Terminal Report Aggregates

| Field | Value |
|---|---|
| Change ID | `context-pruning-change-002` |
| Short name | Complete terminal report aggregates |
| Original plan | [`context-pruning-evidence-spike-implementation-plan.md`](context-pruning-evidence-spike-implementation-plan.md) |
| Status | Applied |
| Owner | invoker |
| Created | 2026-07-16 |
| Accepted | 2026-07-16 |
| Applied | 2026-07-16 |

## 1. Change summary

The completed `formal-pass-a-v4` run has an immutable terminal decision and immutable primary report
siblings. This delta adds an append-only, privacy-safe terminal corpus supplement rather than rewriting
those authoritative artifacts to complete the T-017 aggregate report and clarify that sample count passed
`40/40` while applicability remained blocked.

## 2. Compelling reason

The feature-done review found that the committed report omitted already-available T-017 sensitivity,
structural exclusion, and repository-concentration aggregates. It also found that the historical terminal
decision trace grouped `G003.sample-count` under the overall applicability blocker even though the
first-40 prerequisite had passed.

Rewriting `decision.json`, `report.local.json`, or `report.aggregate.json` would violate the accepted
protocol's immutability contract. A digest-bound supplemental sibling is therefore the smallest safe
correction.

## 3. What changes — Before / After

### Before

- The primary terminal report was derived only from the terminal decision and downstream dispositions.
- Verified T-017 inventory/sample aggregates were absent from the committed-safe report.
- The existing primary artifacts could not be corrected without violating immutability.

### After

- `report` appends `terminal-hard-stop/report-supplement-v1.json` after revalidating persisted
  structural inventory, sampling lock, sample, target anchor, T-009B resolution, run manifest, and
  terminal decision bindings.
- The private supplement contains canonical predecessor digests and run binding plus a reportable
  `corpusSummary` limited to source/frame/sample counts, fixed sensitivity counts, privacy-suppressed
  structural exclusion counts, identifier-free repository concentration, and explicit sample/applicability
  gate evidence.
- Legacy runs with valid primary reports but no supplement return `nextStage: "report"` and upgrade
  append-only. Identical publication resumes; drift fails closed.

### Concrete diff

| Aspect | Before | After |
|---|---|---|
| Scope | T-023/T-024 terminal reports | One closure leaf, T-025 |
| Storage | Three immutable terminal artifacts | Same artifacts plus one immutable supplement |
| Privacy | Qualifying-snapshot buckets suppressed | Those buckets plus `n < 5` suppression for structural subgroups |
| Decision | Historical `NO-GO` | Unchanged `NO-GO`; supplemental sample-count evidence records `40/40` pass |
| Runtime API | No production runtime behavior | Unchanged |

## 4. Impact

### Affected beads

| Bead ID | Action | Reason |
|---|---|---|
| `pib-context-pruning-evidence-bad9.6.9` | NEW | Implement and verify the append-only terminal corpus supplement. |

### Other affected artifacts

- [x] PRD: no goal, gate, persona, or runtime-authorization change.
- [x] Technical design: status/history and applied-change link updated.
- [x] ADR: none; no production architecture decision.
- [x] Migration/schema: no migration; one versioned local evidence sibling is appended.
- [x] Public API: none; only the local evidence CLI report/verify behavior is extended.

### Risk delta

The new risk is accidental disclosure of small structural subgroups or pseudonyms. The implementation
returns a closed aggregate shape, suppresses every nonzero subgroup count below five, omits all
repository/corpus/session identifiers and paths, authenticates the target anchor, and verifies the
supplement from predecessor artifacts on every report/verify operation.

## 5. Out of scope for this delta

- Reinterpreting or replacing the owner-accepted `NO-GO`.
- Reopening qualification, lifecycle, scoring, replay, or provider execution.
- Rewriting any immutable formal-pass-a-v4 decision, report, lock, inventory, sample, target, or proof.
- Runtime context-pruning hooks, tools, configuration, state, prompts, or frozen runtime beads.

## 6. Approval

Approved-by: invoker, 2026-07-16

Approval was given by asking Bytes to continue the reviewed closure work; it does not authorize runtime
context-pruning implementation.

## 7. Apply plan

1. Add T-025 under the Phase 1 execution epic with T-024 as prerequisite.
2. Implement authenticated structural aggregate loading and append-only supplement publication.
3. Add privacy, target-anchor, legacy-upgrade, resume, and drift regression coverage.
4. Publish and verify the supplement for `formal-pass-a-v4` without provider or source access.
5. Update the report, design, baseline plan trace/history, and this delta.
6. Mark the delta Applied and close T-025 after `bun run check` passes.

## 8. Things deliberately NOT changed

- The historical decision trace remains byte-for-byte intact; the supplement is the correction layer.
- Primary report JSON remains unchanged, while CLI stdout augments the candidate in memory with
  `corpusSummary`.
- Local source sessions and copied selected sessions are not reopened during the upgrade.
- The deferred runtime graph remains frozen.

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-16 | Bytes | Created and accepted the closure delta after feature-done review found report-completeness and sample-count interpretation gaps. |
| 2026-07-16 | Bytes / invoker | Applied append-only supplement, privacy suppression, integrity tests, and documentation updates; runtime decision unchanged. |
