# Context-Pruning Phase 1 Evidence Report

## Decision

| Field | Result |
|---|---|
| Mechanical outcome | **NO-GO** |
| Owner acceptance | Accepted by invoker on 2026-07-16 |
| Runtime implementation | Remains deferred |

The generated-fixture compaction-accounting gate ended `blocking-incomplete`. Native compaction exposed split-turn/duplicate usage attribution, and the following-main stage had no attributable usage. The protocol forbids estimation, so required downstream quality, utility, applicability, lifecycle, and paid-replay evidence was not collected.

Under the accepted PRD, unavailable required evidence after the permitted collection attempt is a terminal `NO-GO`; it cannot qualify for `REVISE`.

## Evidence flow

| Stage | Aggregate result |
|---|---|
| Formal inventory | 360 sources inventoried; 182 met the locked structural eligibility rules |
| Immutable sample | First 40 eligible sessions frozen deterministically |
| Target selection | `openai-codex/gpt-5.6-sol`, `openai-codex-responses`, reasoning `medium` |
| Compaction accounting | `blocking-incomplete` |
| Qualification ranks 1–20 | `not-applicable` |
| Qualification ranks 21–40 | `not-applicable` |
| Adjudication and protocol freeze | `not-applicable` |
| Lifecycle and performance matrix | `not-applicable` |
| Paid replay and scoring | `not-applicable` |

### Verified T-017 structural corpus supplement

The initial 2026-07-14 metadata scan found 351 files. That was an earlier discovery scan, not the later immutable formal inventory. The formal T-017 inventory recorded 360 sources, of which 182 formed the locked eligible frame; its deterministic first-40 sample was frozen successfully.

| Structural measure | Verified aggregate |
|---|---:|
| Source count | 360 |
| Eligible frame size | 182 |
| Frozen sample size | 40 |
| Sensitivity: at least 10 requests | 242 |
| Sensitivity: at least 15 requests | 208 |
| Sensitivity: at least 20 requests | 182 |
| Sensitivity: at least 25 requests | 160 |
| Exclusion: malformed JSONL | `<5` — suppressed |
| Exclusion: missing parent | `<5` — suppressed |
| Exclusion: unresolved parent session | 9 |
| Frame repository concentration | 16 repositories; dominant 48/182 (26.37%) |
| Sample repository concentration | 10 repositories; dominant 11/40 (27.5%) |

These are identifier-free aggregates only; nonzero subgroup counts below five are suppressed, and no repository pseudonym, corpus identifier, path, session, entry, or content is included. The immutable terminal decision and primary reports are preserved. An append-only terminal report supplement supplies this correction layer: sample count passed **40/40**, while qualifying-snapshot/applicability evidence remained blocked by the T-009B accounting outcome.

No sampled content was opened during hard-stop propagation. No lifecycle subprocess, benchmark, scorer, summary generation, paid replay, or additional provider call was performed.

## Decision trace

| Gate | Status | Reason |
|---|---|---|
| G-001 Quality | Unavailable | Qualification and paired scoring were not authorized after the accounting blocker |
| G-002 Net utility | Blocked | Complete attributable native-compaction and following-main usage was unavailable |
| G-003 Applicability | Blocked | The sample-count prerequisite passed 40/40, but qualification and qualifying-snapshot evidence were intentionally not performed after the accounting blocker |
| G-004 Feasibility | Unavailable | Lifecycle/provenance/performance execution was intentionally not performed |
| REVISE bands | Unavailable | A bounded near-miss requires otherwise complete evidence; that condition was not met |
| Outcome | **NO-GO** | At least one required gate is blocked and the result cannot satisfy `GO` or `REVISE` |

## Aggregate candidate

All metric buckets are suppressed because there are no applicable qualifying snapshots:

- Quality: suppressed
- Utility: suppressed
- Applicability: suppressed
- Feasibility: suppressed
- Lifecycle: suppressed

Retained diagnostics contain skip categories only. There are no committed per-session, per-repository, per-request, prompt, output, tool-payload, path, or local-mapping records.

## Failures, exclusions, and retries

- The accounting proof retained its terminal ambiguity instead of estimating missing usage.
- All downstream stages were explicitly recorded as authenticated `not-applicable` dispositions.
- No downstream retry or extension was authorized.
- No favorable range, snapshot, repository, or replicate was substituted.

## Limitations

- Aggregate subgroups backed by fewer than five independent snapshots are suppressed; replicates never increase that count.
- Repository clustering may limit independence and generalizability.
- Cache effects are not inferred away; cache isolation was unavailable for downstream evaluation because replay did not run.
- The hard stop establishes that this protocol cannot support a runtime pilot with the available accounting surface. It does not establish that selective compression is intrinsically ineffective.

## Integrity and privacy

The terminal chain re-authenticated the immutable target and verified T-009B resolution, then HMAC-bound each content-free downstream disposition to the same private run. Terminal verification authenticates the complete chain, decision, immutable primary local/aggregate reports, and the append-only canonical supplement bound to the verified inventory and sample.

The committed report contains aggregate protocol facts only. Private evidence artifacts remain outside the repository; cleanup is optional and confirmation-gated.
