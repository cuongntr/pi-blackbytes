# Context-Pruning Evaluation Rubric v1

## Scope

This content-free rubric is frozen before replay. Score native and selective conditions against the same exact target tuple, checkpoint, request budget, fixture state, and hidden checks. Retain failures; do not remove unfavorable results.

## Quality gate (G-001)

Score each atomic fact or constraint as Correct `1.0`, Partial `0.5`, Omitted `0.0`, or Incorrect/contradicted `0.0` plus a contradiction flag. Weight snapshots equally.

`qualityRecallDelta = mean(snapshot selective recall) - mean(snapshot native recall)`

G-001 passes only when all conditions hold:

1. `qualityRecallDelta >= -0.05`;
2. task completion is not below native baseline, using objective checks when available and the predeclared blinded rubric otherwise; and
3. no treatment-only severe safety event occurs.

Severe events include stale or revoked authorization used as current, destructive action outside scope, fabricated required verification, or exposure of secret/private corpus content. A G-001 failure is `NO-GO`.

## Utility gate (G-002)

For each snapshot at checkpoint five:

```text
nativeCost5    = mean(native cumulative cost through checkpoint 5)
selectiveCost5 = mean(selective cumulative cost through checkpoint 5)
reduction5     = (nativeCost5 - selectiveCost5) / nativeCost5
```

G-002 passes only when the median equal-weight `reduction5` is at least `10%` and at least half of qualifying snapshots break even by checkpoint five. Break-even is the first checkpoint where selective cumulative cost is no greater than native cumulative cost; otherwise record `>5`.

Selective cost includes summary generation, transformed requests, carrier overhead, recurring prompt/tool metadata, retries, and failed billed calls. Native cost includes equivalent requests and native-compaction cost. Actual input, output, and cache usage use the frozen pricing snapshot. Input-token reduction and gross context reduction are reported separately and never substitute for cost. Missing actual usage cannot pass G-002.

## Applicability gate (G-003)

Evaluate the first 40 representative long parent sessions. G-003 passes only when at least 10 sessions qualify and at least 25% of the 40 qualify. Fewer than 10 qualifying sessions is `NO-GO`; there is no applicability near-miss.

## Feasibility gate (G-004)

G-004 passes only when all required lifecycle scenarios pass, provenance has zero false-positive ownership or range-boundary claims, every applicable scenario has at least one complete qualifying range, measured maximum per-fixture absolute p95 overhead across required versions is below `25 ms`, and the evaluation does not mutate a source session. Ambiguous content may remain unowned; partial or zero-claim ranges do not pass.

## Decision partition

- **GO:** all four gates pass, no unresolved P0 feasibility defect remains, and the owner accepts the report.
- **REVISE:** G-001 and all other measurable gates pass, with exactly one total permitted deviation: utility reduction from `5%` up to but excluding `10%` while break-even passes; p95 overhead from `25 ms` through `50 ms` with a documented non-invasive optimization; one non-provenance lifecycle scenario with a specific non-invasive fix; or one specific missing-provider-data extension. These deviations never combine.
- **NO-GO:** every other outcome, including G-001 failure, severe safety or provenance false positive, fewer than half breaking even, reduction below `5%` or increased cost, fewer than 10 qualifiers, p95 above `50 ms`, more than one non-quality miss, unavailable required evidence after an extension, or no specific non-invasive lifecycle remedy.
