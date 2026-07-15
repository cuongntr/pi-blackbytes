# Context-Pruning Evaluation Protocol v1

## Status and integrity

This is a content-free, immutable evaluation contract. Every record uses schema version 1, a run ID, canonical JSON, and a lowercase SHA-256 digest. A lock is never rewritten: any changed value requires a new run ID.

## Staged lock ownership

| Record | Creation point | Required binding |
|---|---|---|
| Sampling lock | Before the first inventory | Protocol seed; long-session minimum of exactly 20 requests; collection-window end; nonnegative inventory-refresh limit; model-registry digest; estimator-policy digest. |
| Target selection | After inventory and sample freeze; before compaction proof or Pass B | Exact non-empty provider, model, API, and reasoning tuple; sampling-lock, inventory, and sample digests; provider-policy digest. The policy binds one retry maximum, retryable error classes, timeouts, and confirmation policy. |
| Evaluation lock | After qualification and before replay | Sampling and target-selection identities/digests; predecessor inventory, sample, estimator, and provider-policy values; rubric, pricing, gold, fixture, bootstrap, and report-policy digests. |

Validation rejects unknown or missing fields, invalid stages, noncanonical digests, invalid collection times, predecessor mismatch, and same-run mutation.

## Two-pass access boundary

**Pass A — inventory and sampling:** inspect metadata only. Immediately discard message content, prompts, tool payloads, summaries, labels, and diagnostics. No target selection is permitted until an inventory and full sample are frozen.

**Pass B — qualification:** may access only the frozen sample and only locally. It emits references, digests, boolean criteria, reason codes, and scores; it never commits raw content. Target selection and its provider policy must already be locked before Pass B or the compaction proof.

## Frozen methods

- Qualification estimate: `ceil(UTF8 bytes of canonical model-visible candidate content / 4)`, only for the qualification boundary.
- Bootstrap: exactly 10,000 snapshot-cluster resamples. Seed with `SHA256(UTF8(canonicalJSON({domain: "snapshot-cluster-bootstrap-v1", protocolSeed, sampleDigest})))`; use SHA-256 counter/rejection draws with big-endian uint32 counters and unsigned 256-bit modulo mapping. Report nearest-rank 2.5% and 97.5% ranks 250 and 9750.
- Privacy: suppress every aggregate backed by fewer than five independent sessions or snapshots; replicates do not increase the count.
- Provider calls: permit at most one retry after a frozen retryable failure; retain failed and retried billed attempts.
- Replay schedule: `replicateCount` is an integer in `3..100`; the upper bound keeps provider-free plan construction hermetic and finite.
- Provenance: each applicable scenario requires one complete qualifying range with zero false-positive ownership or boundary claims.

No external-cost or evidence command is authorized by this template.
