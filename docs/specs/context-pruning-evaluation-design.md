# Dynamic Context Pruning Phase 1 — Evaluation Design

| Field | Value |
|---|---|
| Status | Active |
| Owner | invoker |
| Source PRD | [`context-pruning.md`](context-pruning.md) |
| Applied change | [`../plans/context-pruning-change-001-evidence-readiness.md`](../plans/context-pruning-change-001-evidence-readiness.md) |
| Related ADRs | None found in this repository; Phase 1 introduces no production architecture decision |
| Phase | Phase 1 MVP — Evidence Spike |
| Created | 2026-07-14 |

## 1. Boundaries

### This design owns

- A local-only, reproducible protocol for inventorying Pi sessions without exporting transcript
  content.
- Deterministic selection of the first 40 representative long parent sessions.
- Controlled qualification and annotation of one candidate segment per selected session.
- Paired native-versus-selective evaluation of quality, safety, usage, cost, and break-even.
- A non-shipping lifecycle prototype for provenance feasibility and performance measurement.
- Mechanical calculation of the PRD's `GO`, `REVISE`, or `NO-GO` decision.
- Local evidence storage, privacy controls, integrity verification, cleanup, and redacted reporting.

### This design does not own

- Production context transformation, a `compress` tool, runtime hooks, commands, configuration, or
  status UI.
- Pi's session format, provider accounting, model behavior, native compaction policy, or repository
  test semantics.
- The runtime pilot architecture that may be designed only after an evidence `GO` decision.
- Automatic interpretation of ambiguous conversation content. Ambiguity is excluded or adjudicated.
- Uploading session content, repository fixtures, prompts, or evaluation answers to a new external
  service.

### Existing evidence

A metadata-only scan on 2026-07-14 found:

- 351 session JSONL files under `$PI_AGENT_DIR/sessions` (~247 MB);
- 351 valid session headers and zero malformed JSONL lines;
- 47,049 total entries, including 44,594 message entries and 103 compaction entries;
- 18,566 assistant usage records with input, output, cache-read, cache-write, total-token, and cost
  structures; and
- 52 session files containing at least one compaction entry.

This establishes a viable discovery population, not that 40 sessions qualify. No prompt, tool
argument, tool result, summary, path, or transcript content was emitted by the scan.

## 2. Architecture

Phase 1 is isolated from the package runtime:

```text
$PI_AGENT_DIR/sessions (read-only)
              │
              ▼
┌──────────────────────────────┐
│ Metadata inventory reader    │  pass A: structural fields only
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Deterministic sampler        │  frozen frame + seed → first 40
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Qualification workspace      │  pass B: selected files only,
│ + annotation adjudication    │  raw content remains local
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Snapshot + protocol freezer  │  hashes target, rubric, fixtures,
│                              │  pricing, ranges, and gold ledger
└─────────┬────────────┬───────┘
          │            │
          ▼            ▼
┌────────────────┐  ┌─────────────────────┐
│ Paired replay  │  │ Lifecycle prototype │
│ native/select. │  │ Pi 0.74 + pinned    │
└───────┬────────┘  │ current version      │
        │           └──────────┬──────────┘
        └──────────┬───────────┘
                   ▼
┌──────────────────────────────┐
│ Scoring + cost ledger        │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Mechanical decision engine   │
└──────────────┬───────────────┘
               ▼
 local evidence root + allowlisted redacted aggregate report
```

### 2.1 Repository placement

```text
scripts/context-pruning/
├── cli.ts
├── types.ts
├── canonical-json.ts
├── inventory.ts
├── sampling.ts
├── qualification.ts
├── snapshots.ts
├── replay.ts
├── scoring.ts
├── cost.ts
├── decision.ts
├── evidence-store.ts
├── export-redacted.ts
├── lifecycle/
│   ├── extension.ts
│   ├── runner.ts
│   └── scenarios.ts
└── __tests__/

docs/evaluation/context-pruning/
├── protocol-v1.md
├── rubric-v1.md
├── report-template.md
├── pricing/
└── reports/

tsconfig.evaluation.json
```

The evaluation modules remain under `scripts/`, outside `src/index.ts`, the production bundle, and
normal extension registration. `tsconfig.evaluation.json` provides strict no-emit type checking for
the harness. The package's normal typecheck includes both the production and evaluation configs, and
standard test discovery includes only hermetic evidence tests. Cross-version lifecycle subprocesses,
performance benchmarks, and provider calls use separate opt-in commands and never run in ordinary
`bun run test` or package installation.

### 2.2 Local evidence root

All content-bearing or session-identifying artifacts stay outside the repository:

```text
$PI_AGENT_DIR/blackbytes/evaluations/context-pruning/<run-id>/
├── sampling.lock.json
├── target-selection.json
├── evaluation.lock.json
├── corpus.key
├── corpus-map.json
├── inventory.jsonl
├── sample.json
├── qualifications.jsonl
├── annotations.jsonl
├── snapshots/
├── gold/
├── repository-fixtures/
├── runs/events.jsonl
├── scores.jsonl
├── lifecycle.jsonl
├── benchmarks.jsonl
├── cleanup-manifest.json
└── report.{json,md}
```

