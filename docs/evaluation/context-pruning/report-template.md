# Context-Pruning Evaluation Report Template

> Content-free template. Do not include session IDs, repository paths, prompts, raw content, local identifiers, secrets, or mappings.

## 1. Decision

- **Outcome:** `GO` | `REVISE` | `NO-GO`
- **Decision trace:**
- **Locked artifact digests:** sampling; target selection; evaluation; rubric; pricing; gold; fixture; bootstrap; report policy.

## 2. Protocol and corpus summary

- Sampling-lock and target-selection validation status:
- Collection-window and refresh disposition:
- Frame count, first-40 sample count, and exclusions by coarse reason:
- Qualifying independent snapshots and suppressed aggregate note (`n < 5`):
- Exact target tuple and provider-policy confirmation status:

## 3. Quality (G-001)

- Equal-weight fact/constraint recall: native; selective; delta.
- Completion comparison and objective-check availability:
- Blinded-rubric summary where objective checks are unavailable:
- Severe safety events by arm and treatment-only regression result:
- Deterministic snapshot-cluster bootstrap interval (10,000 resamples; nearest-rank 2.5%/97.5%):

## 4. Utility (G-002)

- Median `reduction5` using actual frozen-price cost:
- Break-even by checkpoint-five count/rate; non-break-even recorded as `>5`:
- Native/selective cost channels, including summary, carrier, recurring metadata, retries, failures, cache, and native compaction:
- Input-token reduction and gross-context reduction, clearly non-substituting:
- Missing-usage or compaction-accounting limitations:

## 5. Applicability (G-003)

- First-40 qualifying count and percentage:
- Gate result (`>=10/40` and `>=25%`):

## 6. Feasibility (G-004)

- Lifecycle scenario/version matrix:
- Complete-range provenance coverage and false-positive count:
- Source-mutation check:
- Per-fixture latency: p50, p95, maximum; maximum absolute p95 gate (`<25 ms`):

## 7. Limitations and retained failures

- Exclusions, failures, retries, incomplete evidence, and extensions:
- Privacy suppression and aggregate-only disclosure review:
- Reproducibility inputs and canonical digest verification:

## 8. Recommendation

Record exactly one decision under the frozen GO/REVISE/NO-GO partition. A GO authorizes only a separate subsequent design decision; REVISE requires a revised hypothesis and rerun; NO-GO retains the aggregate evidence and prevents unsupported repetition.
