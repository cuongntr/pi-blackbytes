# Change Request — Close Evidence-Readiness Gaps

| Field | Value |
|---|---|
| Change ID | `context-pruning-change-001` |
| Short name | Close evidence-readiness gaps |
| Original plan | [`context-pruning-evidence-spike-implementation-plan.md`](context-pruning-evidence-spike-implementation-plan.md) |
| Status | Applied |
| Owner | invoker |
| Created | 2026-07-14 |
| Accepted | 2026-07-14 |
| Applied | 2026-07-14 |

## 1. Change summary

The Active Evidence Spike plan remains the scope baseline, but its executable bead contracts need
clarification before implementation. This delta stages immutable protocol locks, serializes hard-stop
checks before sensitive/paid work, separates hermetic runner validation from real evidence execution,
and freezes the previously ambiguous estimator, uncertainty, privacy, retry, provenance, and terminal
state rules.

No production runtime compression behavior or new leaf is added.

## 2. Compelling reason

Polish pass 1 found four semantic blockers despite a structurally valid graph:

1. one `protocol.lock.json` was expected both before inventory and after target/fixture decisions;
2. sibling dependencies allowed avoidable sensitive or paid work before earlier hard-stop evidence;
3. T-011 required the not-yet-selected largest session and not-yet-pinned Pi version before T-016;
4. gate-affecting algorithms used terms such as “estimated,” “non-trivial,” “symmetric,” and
   “suppressed” without executable boundaries.

Leaving these unresolved would let independent implementers invent evidence policy and could change the
GO/REVISE/NO-GO result. The corrections preserve the Accepted PRD goals and the original 29-leaf scope.

## 3. What changes — Before / After

### Before

- T-003 described one protocol lock containing both pre-inventory and post-inventory decisions.
- T-009B and T-017 could run as siblings; T-018/T-019 could precede T-009B; T-022 could precede T-021.
- T-011 required real selected data before the formal inventory existed.
- Qualification estimation, bootstrap, provenance coverage, low-count suppression, and retry limits
  were not fully deterministic.
- T-009B could end in an unresolved “extension” state, and execution-bead commands were descriptive.

### After

- `sampling.lock.json` binds the estimator before inventory; `target-selection.json` binds the target
  and provider retry/error/timeout/confirmation policy before proof or qualification;
  `evaluation.lock.json` references those predecessor values before replay. Changing a lock requires a
  new run ID.
- Safe execution order becomes T-016 → T-017 → T-009B → T-018/T-019 → T-020 → T-021 → T-022
  → T-023. T-009B's confirmed generated-only proof is the sole provider-call exception before
  accounting is complete.
- T-010B/T-011 implement and hermetically validate parameterized runners with generated fixtures;
  T-021 exclusively runs the real two-version/largest-selected-session matrix.
- Qualification estimate is `ceil(UTF8ByteLength(canonicalModelVisibleCandidateContent) / 4)` and is
  never treated as actual, billed, or saved tokens. Underflow is `pending` while both locked refresh/
  time budgets remain and becomes a terminal hard-stop only when either limit is reached.
- Uncertainty uses 10,000 deterministic snapshot-cluster bootstrap resamples with canonical-JSON seed,
  SHA-256 counter/rejection draws, fixed big-endian encoding/modulo mapping, and a golden vector;
  aggregate buckets with fewer than five independent units are suppressed; provider requests allow at
  most one retry under the same retryable-error policy for both arms.
- Each lifecycle scenario with ground-truth-ownable messages must correctly claim one complete-turn
  range of at least 2,048 qualification-estimated tokens with zero false-positive ownership/boundary
  claims.
- When applicable, T-009B proof outcome is `complete` or `blocking-incomplete`; an upstream hard-stop
  instead records separate stage disposition `not-applicable`. Neither incomplete path authorizes
  current-run qualification or paid replay.
- The CLI contract is `bun run evidence:context-pruning -- <command> ...`; execution beads name dry-run,
  confirm/decline, upstream-not-applicable, execution, verification, and terminal artifacts.

### Concrete diff

| Aspect | Before | After |
|---|---|---|
| Scope | 29 evidence leaves | Same 29 evidence leaves; no runtime work |
| Architecture | One ambiguous lock lifecycle | Three immutable staged artifacts linked by digests |
| Dependency | 81 task edges | 85 task edges; four safety-ordering edges added |
| Validation | Descriptive commands/constants | Exact command contract and deterministic policy constants |
| Privacy | Unspecified low-count threshold | Suppress aggregate buckets with `n < 5` independent units |
| Provider cost | Unbounded “symmetric” retry wording | Maximum one retry per planned request and bounded upper-cost confirmation |
| Provenance | “Non-trivial” coverage | One fully claimed ≥2,048-token complete-turn range per applicable scenario |

## 4. Impact

### Affected beads