Directories use mode `0700`; files use `0600`. The source session directory is never included in a
cleanup manifest and is opened read-only.

## 3. Corpus and Sampling Protocol

### 3.1 Two-pass access model

**Pass A — metadata inventory** streams every JSONL line but retains only allowlisted structural
fields:

- HMAC-pseudonymized session and repository identifiers;
- keyed file digest, byte size, mtime, session version, and timestamps;
- entry-type, role, request, branch, and compaction counts;
- provider/model/reasoning spans;
- numeric assistant usage and cost vectors;
- parse status and missing-field flags.

Pass A must immediately discard `cwd`, message content, tool arguments/results, compaction summaries,
labels, custom-entry data, and diagnostics text. `redactSecrets()` is defense in depth, not the
primary privacy boundary.

**Pass B — qualification** may read raw content only for the frozen 40-session sample. Content is
available only to the local curator/annotator and is never copied into committed artifacts. Pass B
writes entry IDs, digests, boolean criteria, closure reason codes, and scores—not transcript text.

### 3.2 Sampling frame

The sampling lock freezes `longSessionMinRequests = 20` before inventory selection. This value
operationalizes “long” as repeated agentic interaction while remaining independent of pressure,
compaction, content, outcome, and candidate-range size. A session enters the long-session sampling
frame when:

1. the JSONL is structurally valid enough to reconstruct one final active branch;
2. it contains at least `longSessionMinRequests` assistant provider responses with usage records on
   that branch;
3. it is a persisted parent session or a Pi fork/clone, not a known worker session; and
4. it has not already appeared through the same session-lineage root.

Branch reconstruction builds child counts for all entries, identifies terminal leaves, and selects
the terminal leaf with the greatest original JSONL line index; an entry-ID lexical comparison is the
stable tie-breaker. The final branch follows `parentId` from that leaf. A multi-leaf golden fixture
covers tree navigation, and each selected file is loaded from a copy through the pinned Pi session
manager before qualification; a mismatch with Pi's resolved leaf stops that record rather than
silently choosing another branch. Segments on abandoned branches are intentionally excluded.

`parentSession` identifies fork/clone lineage and does not by itself indicate a nested worker.
Blackbytes workers use no-session mode and therefore should not create these files; uncertain external
worker sessions are marked `unknown` and excluded with a visible reason.

The frame does **not** filter on context pressure, compaction, candidate quality, repository topic,
future-request count, or apparent task success. Those are post-selection outcomes. This prevents
inflating the PRD applicability rate.

### 3.3 Deterministic selection

A local corpus key pseudonymizes records:

```text
corpusId     = HMAC-SHA256(corpusKey, canonicalPath || sessionHeaderId)
sourceDigest = HMAC-SHA256(corpusKey, rawFileBytes)
inventoryId  = SHA256(canonicalJSON(sorted inventory records))
selectionKey = SHA256(protocolSeed || inventoryId || corpusId)
```

Before the first formal inventory, immutable `sampling.lock.json` fixes `protocolSeed`,
`longSessionMinRequests`, an ISO `collectionWindowEndsAt`, `maxInventoryRefreshes`, the frozen
model-registry digest, and `estimatorPolicyDigest` so qualification policy is locked before first use.
Sort the eligible frame by `selectionKey`; take the first 40 without replacement. Number the initial
inventory attempt `0`; `maxInventoryRefreshes` permits that many additional attempts, so total attempts
are at most `1 + maxInventoryRefreshes`. If an attempt contains fewer than 40 eligible sessions, freeze
no partial sample. Emit nonterminal `underflow-pending` only when the attempt index is below
`maxInventoryRefreshes` **and** current time is before `collectionWindowEndsAt`; the owner may later
repeat `inventory` → `sample` without changing the sampling lock. Emit terminal `underflow-hard-stop`
when either limit is reached. Once an attempt contains at least 40 sessions, freeze that inventory
digest and sample. A pending attempt never authorizes target selection or downstream work, and the
bead remains open; terminal underflow makes required evidence unavailable and the decision `NO-GO`.
The selection is never redrawn for model, repository, compaction, qualification, or outcome balance.
Aggregate frame-versus-sample distributions are reported using pseudonyms and coarse buckets only.

After inventory and sample freeze but before the compaction proof or any Pass B content qualification,
the owner selects the primary provider/model/API/reasoning tuple. Immutable `target-selection.json`
records that tuple plus the sampling-lock, inventory, and sample digests and the provider-specific
compaction/replay policy digest (one-retry maximum, retryable-error classes, timeout values, and
confirmation policy). The later `evaluation.lock.json` is created only at protocol freeze after
qualification and compaction-accounting resolution; it references the predecessor-bound estimator and
provider-policy values plus rubric, pricing, gold, fixture, bootstrap, and report-policy digests. None
of the three artifacts is rewritten. Changing any locked value requires a new run ID.

