# Pricing Card Contract

## Purpose

This unpopulated, content-free card contract is frozen by digest before replay. It records a pricing snapshot used only to calculate actual provider-equivalent cost; it contains no credentials, prompts, raw content, local identifiers, or session data.

## Required card fields

| Field | Contract |
|---|---|
| `schemaVersion` | Version of the price-card schema. |
| `effectiveAt` | ISO UTC instant for the recorded pricing snapshot. |
| `provider` | Exact provider identifier. |
| `model` | Exact model identifier. |
| `api` | Exact API identifier. |
| `currency` | Billing currency. |
| `input` | Unit, price, and denominator for actual input usage. |
| `output` | Unit, price, and denominator for actual output usage. |
| `cacheRead` | Unit, price, and denominator, or an explicit unavailable state. |
| `cacheWrite` | Unit, price, and denominator, or an explicit unavailable state. |
| `nativeCompaction` | Actual attributable usage/cost source, or a blocking-incomplete state. |
| `source` | Stable pricing-source reference and retrieval timestamp. |
| `digest` | Lowercase SHA-256 of canonical card content excluding this field. |

## Accounting rules

Use actual reported input, output, and cache usage with this frozen card. Selective cumulative cost includes summary generation, transformed main requests, summary-carrier overhead, recurring prompt/tool metadata, retries, and failed billed calls. Native cumulative cost includes equivalent main requests and actual native-compaction cost.

At checkpoint five, calculate:

```text
nativeCost5    = mean(native cumulative cost through checkpoint 5)
selectiveCost5 = mean(selective cumulative cost through checkpoint 5)
reduction5     = (nativeCost5 - selectiveCost5) / nativeCost5
```

The utility pass requires median equal-weight `reduction5 >= 10%` and at least half of qualifying snapshots breaking even by checkpoint five. Input-token and gross-context reduction are reported separately and cannot replace cost. Missing actual usage or incomplete applicable native-compaction accounting cannot support a utility GO.