| Bead ID | Action | Reason |
|---|---|---|
| `pib-context-pruning-evidence-bad9.1.1` | UPDATE description | Freeze exact CLI and standard validation contract. |
| `pib-context-pruning-evidence-bad9.1.4` | UPDATE description | Define staged lock schemas and deterministic constants. |
| `pib-context-pruning-evidence-bad9.2.3` | UPDATE description | Define bounded pending-versus-terminal inventory underflow. |
| `pib-context-pruning-evidence-bad9.3.1` | UPDATE description | Embed canonical qualification estimator. |
| `pib-context-pruning-evidence-bad9.4.2` | UPDATE description + DEP add T-017 | Use selected target and two terminal states after frame gate. |
| `pib-context-pruning-evidence-bad9.4.3` | UPDATE description | Embed executable provenance coverage boundary. |
| `pib-context-pruning-evidence-bad9.4.4` | UPDATE description | Restrict implementation validation to generated/mocked fixtures. |
| `pib-context-pruning-evidence-bad9.4.5` | UPDATE description | Remove impossible pre-inventory real-session acceptance. |
| `pib-context-pruning-evidence-bad9.4.7` | UPDATE description | Freeze one-retry policy and bounded cost calculation. |
| `pib-context-pruning-evidence-bad9.5.1` | UPDATE description | Freeze bootstrap algorithm and conditional task checks. |
| `pib-context-pruning-evidence-bad9.5.2` | UPDATE description | Embed complete PRD REVISE/missing-evidence partition. |
| `pib-context-pruning-evidence-bad9.5.3` | UPDATE description | Freeze `n < 5` aggregate suppression. |
| `pib-context-pruning-evidence-bad9.5.4` | UPDATE description | Enumerate synthetic hard-stop scenarios and fail-fast adapters. |
| `pib-context-pruning-evidence-bad9.6.1` | UPDATE description | Own sampling lock verification and target-selection record. |
| `pib-context-pruning-evidence-bad9.6.2` | UPDATE description + DEP add T-009B | Correct prerequisites and avoid content access after accounting failure. |
| `pib-context-pruning-evidence-bad9.6.3` | UPDATE description + DEP add T-009B | Correct prerequisites and avoid content access after accounting failure. |
| `pib-context-pruning-evidence-bad9.6.4` | UPDATE description | Create final evaluation lock without mutating earlier locks. |
| `pib-context-pruning-evidence-bad9.6.5` | UPDATE description | Own real two-version/largest-session lifecycle execution. |
| `pib-context-pruning-evidence-bad9.6.6` | UPDATE description + DEP add T-021 | Prevent paid replay after a lifecycle hard stop. |
| `pib-context-pruning-evidence-bad9.6.7` | UPDATE description | Name exact final verify/report sequence and terminal outcome. |

### Other affected artifacts

- [ ] PRD: no update; goals, gates, personas, and scope are unchanged.
- [x] Technical design: update lock lifecycle and deterministic algorithm/security/retry contracts.
- [ ] ADR: none; no production architecture decision.
- [ ] Migration/schema: none; evidence artifacts remain local and versioned.
- [ ] API contract: no public API; only the evaluation CLI contract is clarified.

### Risk delta

The delta reduces premature paid/content-bearing execution and outcome-dependent policy choices. It adds
no production risk. The stricter sequencing lengthens the critical path intentionally; verified
hard-stop leaves still close through hashed `not-applicable` records.

## 5. Out of scope for this delta

- New evidence leaves, broader sampling, runtime compression, production hooks/tools/config/state, or
  reopening the deferred runtime graph.
- Selecting the actual provider/model/API/reasoning tuple or pinned current Pi version; those remain
  owner decisions after formal inventory.
- Resolving whether native-compaction usage is actually attributable; T-009B still produces that evidence.
- Changing any PRD quality, utility, applicability, feasibility, or GO/REVISE/NO-GO threshold.

## 6. Approval

Approved-by: invoker, 2026-07-14

Approved choices:

- qualification estimator: UTF-8 bytes divided by four;
- provenance boundary: one complete qualifying range per applicable scenario;
- constants package: 10,000 cluster-bootstrap resamples, `n < 5` suppression, maximum one retry;
- disposition: accept and apply this delta to Design, plan trace/history, and beads.

## 7. Apply plan

1. Update the Active Evaluation Design with staged locks and frozen algorithms.
2. Add the four safety-ordering dependency edges.
3. Update the 20 affected bead descriptions without changing leaf count or production scope.
4. Add a baseline-plan revision-history reference; retain the original dependency table as baseline.
5. Validate all 29 leaves, 85 intended current edges, cycles, ready set, labels, and lint.
6. Mark this delta `Applied` only after all checks pass.

## 8. Things deliberately NOT changed

- T-016 retains its explicit 16-component fan-in as an auditable integration checklist even though some
  edges are transitively redundant.
- T-013 does not depend directly on T-012C: it implements conditional task-completion scoring, while
  T-022 already waits for both components before execution.
- T-018 and T-019 remain separate 20-rank batches to preserve bounded manual work and rule consistency.
- The baseline plan is not rewritten; this delta is the authoritative override for the affected contracts.

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-14 | Bytes | Created and moved to Review after polish pass 1 found semantic readiness blockers. |
| 2026-07-14 | invoker | Accepted the recommended delta and selected the estimator, provenance, and constants package. |
| 2026-07-14 | Bytes | Polish pass 2 clarified pre-use policy ownership, froze the bootstrap draw stream/golden vector, and separated proof outcome from upstream stage disposition. |
| 2026-07-14 | Bytes | Polish pass 3 added the sole generated-proof provider exception and bounded pending/terminal underflow state machine. |
| 2026-07-14 | Bytes | Polish pass 4 found no remaining blocker; marked the delta Applied and the graph ready for T-001. |