A secondary, non-decision sensitivity table reports frame and applicability counts at request
thresholds 10, 15, 20, and 25; it never changes the locked primary sample. Repository-pseudonym
concentration is also reported. The primary analysis does not add a post-hoc repository cap, but
quality and cost uncertainty are resampled by session and reported with repository clustering as a
limitation when one repository dominates.

Unreadable, partial, duplicate-lineage, and unknown-parent records remain in inventory counts with
exclusion reasons.

## 4. Qualification and Candidate Selection

Each of the 40 sampled sessions contributes at most one independent evaluation snapshot. A session
qualifies only when one branch contains all four PRD criteria:

1. eligible parent session;
2. at least one recorded context point at or above 70%, or a native compaction;
3. a completed contiguous segment with at least 2,048 estimated removable tokens; and
4. at least five subsequent main-agent provider requests after closure.

### 4.1 Context pressure

Prefer recorded `usage.contextPercent`. Otherwise divide `usage.totalTokens` by the context-window
value in the frozen model registry snapshot. If `totalTokens` is absent, sum input, output,
cache-read, and cache-write according to the frozen protocol. Missing model-window data fails the
criterion rather than guessing.

### 4.2 Complete segment

A candidate segment must:

- contain complete user-to-assistant/tool turns;
- contain no unmatched tool call;
- stay within one branch and one native-compaction epoch;
- be followed by a new goal or topic; and
- have closure evidence stronger than assistant self-assertion.

Allowed closure evidence codes are `user-accepted`, `goal-transition`, and
`verification-passed`. A verification code requires a recorded objective tool result. Ambiguous
closure is excluded.

Gross removable size uses this frozen qualification-only estimator:

```text
canonicalModelVisibleCandidateContent = canonicalJSON(ordered model-visible role/content/tool-call/tool-result payloads)
estimatedTokens = ceil(UTF8ByteLength(canonicalModelVisibleCandidateContent) / 4)
```

IDs, timestamps, usage metadata, and fields not sent to the model are excluded. The result is used
only for the 2,048-token qualification boundary and is never presented as actual, billed, removed, or
saved tokens.

Two independent annotations are preferred. At least one annotator must be the human owner; a second
human or consented blinded model may be used. Disagreement is adjudicated before summaries, replay
outputs, costs, gold answers, or gate outcomes are visible. If multiple ranges qualify, select the
earliest closing range, then earliest start as tie-breaker.

## 5. Snapshot and Leakage Controls

For every qualifying session, freeze exactly one primary snapshot containing only references and
digests for:

- selected branch and candidate range;
- closure point and the first five subsequent request checkpoints;
- exact target provider, model, API, and reasoning settings;
- native context at each checkpoint;
- system-prompt and tool-schema versions;
- repository fixture status;
- atomic gold fact/constraint ledger; and
- scoring rubric and hidden objective checks.

The primary target tuple is selected after metadata inventory but before content qualification and is
not changed after results are visible.

### 5.1 Role separation

| Role | May access | Must not access |
|---|---|---|
| Curator | Selected raw session, range, future history | Replay outputs and cost results |
| Summary generator | Candidate source range and frozen summary instruction | Future checkpoints, gold ledger, probes, baseline answers |
| Replay runner | Locked snapshots and opaque arm labels | Gold answers and decision outcomes |
| Scorer | Randomized outputs and answer key | Arm identity, cost, summary, run order |
| Decision engine | Locked aggregate scores and costs | Raw conversation and repository content |

Protocol, sampling manifest, annotations, target tuple, price snapshot, rubric, gold ledger, and
repository fixture digests are locked before the first paid replay. Calibration uses synthetic or
predeclared non-sampled holdouts only.

## 6. Paired Evaluation

Each snapshot has native and selective conditions with the same exact target tuple, system prompt,
tool schemas, repository state, checkpoint question, and request budget. Each condition always runs
at least three times in Phase 1; no determinism exception reduces replication. Arm order is derived
from the protocol seed and balanced across `AB`/`BA` blocks. All failures, retries, and billed calls
remain in the ledger.

Each selective replicate generates its own summary from the selected range without future context or
gold answers. The full generation cost is charged to that replicate. The resulting utility claim
applies only to this narrow intervention; adding a future selection tool, recurring prompt, or other
runtime overhead requires rerunning the cost gate.

### 6.1 Teacher-forced checkpoint replay

This is the primary causal comparison. At each of the five original subsequent checkpoints, restore
the original intervening history. The two arms differ only in representation of the candidate range.
Generated output is scored but is not fed into the next checkpoint. This isolates context effects and
makes cumulative usage comparable.

### 6.2 Sandboxed continuation

Where a historical repository fixture is available, start each arm from the same closure snapshot in
separate disposable worktrees or copied trees. Permit identical tools and request limits, then run
hidden objective checks. Never execute against the user's original repository.

Repository fixtures are classified as:

- `exact`: frozen commit plus complete tracked/untracked worktree archive;
- `reconstructed`: commit plus reconstructed patch with an explicit reconstruction log; or
- `unavailable`: no objective execution; quality uses recall and the blinded rubric only.

Unavailability is reported and never used to remove an otherwise qualifying session.

## 7. Scoring and Decision Model

### 7.1 Quality and recall

Gold facts are atomic, source-provenanced, and categorized as goal, hard constraint, decision and
rationale, repository state, unresolved work, current authorization, or revoked authorization. A fact
already restated outside the candidate range is marked non-diagnostic for that checkpoint.

Fact scoring is fixed before replay:

| Result | Score |
|---|---:|
| Correct | 1.0 |
| Partial | 0.5 |
| Omitted | 0.0 |
| Incorrect or contradicted | 0.0 plus contradiction flag |

Each snapshot is weighted equally. The primary recall delta is treatment mean minus native mean
across snapshot-level means. G-001 passes only when recall delta is at least `-0.05`, task completion
is not below baseline, and no treatment-only severe safety event occurs.

Per-snapshot replicate variance and a deterministic snapshot-cluster bootstrap interval are reported
as uncertainty evidence. Derive
`bootstrapSeed = SHA256(UTF8(canonicalJSON({ domain: "snapshot-cluster-bootstrap-v1", protocolSeed,
sampleDigest: lowercaseHex(sampleDigest) })))`. Perform exactly 10,000 resamples of `n` snapshots with
replacement, where each sampled snapshot carries all arm/replicate records.

For zero-based resample `r`, draw `j`, and rejection counter `k`, hash
`bootstrapSeedBytes || UTF8("draw-v1") || uint32BE(r) || uint32BE(j) || uint32BE(k)`. Interpret the
digest as unsigned big-endian 256-bit `u`; set `limit = 2^256 - (2^256 mod n)`; accept `u mod n` when
`u < limit`, otherwise increment `k`. Recompute the equal-weight metric per resample and report
nearest-rank 2.5th/97.5th percentiles (ranks 250 and 9,750 for 10,000 values).

A required golden uses `protocolSeed="test-seed"`, 32 zero bytes as lowercase-hex `sampleDigest`, and
`n=3`: bootstrap seed is `5d4900fcf8455dfd03be5ce5fd8fc60491968844779b94db3b4409203af4f7f7`
and the first four flattened resamples are `[0,0,1, 2,2,2, 0,2,1, 1,0,0]`. The PRD's fixed point
thresholds remain authoritative; confidence intervals cannot turn a failed point estimate into a
pass. Results within two percentage points of a threshold are flagged as fragile.

A severe event includes stale/revoked authorization use, destructive action outside scope,
fabricated completion of required verification, or exposure of secret/private corpus content.
Baseline events remain reported but do not excuse treatment regressions. Arm-level severe-event rates
are also reported; a higher treatment rate is flagged as a safety regression even when both arms
contain an event.

### 7.2 Usage and provider-equivalent cost

Every provider call produces an append-only usage event with:

- snapshot, replicate, condition, checkpoint, and request origin;
- actual input, output, reasoning, cache-read, cache-write, and reported total;
- actual provider cost channels and total when present;
- frozen price-card ID and source digest;
- retry relationship and cache-isolation status; and
- `actual` or `missing` completeness status.

The preferred cost is the provider-reported `usage.cost.total`. A frozen price card recomputes cost
from actual usage channels as a cross-check and supports providers that report usage but not cost.
Estimated usage cannot satisfy G-002.

Selective cumulative cost includes summary generation, every transformed main request, summary
carrier overhead, any recurring prompt/tool metadata used by the evaluated intervention, retries,
and failed billed calls. Native cumulative cost includes equivalent main requests and any native
compaction cost.

After sample freeze and target selection but before content qualification, a blocking
compaction-accounting spike determines whether actual native-compaction generation usage can be
captured. A dry structural pass reports how many sampled five-request horizons contain compaction.
When applicable, the proof outcome has exactly two machine-readable states: `complete` when actual
usage is attributable and verified, or `blocking-incomplete` when the owner declines, evidence is
missing/merged/ambiguous, or verification fails. Separately, the stage disposition is `not-applicable`
only when a verified upstream hard-stop prevents creating a proof artifact. `blocking-incomplete`
permits an extension proposal but cannot authorize content qualification or paid replay in the current
run; no usage is estimated. If any sampled horizon contains compaction and accounting is not
`complete`, utility cannot produce `GO`.

Until accounting is `complete`, every ordinary provider-backed annotation or replay command is
blocked. The sole provider exception is the explicitly confirmed, generated-only
`compaction-accounting` proof whose purpose is to establish that state; it uses the already locked
target/provider policy and no real transcript content.

Every planned provider request, including that proof, permits at most one retry after a retryable
failure. Both arms use the same frozen retryable-error classification and timeout
policy; all failed and retried billed attempts remain in the ledger. Confirmation upper cost assumes
every planned request consumes its one allowed retry plus all summary-generation calls.

For each snapshot, the decision metric is fixed at the end of the fifth subsequent checkpoint:

```text
nativeCost5    = mean(native cumulative cost through checkpoint 5)
selectiveCost5 = mean(selective cumulative cost through checkpoint 5)
reduction5     = (nativeCost5 - selectiveCost5) / nativeCost5
```

G-002 passes only when the median of equal-weight `reduction5` values is at least 10% and at least
half of qualifying snapshots break even by checkpoint five. A median from 5% up to but not including
10% is eligible for the PRD's utility `REVISE` band only when the break-even condition and every other
gate pass. A snapshot breaks even at the first checkpoint where selective cumulative cost is no
greater than native cumulative cost; otherwise it is recorded `>5`. Input-token reduction is
reported separately and never substitutes for cost.

### 7.3 Mechanical decision

The decision engine implements the Accepted PRD literally:

- `GO`: all four gates pass;
- `REVISE`: G-001 and all other measurable gates pass while exactly one deviation total applies—one
  allowed utility/feasibility near-miss or one permitted missing-data extension, never both; and
- `NO-GO`: every other failure.

The engine validates artifact hashes, emits one outcome, and includes a decision trace showing every
threshold input. It cannot accept an operator-supplied decision override.

## 8. Lifecycle Feasibility Prototype

A test-only shadow extension under `scripts/context-pruning/lifecycle/` may observe ephemeral child Pi
sessions but must:

- never be imported by `src/index.ts`;
- register no public tool or command;
- return the original context unchanged;
- append no session entry;
- operate only on copied sessions or generated fixtures; and
- write only to the local evidence root.

The matrix runs against exact Pi `0.74.0` and a separately installed, protocol-pinned current version
(the currently observed global candidate is `0.80.6`; its package integrity and binary digest are
locked at protocol freeze).

Scenarios cover reload, native compaction, branch/fork/tree navigation, steering/follow-up, duplicate
messages, sequential tool calls, and both load orders with a synthetic second context transformer.

Positive provenance claims contain only context index, source entry ID, and method. Ambiguous or
transformer-created messages remain unowned. Ground truth comes from the copied real-session branch
before a controlled synthetic transform. Reports call this “real-session-derived synthetic ground
truth,” not naturally observed production provenance. Any false-positive owner or complete-turn
boundary is a feasibility failure.

Each required lifecycle scenario containing ground-truth-ownable messages predeclares at least one
complete-turn candidate range whose qualification estimate is at least 2,048 tokens. The scenario
passes the coverage boundary only when every model-visible message in at least one such range is
correctly owned and bounded, while retaining zero false-positive ownership/boundary claims. Message-
and turn-level coverage are still reported; a zero-claim or partial-range result cannot pass.

### 8.1 Performance protocol

For each fixture and Pi version:

- use an isolated process;
- include the largest selected session as a mandatory fixture;
- run at least 100 warmups and 1,000 measured invocations;
- measure handler entry through completed shadow computation;
- report cold start separately;
- compute nearest-rank p50, p95, and maximum; and
- report absolute handler latency and no-op-adjusted overhead.

The gate uses the maximum per-fixture absolute p95 across both versions, not a pooled percentile, and
must remain below 25 ms. Standard hermetic tests validate parameterized runner behavior, largest-
fixture selection, warmups, nearest-rank percentiles, and installation checks using generated fixtures
and mocked installation metadata. Only the opt-in lifecycle evidence matrix runs the owner-pinned real
installations and the actual largest selected copied session.

## 9. Data Model

All records are versioned JSON/JSONL. No database or migration is introduced.

### 9.1 Core entities

| Entity | Cardinality | Purpose |
|---|---:|---|
| `SamplingProtocolLock` | one immutable record per run before inventory | Seed, frame/window limits, model-registry digest, and estimator-policy digest |
| `TargetSelectionRecord` | one immutable record per viable sample before proof/Pass B | Primary target tuple, predecessor digests, and provider retry/error/timeout/confirmation-policy digest |
| `EvaluationProtocolLock` | one immutable record per continuing run before replay | Predecessor-bound policies plus rubric, pricing, gold, fixture, bootstrap, and report policies |
| `InventoryRecord` | one per discovered file | Content-free structure, usage completeness, and exclusions |
| `SampleManifest` | one per run | Frozen frame digest, seed, ordered first 40, and distribution summary |
| `QualificationRecord` | one per sampled session | Four criteria, one selected range, annotation/adjudication status |
| `EvaluationSnapshot` | one per qualifying session | Immutable treatment boundary, checkpoints, target, fixture and gold digests |
| `RunEvent` | one per provider attempt | Arm, replicate, request, status, timings and output digest |
| `UsageEvent` | one per billed provider call | Actual usage/cost channels, origin, retry and completeness |
| `ScoreRecord` | one per scored output | Blinded quality, recall, completion and safety result |
| `LifecycleResult` | one per scenario/version | Claims, ground truth comparison, coverage and latency |
| `DecisionReport` | one per run | Gate inputs, pass/fail, outcome, limitations and artifact hashes |

### 9.2 Selected interfaces

```ts
interface InventoryRecord {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly sourceDigest: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly sessionVersion?: number;
  readonly parentStatus: "parent" | "fork" | "unknown";
  readonly parseStatus: "valid" | "partial" | "unreadable";
  readonly entryCounts: Readonly<Record<string, number>>;
  readonly requestCount: number;
  readonly branchCount: number;
  readonly usageCompleteness: number;
  readonly maxContextRatio?: number;
  readonly compactionCount: number;
  readonly exclusionReasons: readonly string[];
}

interface QualificationRecord {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly selectedRank: number;
  readonly qualifies: boolean;
  readonly criteria: {
    readonly parent: boolean;
    readonly pressure: boolean;
    readonly completedSegment: boolean;
    readonly fiveSubsequentRequests: boolean;
  };
  readonly candidate?: {
    readonly branchLeafId: string;
    readonly startEntryId: string;
    readonly endEntryId: string;
    readonly closureEntryId: string;
    readonly closureEvidence: readonly (
      | "user-accepted"
      | "goal-transition"
      | "verification-passed"
    )[];
    readonly estimatedTokens: number;
    readonly subsequentRequestIds: readonly string[];
  };
  readonly annotatorIds: readonly string[];
  readonly adjudicationStatus: "not-needed" | "resolved" | "unresolved";
}

interface DecisionReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly evaluationProtocolDigest: string;
  readonly inventoryDigest: string;
  readonly sampleDigest: string;
  readonly pricingDigest: string;
  readonly environmentDigest: string;
  readonly gates: {
    readonly quality: GateResult;
    readonly utility: GateResult;
    readonly applicability: GateResult;
    readonly feasibility: GateResult;
  };
  readonly decision: "GO" | "REVISE" | "NO-GO";
  readonly decisionTrace: readonly string[];
}
```

Relationships use opaque IDs and digests. The committed aggregate report contains no `corpusId`,
entry ID, run output, path, or repository identifier.

## 10. CLI API

The harness is invoked explicitly as `bun run evidence:context-pruning -- <command> ...` and defaults
to no provider calls. T-001 freezes this package-script contract; all later operator instructions use
it rather than invoking TypeScript files directly:

| Command | Inputs | Output | External cost |
|---|---|---|---|
| `init` | run ID, seed, threshold, window, refresh limit, model registry | immutable sampling lock and private run root | None |
| `inventory` | source root, run ID | content-free local inventory and aggregate summary | None |
| `sample` | run ID, sampling-lock digest | immutable first-40 sample manifest | None |
| `select-target` | run ID, exact provider/model/API/reasoning tuple | immutable target-selection record | None |
| `qualify` | run ID, local annotation file, rank range | qualification records and unresolved disagreements | None unless consented annotation model is configured |
| `adjudicate` | run ID, local adjudication file | resolved qualification records or qualification hard-stop | None |
| `freeze` | run ID, rubric, price card, gold and fixture manifests | evaluation lock and artifact digests | None |
| `replay` | run ID, explicit cost confirmation | append-only run and usage events | Yes |
| `score` | run ID, blinded scorer records | score/cost records and uncertainty evidence | None unless a consented scorer model is configured |
| `lifecycle` | run ID, pinned Pi installations | lifecycle and benchmark results | None unless scenarios invoke a provider |
| `decide` | run ID | one mechanical decision plus threshold trace | None |
| `report` | run ID | local detailed report plus committed-safe aggregate candidate | None |
| `verify` | run ID | hash, schema, source-integrity and decision checks | None |
| `cleanup` | run ID and explicit confirmation | deletes only manifest-listed local artifacts | None |

Every external-cost command first runs with `--dry-run` and emits a plan/confirmation digest. The
operator then supplies exactly one of `--confirm <plan-digest>` or `--decline <plan-digest>`; decline
writes the applicable `blocking-incomplete` record and invokes no external adapter. Any stage command
may use `--not-applicable <upstream-hard-stop-digest>` only after verifying that upstream record; it
writes a hashed stage-disposition record and performs no content or external access. `replay` and any
provider-backed annotation otherwise refuse to run without confirmation showing the exact target,
planned base/summary/retry call count, and upper cost. `cleanup` refuses paths outside the canonical
run root and never accepts glob patterns.

Errors are emitted as structured JSON to stderr:

```ts
interface EvidenceError {
  readonly code:
    | "E_EVAL_CONFIG"
    | "E_EVAL_PRIVACY"
    | "E_EVAL_INTEGRITY"
    | "E_EVAL_SCHEMA"
    | "E_EVAL_INCOMPLETE"
    | "E_EVAL_PROVIDER"
    | "E_EVAL_UNSAFE_PATH";
  readonly message: string;
  readonly recordId?: string;
}
```

Commands use a non-zero exit code on error and never silently estimate missing evidence.

## 11. Integrations and Events

- **Pi session JSONL**: read-only source; parser supports observed entry types and preserves unknown
  types as structural counts.
- **Pi 0.74.0 and pinned current Pi**: isolated lifecycle subprocesses only.
- **Configured model provider**: paired replay and optional second annotation; no new credentials or
  provider integration.
- **Repository checks**: optional, executed only in disposable fixtures.
- **Blackbytes runtime**: no event handlers, tools, config, state, or package entry point changes.

No background event bus, database, scheduled job, or external evaluation service is introduced.

## 12. Security and Privacy

- Inventory/export uses an allowlist; regex secret redaction is defense in depth.
- Raw transcript, prompts, summaries, answers, tool payloads, local mappings, and repository fixtures
  remain in the local evidence root and are never committed.
- The local corpus key is generated with cryptographic randomness and never included in reports.
- Source sessions are opened read-only and their keyed digests are checked before and after the run.
- Reports contain aggregate buckets only; any subgroup/bucket backed by fewer than five independent
  sessions or snapshots (`n < 5`) is suppressed to reduce re-identification. Replicates do not increase
  this privacy count.
- Provider-backed annotation/replay sends only the minimum frozen snapshot required by the protocol
  through the user's existing provider configuration and requires explicit confirmation.
- Local directories/files use `0700`/`0600` permissions.
- Cleanup is run-ID scoped, canonical-path checked, manifest-driven, and confirmation-gated.
- Logs pass through `redactSecrets()` but never intentionally include content-bearing fields.

Authentication and authorization are not applicable because there is no service API. Filesystem
access follows the invoking user's permissions; no privilege escalation is attempted.

## 13. Reliability, Caching, and Jobs

- Every stage is resumable from append-only, schema-versioned records.
- Writes use temporary files plus atomic rename for snapshots/manifests and append-only JSONL for run
  events.
- Canonical JSON and SHA-256 hashes detect protocol, fixture, price, and result drift.
- Source-session before/after digests prove non-modification.
- Unknown fields are tolerated; missing required evidence is explicit and can block a gate.
- Paid requests allow at most one retry after the same frozen retryable-error classification and
  timeout policy for both arms; every failed/retried billed attempt is retained in cost accounting.
- Provider cache isolation is recorded. If isolation is unavailable, balanced arm ordering and the
  limitation are reported; cache effects are never inferred away.
- No persistent cache is shared between evaluation runs.
- No scheduled or background jobs exist. Every action is an explicit CLI invocation.

## 14. Sequence Diagrams

### 14.1 Inventory and sample freeze

```text
Owner             CLI              Session files        Evidence store
  │ inventory      │                     │                     │
  │───────────────►│ stream read-only    │                     │
  │                │────────────────────►│                     │
  │                │ structural fields  │                     │
  │                │◄────────────────────│                     │
  │                │ HMAC + aggregate                         │
  │                │──────────────────────────────────────────►│
  │ sample         │                     │                     │
  │───────────────►│ verify inventory digest                  │
  │                │ deterministic rank → first 40            │
  │                │──────────────────────────────────────────►│
  │                │ sample digest + aggregate summary         │
  │◄───────────────│                     │                     │
```

### 14.2 Qualification, replay, and decision

```text
Curator          Qualifier        Evaluation lock     Replay/Scorer      Decision
  │ annotate 40      │                  │                   │                │
  │─────────────────►│                  │                   │                │
  │ resolve ambiguity│                  │                   │                │
  │◄────────────────►│                  │                   │                │
  │                  │ freeze refs/hashes                  │                │
  │                  │─────────────────►│                   │                │
  │ confirm paid run │                  │                   │                │
  │────────────────────────────────────────────────────────►│                │
  │                  │                  │ native/selective   │                │
  │                  │                  │ randomized repeats │                │
  │                  │                  │◄──────────────────►│                │
  │                  │                  │ scores + costs     │                │
  │                  │                  │───────────────────────────────────►│
  │                  │                  │ verify hashes + thresholds          │
  │                  │                  │◄───────────────────────────────────│
  │                  │                  │ GO / REVISE / NO-GO                 │
  │◄─────────────────────────────────────────────────────────────────────────│
```

Any hash mismatch, unresolved annotation, missing mandatory usage, source mutation, or privacy
violation stops the affected stage and preserves an error record; it cannot be converted to a pass.

## 15. Testing Strategy

Use `node:test` and `node:assert/strict` with temporary `$PI_AGENT_DIR` directories.

- **Unit tests**: canonical JSON/HMAC, parser field allowlist, frame eligibility, deterministic
  sampling, qualification boundaries, score formulas, cost channels, decision partitions, path
  safety, and aggregate suppression.
- **Golden tests**: sanitized synthetic Pi 0.74 and current-version JSONL fixtures covering messages,
  branches, compactions, unknown entries, partial lines, and usage variants.
- **Property tests**: same inventory + seed produces the same sample; no content-bearing input reaches
  inventory/report records; decision returns exactly one outcome for boundary combinations.
- **Integration tests**: full no-provider inventory → sample → qualify → freeze → synthetic replay →
  report pipeline; interrupted run resume; before/after source digest equality; cleanup confinement.
- **Hermetic lifecycle tests**: generated fixtures and mocked event/load-order logic; included in
  standard `bun run test`.
- **Opt-in lifecycle matrix**: real subprocesses across both pinned Pi installations; excluded from
  standard `bun run test` and ordinary CI.
- **Opt-in performance**: isolated benchmark with fixed warmup/measurement counts and nearest-rank
  percentile; excluded from standard `bun run test`.
- **Provider tests**: opt-in manual evidence runs only; excluded from standard `bun run test` and never
  required for package installation.
- **Project verification**: standard lint, build, package-size, strict production/evaluation typecheck,
  and hermetic production/evidence tests. The standard suite requires no second Pi install and makes
  no provider call.

Fixtures contain fabricated content only. Real session data is never copied into the test tree.

## 16. Phase 1 Scope Summary

### In Phase 1 MVP

- REQ-001 through REQ-010 from the Accepted evidence-first PRD.
- Content-free inventory and deterministic sample selection.
- Local qualification/annotation records.
- Paired teacher-forced replay and optional sandbox continuation.
- Quality, safety, cost, applicability, lifecycle, and performance evidence.
- Mechanical decision and redacted aggregate report.

### Deferred until an evidence `GO`

- All runtime compression behavior.
- Runtime Technical Design, configuration, tools, hooks, state, commands, and rollout.
- Automatic candidate selection or production summary generation.
- Product documentation or release claims about token savings.

## 17. Backward Compatibility, Migration, and Rollback

- **Preserved contracts**: all extension tools, commands, hooks, config, prompts, and sub-agent behavior
  remain unchanged.
- **Breaking changes**: none.
- **Schema migration**: none; evidence uses versioned local JSON/JSONL files.
- **Data backfill**: none.
- **Downtime**: none.
- **Rollback**: stop invoking the evidence CLI and remove its package-script entries. Local evidence
  remains inert until the owner explicitly runs manifest-scoped cleanup. Source sessions are never
  changed.
- **Failure containment**: no evaluation module is reachable from `src/index.ts`; build and package
  size remain independent of evidence code.

## 18. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| DQ-001 | Which exact provider/model/API/reasoning tuple is the primary evaluation target? | invoker | open — decide after metadata inventory, before qualification |
| DQ-002 | Which sampled repositories can provide exact or reconstructible historical fixtures and objective checks? | invoker | open |
| DQ-003 | Who or what serves as the independent second annotator and blinded scorer? | invoker | open |
| DQ-004 | Can native-compaction generation usage be captured completely in replay horizons? | invoker / Bytes | blocking — resolve before protocol freeze or paid replay |
| DQ-005 | Is global Pi 0.80.6 the version to pin as “current,” or should protocol freeze use a newer installed version? | invoker | open |
| DQ-006 | What license will govern distribution and clean-room documentation? | invoker | deferred; no effect on local Phase 1 evidence |

## 19. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-14 | Bytes | Created Draft Phase 1 Evaluation Design from the Accepted evidence-first PRD, metadata inventory, project patterns, and Pi lifecycle research. |
| 2026-07-14 | Bytes | Resolved design review findings: locked and sensitivity-tested the long-session threshold, validated branch reconstruction, fixed the cost horizon, made compaction accounting blocking, separated opt-in tests, required replication, and reported clustering/uncertainty. |
| 2026-07-14 | Bytes | Defined frame-underflow behavior (no partial sample; collect within a fixed window or `NO-GO`) and restated complete G-002 pass/near-miss thresholds. |
| 2026-07-14 | Bytes | Locked collection-window end and refresh count before formal inventory; constrained `REVISE` to exactly one total deviation. |
| 2026-07-14 | invoker | Activated the Phase 1 Evaluation Design after the design-ready gate passed. |
| 2026-07-14 | Bytes / invoker | Applied `context-pruning-change-001`: staged immutable locks, safe hard-stop sequencing, hermetic-versus-real lifecycle boundaries, and frozen estimator/bootstrap/privacy/retry/provenance contracts. |
| 2026-07-14 | Bytes | Polish pass 2 fixed pre-use policy ownership, specified the dependency-free bootstrap draw stream and golden vector, and separated proof outcomes from upstream `not-applicable` stage disposition. |
| 2026-07-14 | Bytes | Polish pass 3 defined the sole generated-proof provider exception and the bounded `underflow-pending`/`underflow-hard-stop` refresh state machine. |
