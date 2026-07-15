# Dynamic Context Pruning — Evidence Spike Implementation Plan

| Field | Value |
|---|---|
| Status | Active |
| Owner | invoker |
| Source PRD | [`../specs/context-pruning.md`](../specs/context-pruning.md) |
| Source Technical Design | [`../specs/context-pruning-evaluation-design.md`](../specs/context-pruning-evaluation-design.md) |
| Related ADRs | None; this plan executes no new production architecture decision |
| Superseded runtime plan | [`context-pruning-implementation-plan.md`](context-pruning-implementation-plan.md) (deferred; do not implement) |
| Phase | Phase 1 MVP — Evidence Spike |

## 1. MVP-Lock

### In this phase

- **REQ-001**: representative local corpus and frozen first-40 sample.
- **REQ-002**: native-Pi baseline using actual structural usage/cost data.
- **REQ-003**: deterministic qualification and one candidate range per selected session.
- **REQ-004**: paired native/selective evaluation with at least three runs per arm.
- **REQ-005**: independent quality, recall, completion, and safety scoring.
- **REQ-006**: complete checkpoint-5 provider-equivalent cost and break-even accounting.
- **REQ-007**: non-shipping Pi lifecycle/provenance/performance feasibility evidence.
- **REQ-008**: reproducible aggregate decision report with exactly one outcome.
- **REQ-009**: local-only evidence, allowlisted exports, source integrity, and safe cleanup.
- **REQ-010**: no production registration/config behavior change and full project verification.

### Out of this phase

- Runtime `context` hooks, compression tools, reference injection, state persistence, commands,
  nudges, status UI, or rollout.
- Automatic production range selection or production summary generation.
- Reopening, polishing, or implementing the deferred runtime bead graph.
- Claims that selective compression is useful before the final evidence decision.
- New production dependencies or provider integrations.

### Exit criteria

Phase 1 is done when one of these paths completes:

1. **Full evidence path**: the first 40 sessions are frozen, at least 10 qualify, all paired/lifecycle
   evidence is collected, all four gates are evaluated, and the owner records `GO`, `REVISE`, or
   `NO-GO`.
2. **Verified hard-stop path**: a predeclared condition (frame underflow after the locked collection
   window, fewer than 10 qualifying sessions, mandatory usage unavailable after its permitted
   extension, privacy/integrity violation, or non-remediable lifecycle failure) is recorded with
   artifact hashes; unsafe/unnecessary downstream work is marked not applicable; the report records
   `NO-GO` or the one PRD-permitted `REVISE` outcome.

Both paths require:

- source session digests unchanged;
- no raw transcript or local identifier committed;
- standard project checks plus evaluation typecheck/hermetic tests passing;
- all exclusions, failures, retries, skipped stages, and limitations retained in the report; and
- the PRD/design revision history updated with the final decision.

Scope changes after this plan becomes `Active` require a delta-change artifact. A hard-stop does not
weaken acceptance criteria; it is an explicit evidence outcome.

## 2. Execution Rules

- Production files under `src/` may only be imported as existing pure helpers; Phase 1 must not add an
  import from `src/index.ts`, `src/bootstrap.ts`, or session handlers to evaluation code.
- Standard tests remain hermetic and provider-free. Cross-version subprocesses, benchmarks, raw-session
  execution, and provider calls are explicit opt-in commands.
- Every content-bearing artifact stays under the canonical local evidence root with `0700`/`0600`
  permissions.
- Any leaf that encounters an upstream verified hard-stop follows its documented hard-stop completion
  path: write/verify a `not-applicable` record referencing the upstream digest, perform no paid or
  content-bearing work, and close honestly.
- Destructive cleanup and paid provider calls always require explicit owner confirmation.

## 3. Work Item Hierarchy

### Epic E-1 — Safe evaluation foundation

Purpose: establish an isolated, strictly typed, privacy-preserving harness before any formal corpus
read or provider call.

#### Workstream E-1A — Build and protocol boundaries

- **T-001 — Establish the isolated context-pruning evaluation toolchain** (`P0`)
  - **What + why**: Create the script-only CLI skeleton, strict evaluation TypeScript config, core
    versioned types, canonical JSON/hash utilities, structured `E_EVAL_*` errors, and hermetic test
    discovery. The harness must be typechecked/tested by normal project verification while remaining
    unreachable from the production bundle.
  - **Related files / packages**: new `scripts/context-pruning/cli.ts`, `types.ts`,
    `canonical-json.ts`, `__tests__/`; new `tsconfig.evaluation.json`; `package.json`;
    `scripts/run-tests.mjs`.
  - **Acceptance criteria**:
    - CLI defaults to no provider calls and returns structured non-zero errors.
    - Canonical JSON and digests are stable across key order and repeated runs.
    - Production and evaluation typechecks run from the standard verification path.
    - Only hermetic evaluation tests run under `bun run test`; opt-in tests do not.
    - `src/index.ts` and the built extension contain no evaluation import.
  - **Definition of Done**: strict typecheck and new unit tests pass; package build/size remain green;
    toolchain behavior and opt-in commands are documented.
  - **References**: [Design §2.1](../specs/context-pruning-evaluation-design.md#21-repository-placement),
    [Design §10](../specs/context-pruning-evaluation-design.md#10-cli-api).

- **T-002A — Implement the private evidence run store and atomic records** (`P0`)
  - **What + why**: Implement canonical run-root resolution, `0700`/`0600` creation, cryptographic corpus
    keys, HMAC source digests, atomic manifest writes, and append-only JSONL events. This establishes
    durable private storage before any corpus component writes evidence.
  - **Related files / packages**: new `scripts/context-pruning/evidence-store.ts` and focused tests;
    Node filesystem/crypto only.
  - **Acceptance criteria**:
    - Every run resolves beneath `$PI_AGENT_DIR/blackbytes/evaluations/context-pruning/<run-id>`.
    - Directories/files use `0700`/`0600`; corpus keys never appear in reports or logs.
    - Interrupted atomic writes preserve the prior valid manifest.
    - Append-only events resume without duplicate IDs and retain failure records.
    - Source digests are keyed and reproducible without storing source paths in exported records.
  - **Definition of Done**: permission, atomicity, append/resume, key, and digest tests pass under a
    temporary `$PI_AGENT_DIR`; no real session is opened.
  - **References**: [Design §2.2](../specs/context-pruning-evaluation-design.md#22-local-evidence-root),
    [Design §13](../specs/context-pruning-evaluation-design.md#13-reliability-caching-and-jobs).

- **T-002B — Enforce evidence path containment, source integrity, and safe cleanup** (`P0`)
  - **What + why**: Add canonical-path and symlink containment, source before/after verification,
    manifest-scoped cleanup planning, confirmation gates, and cleanup execution. This isolates all
    destructive behavior from source sessions.
  - **Related files / packages**: `scripts/context-pruning/evidence-store.ts`, cleanup/verify CLI
    helpers, tests; existing `src/shared/redact.ts` only as defense in depth.
  - **Acceptance criteria**:
    - Writes/cleanup reject traversal, symlink escape, globs, unknown run IDs, and paths outside run root.
    - Source session paths can never enter a cleanup manifest.
    - Digest mismatch emits `E_EVAL_INTEGRITY` and blocks later stages.
    - Cleanup performs no deletion without explicit run-ID confirmation and a verified manifest.
    - A dry-run lists exact targets without revealing content-bearing names in committed output.
  - **Definition of Done**: containment, tamper, source-integrity, dry-run, and cleanup tests pass using
    temporary files; no real source file is modified or deleted.
  - **References**: [Design §10](../specs/context-pruning-evaluation-design.md#10-cli-api),
    [Design §12](../specs/context-pruning-evaluation-design.md#12-security-and-privacy).

- **T-003 — Land the frozen evaluation protocol, rubric, pricing, and report contracts** (`P0`)
  - **What + why**: Create committed, content-free protocol/rubric/report templates and a validated
    `protocol.lock.json` schema covering seed, long-session threshold, collection-window limits,
    target tuple, scoring, estimator, price card, and artifact digests. This prevents post-result
    threshold changes.
  - **Related files / packages**: new `docs/evaluation/context-pruning/protocol-v1.md`,
    `rubric-v1.md`, `report-template.md`, `pricing/README.md`; protocol types/validation under
    `scripts/context-pruning/`.
  - **Acceptance criteria**:
    - Protocol lock requires `protocolSeed`, `longSessionMinRequests=20`, ISO collection end,
      maximum refreshes, model-registry digest, rubric digest, and price-card digest.
    - Lock cannot be altered after sample freeze without creating a new run ID.
    - Templates contain no session IDs, repository paths, prompts, or raw content.
    - Utility/quality/applicability/feasibility formulas match the Accepted PRD exactly.
  - **Definition of Done**: docs and schema tests pass; boundary-value fixtures prove malformed or
    incomplete locks are rejected before formal inventory.
  - **References**: [PRD §3](../specs/context-pruning.md#3-goals-and-success-metrics),
    [Design §3.3](../specs/context-pruning-evaluation-design.md#33-deterministic-selection).

### Epic E-2 — Content-free inventory and unbiased sampling

Purpose: build and verify the read-only structural pipeline before any selected transcript is opened.

#### Workstream E-2A — Session structure

- **T-004 — Implement the streaming metadata-only Pi session inventory** (`P0`)
  - **What + why**: Stream Pi JSONL and emit only allowlisted `InventoryRecord` fields, numeric usage,
    cost, entry counts, pseudonyms, and exclusion reasons. Content-bearing fields must be discarded
    immediately and must never reach inventory/report serialization.
  - **Related files / packages**: new `scripts/context-pruning/inventory.ts`, `types.ts`, synthetic
    JSONL fixtures, and inventory tests; Node `readline`/`crypto` only.
  - **Acceptance criteria**:
    - Handles observed session/message/model/thinking/custom/compaction/label entries and unknown types.
    - Malformed/partial/unreadable files produce explicit records without aborting the corpus scan.
    - Output contains no `cwd`, message content, tool payload, summary, label text, diagnostics, or path.
    - Usage completeness and actual `usage.cost` channels are preserved numerically.
    - Memory use is bounded by one JSONL line plus aggregate state, not total corpus size.
  - **Definition of Done**: golden and privacy allowlist tests pass; a synthetic secret/content canary
    never appears in inventory or logs.
  - **References**: [Design §3.1](../specs/context-pruning-evaluation-design.md#31-two-pass-access-model),
    [PRD REQ-001/002/009](../specs/context-pruning.md#7-functional-requirements).

- **T-005 — Reconstruct and validate final Pi branches conservatively** (`P0`)
  - **What + why**: Build parent/child topology, select the terminal leaf with greatest source-line
    index and stable tie-breaker, reconstruct its branch, identify lineage duplicates, and validate
    selected copied sessions against pinned Pi session-manager resolution.
  - **Related files / packages**: `scripts/context-pruning/inventory.ts`, new branch helper and tests;
    multi-leaf/fork/steering golden fixtures; lifecycle copy loader.
  - **Acceptance criteria**:
    - Detects missing parent, cycle, duplicate ID, multiple leaves, fork lineage, and abandoned branches.
    - Multi-leaf selection is byte-stable and matches the documented line-index rule.
    - Copied selected sessions must resolve to the same leaf under Pi; mismatch excludes the record.
    - No validation opens the source session in write mode.
  - **Definition of Done**: topology/golden tests pass for linear, forked, navigated, corrupt, and
    duplicate-lineage sessions; exclusion reasons are stable.
  - **References**: [Design §3.2](../specs/context-pruning-evaluation-design.md#32-sampling-frame),
    [Design §8](../specs/context-pruning-evaluation-design.md#8-lifecycle-feasibility-prototype).

#### Workstream E-2B — Frozen sample

- **T-006 — Implement deterministic first-40 sampling and sensitivity summaries** (`P0`)
  - **What + why**: Build the eligible long-session frame, HMAC-pseudonymize records, compute the
    inventory digest and selection keys, freeze the first 40 without replacement, and report
    non-decision sensitivity for request thresholds and repository concentration.
  - **Related files / packages**: new `scripts/context-pruning/sampling.ts`, `types.ts`, and tests.
  - **Acceptance criteria**:
    - Same inventory/key/seed produces identical ordered sample and digest.
    - Sampling never reads content and never redraws for provider, repository, compaction, or outcome.
    - Duplicate lineages contribute at most one frame record.
    - Frame under 40 emits `E_EVAL_INCOMPLETE`, freezes no partial sample, and respects locked time and
      refresh limits.
    - Sensitivity at thresholds 10/15/20/25 cannot alter the primary sample.
  - **Definition of Done**: deterministic/property/boundary tests pass, including 39/40/41 frame sizes
    and repository clustering.
  - **References**: [Design §3.3](../specs/context-pruning-evaluation-design.md#33-deterministic-selection),
    [PRD G-003](../specs/context-pruning.md#g-003--establish-applicability).

### Epic E-3 — Qualification, snapshots, and leakage control

Purpose: support controlled local content review only after sampling is immutable.

#### Workstream E-3A — Qualification

- **T-007A — Implement deterministic qualification criteria and complete-range validation** (`P1`)
  - **What + why**: Implement the four criterion calculations, frozen context-window fallback, canonical
    token estimator, complete-turn/tool validation, compaction-epoch boundaries, and five-request
    horizon checks independently of human annotations.
  - **Related files / packages**: new `scripts/context-pruning/qualification.ts`, estimator and range
    helpers, synthetic fixtures, and boundary tests.
  - **Acceptance criteria**:
    - Uses recorded context percent or frozen model-window data; missing windows never become guesses.
    - Rejects unmatched tools, partial turns, cross-branch/cross-compaction ranges, ranges below 2,048
      estimated tokens, and fewer than five subsequent requests.
    - Estimator and range results are byte-stable for the same canonical content/branch.
    - Result records contain references, numbers, booleans, and reason codes only.
  - **Definition of Done**: every criterion boundary and structural exclusion has a passing golden/unit
    test; privacy schema rejects any content field.
  - **References**: [Design §4.1–4.2](../specs/context-pruning-evaluation-design.md#4-qualification-and-candidate-selection),
    [PRD REQ-003](../specs/context-pruning.md#7-functional-requirements).

- **T-007B — Implement blinded annotation ingestion, adjudication, and candidate selection** (`P1`)
  - **What + why**: Validate independent annotation files, enforce allowed closure evidence, preserve
    disagreements, record adjudication, and select the earliest-closing eligible range without access
    to replay, cost, gold, or gate outcomes.
  - **Related files / packages**: `scripts/context-pruning/qualification.ts`, annotation/adjudication
    schemas, CLI handler, and tests.
  - **Acceptance criteria**:
    - Supports only `user-accepted`, `goal-transition`, and `verification-passed`; assistant-only or
      ambiguous closure cannot qualify.
    - Unresolved disagreement blocks candidate selection.
    - Earliest close then earliest start is the deterministic tie-breaker.
    - Annotation outputs contain IDs/digests/codes only and cannot include transcript or future outcomes.
  - **Definition of Done**: annotation, disagreement, adjudication, tie-breaker, access-boundary, and
    privacy tests pass with fabricated sessions.
  - **References**: [Design §4.2](../specs/context-pruning-evaluation-design.md#42-complete-segment),
    [Design §5.1](../specs/context-pruning-evaluation-design.md#51-role-separation).

- **T-008 — Implement immutable evaluation snapshot, gold-ledger, and fixture freezing** (`P1`)
  - **What + why**: Freeze one snapshot per qualifying session with five checkpoints, target/system/tool
    digests, candidate digest, repository-fixture status, atomic gold facts, and role-separation access
    controls. This prevents future-context and answer leakage.
  - **Related files / packages**: new `scripts/context-pruning/snapshots.ts`, snapshot/gold schemas,
    fixture-manifest helpers, `freeze` CLI handler, and tests.
  - **Acceptance criteria**:
    - Exactly one primary snapshot is allowed per qualifying session.
    - Summary-generation inputs exclude future checkpoints, probes, gold answers, and baseline outputs.
    - Gold facts include source references and diagnostic/non-diagnostic status per checkpoint.
    - Fixture status is exactly `exact`, `reconstructed`, or `unavailable`; original repos are never
      execution targets.
    - Any post-freeze mutation changes a digest and blocks replay.
  - **Definition of Done**: leakage, immutability, role-access, and fixture-classification tests pass;
    no real repository fixture is committed.
  - **References**: [Design §5](../specs/context-pruning-evaluation-design.md#5-snapshot-and-leakage-controls),
    [Design §6.2](../specs/context-pruning-evaluation-design.md#62-sandboxed-continuation).

### Epic E-4 — Feasibility and paired replay machinery

Purpose: resolve the critical cost/lifecycle unknowns before any paid main evaluation.

#### Workstream E-4A — Blocking Pi feasibility

- **T-009A — Implement native-compaction usage capture instrumentation** (`P0`)
  - **What + why**: Add a generated-fixture compaction scenario, request-origin attribution, actual
    usage/cost capture, missing/merged classification, and a structural helper that later counts
    compaction inside frozen five-request horizons. This task performs no provider call.
  - **Related files / packages**: new compaction scenario under
    `scripts/context-pruning/lifecycle/`, usage capture helper, schemas, and hermetic tests.
  - **Acceptance criteria**:
    - Separates compaction-origin usage from the following main request when evidence exposes it.
    - Missing, merged, or ambiguous usage is explicit and is never estimated.
    - Generated fixtures cover complete, missing, merged, and duplicate usage events.
    - Horizon counting consumes only entry IDs/types/timestamps and emits aggregate counts.
  - **Definition of Done**: hermetic capture/attribution/horizon tests pass; a provider-free probe artifact
    can be written and verified through the private evidence store.
  - **References**: [Design §7.2](../specs/context-pruning-evaluation-design.md#72-usage-and-provider-equivalent-cost).

- **T-009B — Run the confirmed generated-fixture compaction accounting proof** (`P0`, bottleneck,
  `cost:confirmation-required`)
  - **What + why**: After the hermetic pipeline is green, run the smallest generated-session provider
    proof needed to determine whether actual native-compaction generation usage is attributable. This
    paid execution is deliberately sequenced after T-016, uses no real session content, and resolves
    blocking DQ-004 before protocol freeze or main replay.
  - **Related files / packages**: opt-in lifecycle command, local evidence root, DQ-004 evidence note;
    no source corpus or repository fixture.
  - **Acceptance criteria**:
    - Owner sees target, planned calls, and upper cost before confirming.
    - The run uses generated content only and writes through T-002A/T-002B boundaries.
    - Positive evidence identifies actual compaction usage; negative/ambiguous evidence records the
      permitted extension or hard-stop without estimation.
    - DQ-004 status and design revision history are updated from the verified artifact.
  - **Definition of Done**: confirmed proof artifact and source/environment hashes verify, or the owner
    declines the paid proof and a blocking incomplete-evidence record is produced.
  - **References**: [Design DQ-004](../specs/context-pruning-evaluation-design.md#18-open-questions),
    [Plan §2 execution rules](#2-execution-rules).

- **T-010A — Implement conservative provenance claims and ground-truth comparison** (`P0`)
  - **What + why**: Implement the pure shadow computation that maps only unambiguous context messages to
    source entries, identifies complete-turn ranges, leaves ambiguous/created messages unowned, and
    compares claims with copied-branch synthetic ground truth plus coverage.
  - **Related files / packages**: new `scripts/context-pruning/lifecycle/extension.ts`, provenance/claim
    helpers, generated fixtures, and unit/property tests.
  - **Acceptance criteria**:
    - Computation returns original context unchanged and appends no session data.
    - Any wrong owner or turn boundary is a false positive; zero claims cannot pass coverage reporting.
    - Duplicate and transformer-created messages remain unowned.
    - Result contains indices/entry IDs/method/coverage only, no content.
  - **Definition of Done**: provenance, ambiguity, boundary, coverage, and privacy tests pass on generated
    and copied-structure fixtures; production import graph remains unchanged.
  - **References**: [Design §8](../specs/context-pruning-evaluation-design.md#8-lifecycle-feasibility-prototype).

- **T-010B — Implement the isolated cross-version lifecycle scenario runner** (`P0`)
  - **What + why**: Wrap T-010A in a non-shipping shadow extension and isolated runner for reload,
    compaction, branch/fork/tree, steering, duplicate messages, sequential tools, and both context-hook
    load orders on pinned Pi installations. All lifecycle results are persisted through the T-002A
    private evidence store.
  - **Related files / packages**: new `scripts/context-pruning/lifecycle/runner.ts`, `scenarios.ts`,
    version/environment digest helpers, hermetic mocks, and opt-in command.
  - **Acceptance criteria**:
    - Runner supports exact Pi 0.74.0 and one protocol-pinned current installation.
    - Prototype registers no public tool/command, appends nothing, and writes only to local evidence.
    - Every required scenario/load order emits claims, coverage, source/copy digests, and environment hash.
    - Standard tests mock subprocess/version behavior; actual matrix remains opt-in.
  - **Definition of Done**: hermetic scenario/runner/version tests pass and opt-in matrix command validates
    pinned binaries before execution.
  - **References**: [Design §8](../specs/context-pruning-evaluation-design.md#8-lifecycle-feasibility-prototype),
    [PRD G-004](../specs/context-pruning.md#g-004--establish-technical-feasibility).

- **T-011 — Implement the isolated lifecycle performance benchmark** (`P0`)
  - **What + why**: Measure absolute and no-op-adjusted handler latency with mandatory largest-session
    fixture, separate cold start, fixed warmups/iterations, and nearest-rank percentiles per fixture and
    Pi version.
  - **Related files / packages**: lifecycle benchmark runner, result schema, opt-in package command,
    and percentile unit tests.
  - **Acceptance criteria**:
    - Uses at least 100 warmups and 1,000 measured invocations in isolated processes.
    - Includes the largest selected session and both pinned Pi versions.
    - Reports per-fixture p50/p95/max and gates on maximum absolute p95, never pooled p95.
    - Standard tests do not execute the benchmark.
  - **Definition of Done**: percentile/gating tests pass; opt-in runner emits versioned benchmark JSONL
    with environment digests.
  - **References**: [Design §8.1](../specs/context-pruning-evaluation-design.md#81-performance-protocol).

#### Workstream E-4B — Paired execution engine

- **T-012A — Implement deterministic teacher-forced paired replay core** (`P0`)
  - **What + why**: Implement five-checkpoint native/selective context construction, independent summary
    generation input isolation, seeded AB/BA arm order, three-replicate scheduling, and the rule that
    generated outputs never feed later checkpoints.
  - **Related files / packages**: new `scripts/context-pruning/replay.ts`, replay-plan schemas, synthetic
    model adapter, and paired-context tests.
  - **Acceptance criteria**:
    - Both arms share exact target/system/tools/repository/checkpoint/request budgets.
    - Selective summary input excludes future checkpoints/gold/baseline and full generation is scheduled
      once per replicate.
    - Each arm has at least three attempts with deterministic balanced ordering.
    - Teacher-forced checkpoint inputs differ only in candidate-range representation.
  - **Definition of Done**: provider-free replay-plan/context/leakage/order tests pass across five
    checkpoints, retries excluded from scheduling logic until T-012B.
  - **References**: [Design §6.1](../specs/context-pruning-evaluation-design.md#61-teacher-forced-checkpoint-replay),
    [PRD REQ-004](../specs/context-pruning.md#7-functional-requirements).

- **T-012B — Implement provider confirmation, retry policy, and complete usage ledger** (`P0`)
  - **What + why**: Add the provider runner adapter, explicit target/call-count/upper-cost confirmation,
    append-only attempt/usage events, symmetric retries, cache-isolation status, and compaction-origin
    records from T-009A.
  - **Related files / packages**: provider adapter, confirmation UI, usage-event schemas, replay CLI
    handler, and no-provider fake-adapter tests.
  - **Acceptance criteria**:
    - No provider call starts without explicit matching confirmation.
    - Every success/failure/retry records actual usage/cost completeness and retry relationship.
    - Retry policy is symmetric across arms and preserves billed failed calls.
    - Missing compaction accounting or frozen-hash mismatch blocks provider execution.
    - Content-bearing outputs remain local under evidence-store boundaries.
  - **Definition of Done**: fake-provider confirmation/refusal/retry/cache/ledger tests pass; real provider
    command remains opt-in and absent from standard tests.
  - **References**: [Design §7.2](../specs/context-pruning-evaluation-design.md#72-usage-and-provider-equivalent-cost),
    [Design §10](../specs/context-pruning-evaluation-design.md#10-cli-api).

- **T-012C — Implement disposable sandbox continuation for objective task checks** (`P1`)
  - **What + why**: Implement optional native/selective continuation in separate exact/reconstructed
    repository fixtures with identical tools/request caps and hidden checks, while refusing the user's
    original repository or unavailable fixtures.
  - **Related files / packages**: sandbox continuation helper, fixture-copy/worktree adapter, hidden-check
    result schema, and temporary-repository tests.
  - **Acceptance criteria**:
    - Only `exact`/`reconstructed` fixtures execute; `unavailable` records a rubric-only path.
    - Native/selective arms use separate disposable paths and identical tool/request limits.
    - Canonical-path checks reject the original repository and any path outside fixture root.
    - Cleanup removes only disposable fixtures after results/digests are persisted.
  - **Definition of Done**: temp-repository isolation, refusal, hidden-check, and cleanup tests pass without
    touching the working repository.
  - **References**: [Design §6.2](../specs/context-pruning-evaluation-design.md#62-sandboxed-continuation),
    [PRD REQ-005](../specs/context-pruning.md#7-functional-requirements).

### Epic E-5 — Scoring, decision, reporting, and hermetic verification

Purpose: ensure evidence is calculated mechanically and can neither leak content nor be overridden.

#### Workstream E-5A — Metrics and decision

- **T-013 — Implement blinded quality, recall, safety, and cost scoring** (`P0`)
  - **What + why**: Score atomic facts, task completion, severe safety events, checkpoint-5 cost,
    break-even, replicate variance, and snapshot-cluster uncertainty without exposing arm identity to
    scorers or allowing token estimates to substitute for actual cost.
  - **Related files / packages**: new `scripts/context-pruning/scoring.ts`, `cost.ts`, scoring/cost
    schemas, and boundary tests.
  - **Acceptance criteria**:
    - Fact scores are exactly 1/0.5/0 with contradiction flag; snapshots receive equal weight.
    - Reports recall delta, task-completion delta, arm severe-event rates, and fragile thresholds.
    - Uses provider `usage.cost.total` or recomputation from actual channels/locked price card.
    - Calculates `reduction5` only through checkpoint five and break-even `1..5 | >5`.
    - Missing actual mandatory usage makes utility incomplete.
  - **Definition of Done**: formula and boundary tests pass for PRD pass/near-miss/fail values; blinded
    fixtures demonstrate scorer inputs omit arm/cost/summary metadata.
  - **References**: [Design §7.1–7.2](../specs/context-pruning-evaluation-design.md#7-scoring-and-decision-model).

- **T-014 — Implement the exhaustive non-overridable decision engine** (`P0`)
  - **What + why**: Encode Accepted PRD rules as a pure function returning one `GO`, `REVISE`, or
    `NO-GO` with a threshold-by-threshold trace. Operators may provide evidence inputs but cannot
    override the outcome.
  - **Related files / packages**: new `scripts/context-pruning/decision.ts`, decision schemas, and
    exhaustive boundary/property tests.
  - **Acceptance criteria**:
    - GO requires all four gates.
    - REVISE allows exactly one total permitted deviation with quality and all other gates passing.
    - Every other failure, severe event, provenance false positive, underflow, or missing evidence maps
      to NO-GO.
    - Exactly one outcome is returned for every valid gate combination; invalid inputs error.
  - **Definition of Done**: exhaustive partition/property tests cover every threshold endpoint and
    hard-stop path; decision trace is deterministic.
  - **References**: [PRD §10](../specs/context-pruning.md#10-decision-rules),
    [Design §7.3](../specs/context-pruning-evaluation-design.md#73-mechanical-decision).

#### Workstream E-5B — Safe outputs and integration

- **T-015 — Implement allowlisted reports, integrity verification, and cleanup** (`P1`)
  - **What + why**: Generate a detailed local report and committed-safe aggregate candidate, suppress
    low-count buckets, verify all artifact/source digests, list every exclusion/failure/skip, and clean
    only manifest-listed local artifacts after confirmation.
  - **Related files / packages**: new `scripts/context-pruning/export-redacted.ts`, report/verify/cleanup
    CLI orchestration, and tests; consumes the report template from T-003 and invokes rather than
    reimplements T-002B verify/cleanup primitives.
  - **Acceptance criteria**:
    - Committed candidate contains no corpus ID, entry ID, path, repo ID, prompt, output, or raw content.
    - Secret redaction is applied after allowlist construction; canary content never appears.
    - Report refuses calculation on hash/schema/source mismatch.
    - Low-count buckets are suppressed and limitations include repository clustering/cache isolation.
    - Cleanup requires confirmation and cannot touch source sessions or paths outside run root.
  - **Definition of Done**: privacy golden tests, tamper tests, report snapshot tests, and cleanup safety
    tests pass.
  - **References**: [Design §10–13](../specs/context-pruning-evaluation-design.md#10-cli-api),
    [PRD REQ-008/009](../specs/context-pruning.md#7-functional-requirements).

- **T-016 — Add the hermetic end-to-end evidence pipeline and project checks** (`P0`, bottleneck)
  - **What + why**: Exercise inventory → sample → qualify → freeze → synthetic replay → score → decision
    → report using fabricated sessions, including interrupted resume, hard-stop, privacy, and source
    integrity. Wire hermetic evidence tests/typecheck into normal verification without requiring a
    provider or second Pi install.
  - **Related files / packages**: `scripts/context-pruning/__tests__/integration.test.ts` and generated
    fixtures; validates package/typecheck/test wiring owned by T-001 without editing that wiring.
  - **Acceptance criteria**:
    - Full success and every predeclared hard-stop path produce the expected deterministic result.
    - Resume does not duplicate append-only events or alter frozen manifests.
    - Standard project verification runs evaluation typecheck/hermetic tests only.
    - Build and package size prove the script harness is absent from production output.
  - **Definition of Done**: `bun run check` passes and demonstrably includes evaluation typecheck plus
    hermetic evidence tests through T-001 wiring; opt-in commands are listed but not executed.
  - **References**: [Design §15](../specs/context-pruning-evaluation-design.md#15-testing-strategy),
    [PRD REQ-010](../specs/context-pruning.md#7-functional-requirements).

### Epic E-6 — Execute the evidence protocol

Purpose: run the accepted protocol against local data only after the harness is hermetically verified.
These leaves may complete through the explicit hard-stop path defined in §2.

#### Workstream E-6A — Freeze corpus and qualification

- **T-017 — Run formal metadata inventory and freeze the first-40 sample** (`P0`)
  - **What + why**: With owner-approved seed, collection limits, and source root, run the content-free
    formal inventory, validate selected copied branches, freeze the eligible frame/inventory digest,
    and sample the first 40 without replacement.
  - **Related files / packages**: local evidence root only; committed report receives aggregates later.
  - **Acceptance criteria**:
    - Owner approves protocol seed/window/refresh count before run.
    - Source digests match before/after; inventory emits no content-bearing fields.
    - At least 40 eligible sessions yields an immutable sample; underflow follows the locked collection
      window and hard-stop behavior without partial sample.
    - Frame/sample distributions and sensitivity tables are recorded.
  - **Definition of Done**: `verify` passes the formal inventory/sample or a hashed underflow hard-stop;
    no repository file contains raw session data.
  - **References**: [Design §3](../specs/context-pruning-evaluation-design.md#3-corpus-and-sampling-protocol).

- **T-018 — Qualify and independently annotate sampled ranks 1–20** (`P1`, owner-assisted)
  - **What + why**: Apply local Pass B to the first half of the immutable sample, collect independent
    closure/range annotations, and record all four criteria without viewing replay/cost outcomes.
  - **Related files / packages**: local qualifications/annotations only.
  - **Acceptance criteria**:
    - Owner explicitly confirms content access and second-annotator/scorer arrangement (DQ-003).
    - Every rank 1–20 has a complete criterion/exclusion record and source digest.
    - Disagreements remain unresolved for later adjudication; no favorable range is substituted.
    - If T-017 hard-stopped, write only a verified not-applicable record.
  - **Definition of Done**: local qualification schema/privacy verification passes for all applicable
    ranks; source files remain unchanged.
  - **References**: [Design §4–5](../specs/context-pruning-evaluation-design.md#4-qualification-and-candidate-selection).

- **T-019 — Qualify and independently annotate sampled ranks 21–40** (`P1`, owner-assisted)
  - **What + why**: Apply the identical locked process to the second half so qualification is complete
    without changing rules after observing the first half.
  - **Related files / packages**: local qualifications/annotations only.
  - **Acceptance criteria**: same as T-018 for ranks 21–40; no threshold, annotator instruction, or
    candidate-selection rule changes are permitted between batches.
  - **Definition of Done**: local qualification schema/privacy verification passes for all applicable
    ranks or a verified upstream not-applicable record exists; source files remain unchanged.
  - **References**: [Design §4–5](../specs/context-pruning-evaluation-design.md#4-qualification-and-candidate-selection).

- **T-020 — Adjudicate qualification and freeze evaluation snapshots/protocol** (`P0`, owner-assisted)
  - **What + why**: Resolve annotations before outcomes are visible, calculate applicability, select one
    snapshot per qualifying session, freeze target tuple/rubric/pricing/gold/fixtures, and decide
    whether the protocol may continue.
  - **Related files / packages**: local protocol lock, qualifications, snapshots, gold, fixture manifests;
    design open-question statuses/revision history.
  - **Acceptance criteria**:
    - DQ-001, DQ-002, DQ-003, and DQ-005 have owner decisions before freeze; T-009B resolved DQ-004.
    - All 40 selected sessions are included in applicability denominator.
    - At least 10 qualifying sessions freeze exactly one snapshot each; fewer than 10 produces hashed
      NO-GO hard-stop and no paid replay.
    - No unresolved disagreement, mutable target, future leakage, or original-repo execution path remains.
  - **Definition of Done**: protocol/snapshot/fixture/gold digests verify, design questions/history are
    updated, or a verified qualification hard-stop is recorded.
  - **References**: [PRD G-003](../specs/context-pruning.md#g-003--establish-applicability),
    [Design §5](../specs/context-pruning-evaluation-design.md#5-snapshot-and-leakage-controls).

#### Workstream E-6B — Collect evidence and decide

- **T-021 — Run the pinned Pi lifecycle and performance evidence matrix** (`P0`, opt-in)
  - **What + why**: Execute lifecycle/provenance scenarios and the mandatory performance protocol on Pi
    0.74.0 and the owner-pinned current version using copied/generated fixtures, including the largest
    selected session.
  - **Related files / packages**: local lifecycle/benchmark JSONL; design DQ-005 status.
  - **Acceptance criteria**:
    - Exact package/binary digests and both load orders are recorded.
    - Zero false-positive ownership/boundary claims; coverage is non-trivial and reported.
    - Maximum per-fixture absolute p95 is calculated from required warmups/iterations and compared with
      25 ms; cold start remains separate.
    - Any source mutation or lifecycle privacy failure hard-stops.
    - Upstream hard-stop yields only a verified not-applicable record when further evidence is unnecessary.
  - **Definition of Done**: lifecycle/benchmark artifacts and environment hashes verify; G-004 inputs or
    explicit hard-stop are ready for decision.
  - **References**: [Design §8](../specs/context-pruning-evaluation-design.md#8-lifecycle-feasibility-prototype).

- **T-022 — Run confirmed paid paired replay and score all qualifying snapshots** (`P0`, cost-confirmed)
  - **What + why**: After owner confirmation and successful blockers, run at least three native and three
    selective replicates for all checkpoints/snapshots, retain failures/retries, then compute blinded
    quality, safety, checkpoint-5 cost, break-even, and uncertainty evidence.
  - **Related files / packages**: local run/usage/score JSONL and repository fixtures only.
  - **Acceptance criteria**:
    - Owner sees and confirms target, planned call count, upper cost, and minimum snapshot count.
    - T-009B compaction accounting is complete; all frozen hashes verify before calls.
    - Every qualifying snapshot has complete arm/replicate/checkpoint records or explicit failed attempts.
    - Scorers remain blind to arm and cost; all actual usage channels and provider costs are retained.
    - No raw content, output, or fixture is committed.
    - Upstream hard-stop yields no provider call and only a verified not-applicable record.
  - **Definition of Done**: local score/cost integrity verification passes and G-001/G-002 inputs are
    complete, or the permitted missing-data/hard-stop evidence is recorded.
  - **References**: [Design §6–7](../specs/context-pruning-evaluation-design.md#6-paired-evaluation),
    [PRD G-001/G-002](../specs/context-pruning.md#3-goals-and-success-metrics).

- **T-023 — Produce the final aggregate report and record the owner decision** (`P0`)
  - **What + why**: Verify all artifact/source hashes, generate local detailed and committed-safe
    aggregate reports, mechanically calculate exactly one outcome, review limitations, and update
    PRD/design/plan histories. A negative or hard-stop result is a valid completed deliverable.
  - **Related files / packages**: `docs/evaluation/context-pruning/reports/<run-id>.md` (aggregate only),
    source PRD/design/plan revision histories, local detailed report.
  - **Acceptance criteria**:
    - Report includes corpus/sample distributions, all exclusions/failures/skips, quality/cost/applicability/
      feasibility inputs, uncertainty, clustering/cache limitations, and decision trace.
    - Committed report passes privacy allowlist/canary and contains no local identifiers/content.
    - Decision engine emits one non-overridden `GO`, `REVISE`, or `NO-GO` consistent with the PRD.
    - Owner explicitly records acceptance of the decision; runtime plan remains deferred unless outcome
      is `GO`, after which a new runtime Technical Design is still required.
    - Full project/evaluation verification passes and source sessions remain byte-unchanged.
  - **Definition of Done**: report and revision histories are complete, owner decision recorded, all
    verification outcomes reported honestly, and local cleanup remains optional/confirmation-gated.
  - **References**: [PRD §10–11](../specs/context-pruning.md#10-decision-rules),
    [Design §16–17](../specs/context-pruning-evaluation-design.md#16-phase-1-scope-summary).

## 4. Dependencies

Hierarchy groups work; only the following edges block execution:

| Edge | Reason |
|---|---|
| T-002A depends on T-001 | Private run store uses core types/errors/canonical hashing. |
| T-002B depends on T-002A | Containment/cleanup/integrity extend the canonical private store. |
| T-003 depends on T-001 | Protocol schema uses the versioned core contracts. |
| T-004 depends on T-001, T-002A | Inventory needs record types and private atomic writes. |
| T-005 depends on T-004 | Branch reconstruction consumes parsed inventory topology. |
| T-006 depends on T-003, T-004, T-005 | Sampling requires locked parameters, inventory, and validated lineages. |
| T-007A depends on T-002A, T-003, T-005 | Criteria need private writes, frozen rules, and branch model. |
| T-007B depends on T-007A | Annotation/adjudication consumes structurally eligible ranges. |
| T-008 depends on T-002A, T-003, T-007B | Snapshot/freeze consumes resolved candidates and protocol contracts. |
| T-009A depends on T-001, T-002A, T-004 | Compaction instrumentation needs core/store and usage parsing. |
| T-010A depends on T-001, T-005 | Provenance claims use core contracts and branch model. |
| T-010B depends on T-002A, T-010A | Scenario runner wraps provenance and writes through the private evidence store. |
| T-011 depends on T-010B | Benchmark measures the lifecycle runner/prototype. |
| T-012A depends on T-002A, T-008 | Replay planning needs private writes and frozen snapshots. |
| T-012B depends on T-002B, T-009A, T-012A | Provider ledger needs safety boundary, compaction records, and replay core. |
| T-012C depends on T-002B, T-008, T-012A | Sandbox needs path safety, fixture manifests, and replay plan. |
| T-013 depends on T-001, T-003, T-012A, T-012B | Scoring/cost consume protocol, replay plans, and usage events. |
| T-014 depends on T-003, T-013 | Decision engine consumes locked thresholds and scores. |
| T-015 depends on T-002B, T-014 | Report/verify/cleanup depend on safety boundary and decision. |
| T-016 depends on T-004, T-005, T-006, T-007A, T-007B, T-008, T-009A, T-010A, T-010B, T-011, T-012A, T-012B, T-012C, T-013, T-014, T-015 | Intentional integration gate: hermetic E2E verifies all implemented components before real or paid evidence. |
| T-009B depends on T-009A, T-016 | Confirmed generated-fixture proof runs only after instrumentation and hermetic suite pass. |
| T-017 depends on T-003, T-006, T-016 | Formal inventory runs only after protocol, sampler, and hermetic suite pass. |
| T-018 depends on T-007B, T-017 | First annotation batch uses implemented adjudication and immutable sample. |
| T-019 depends on T-007B, T-017 | Second annotation batch uses the same adjudication and immutable sample. |
| T-020 depends on T-008, T-009B, T-018, T-019 | Freeze requires snapshots, resolved compaction accounting, and all annotations. |
| T-021 depends on T-010B, T-011, T-020 | Real matrix needs runner/benchmark and frozen selected fixtures. |
| T-022 depends on T-012A, T-012B, T-012C, T-013, T-020 | Paid replay needs all execution/scoring components and frozen protocol. |
| T-023 depends on T-014, T-015, T-021, T-022 | Final report consumes decision/report tooling and all applicable evidence. |

No cycles. **Bottlenecks**: T-001/T-002A/T-002B (safe tooling), T-016 (permission for real or paid
evidence), T-009B (compaction-accounting decision), T-020 (protocol/qualification continuation gate),
and T-023 (final decision).

Conditional hard-stop behavior is not a missing dependency: downstream leaves still inspect and
validate the upstream hard-stop digest, write a not-applicable record, and complete without unsafe
work.

## 5. Test Strategy

- **Unit**: `node:test` + `node:assert/strict` for every pure parser, hash, schema, selection,
  qualification, scoring, cost, decision, path, percentile, and privacy function.
- **Golden**: fabricated Pi 0.74/current JSONL covering all observed entry/usage shapes, multiple leaves,
  compactions, unknown/partial records, and secret/content canaries.
- **Property/boundary**: deterministic sample, decision totality/exclusivity, no forbidden inventory/
  report keys, path confinement, every PRD threshold endpoint, and frame sizes 39/40/41.
- **Hermetic integration**: full no-provider pipeline, resume, tamper, hard-stop, cleanup, source-digest,
  and load-order scenarios under temporary `$PI_AGENT_DIR`.
- **Opt-in evidence**: cross-version lifecycle subprocesses, performance benchmark, selected raw sessions,
  repository fixtures, and provider replay are never part of standard CI.
- **Coverage policy**: no new coverage dependency. All decision branches, all structured error codes,
  every privacy allowlist boundary, and every hard-stop path require explicit tests; missing any is a
  gate failure.
- **Verification**: `bun run check` must include strict evaluation typecheck and hermetic evidence tests
  through the standard typecheck/test scripts. Opt-in evidence commands are reported separately and
  never misrepresented as normal tests.

## 6. Migration, Backward Compatibility, and Rollback

- **Database/schema migration**: none. Local JSON/JSONL evidence is schema-versioned and run-scoped.
- **Data backfill**: none.
- **Downtime**: none.
- **Backward compatibility**: no production tool, command, hook, config, prompt, sub-agent, or public type
  changes. Evaluation scripts remain outside the extension entry point and package runtime.
- **Rollback**: remove evaluation package-script/test-discovery wiring and stop invoking the CLI. Local
  evidence is inert and removed only through explicit manifest-scoped cleanup. Source sessions require
  no rollback because they are never modified.
- **Failure rollback**: atomic manifests retain the previous valid state; append-only events preserve
  failure evidence; resume or cleanup uses the same run ID and canonical root.

## 7. Risks and Open Questions

| ID | Risk / Question | Mitigation / Owner | Status / blocked leaves |
|---|---|---|---|
| R-001 | Metadata allowlist accidentally retains content. | Canary/property tests, schema allowlist, redaction defense; owner: Bytes | open; blocks T-016/T-017 |
| R-002 | Long-session threshold or branch heuristic biases sample. | Lock threshold/seed, sensitivity table, copied-Pi leaf validation; owner: Bytes | open; blocks T-017 |
| R-003 | Repository/task clustering weakens generalization. | Pseudonym distribution, session-cluster uncertainty, explicit limitation; owner: invoker | open; does not change primary sample |
| R-004 | Provider/cache drift confounds cost. | Exact target tuple, actual channels, AB/BA order, cache status, price snapshot; owner: invoker | open; blocks T-020/T-022 |
| R-005 | Native compaction cost cannot be separated. | T-009A instrumentation + T-009B confirmed generated-fixture proof; no estimates; owner: invoker / Bytes | open; blocks T-020/T-022 |
| R-006 | Historical repository state cannot be reconstructed. | Exact/reconstructed/unavailable classifications; blinded rubric fallback; owner: invoker | open; blocks only objective checks for affected snapshots |
| R-007 | Solo evaluator weakens blinding. | Role-separated artifacts, opaque arm labels, second annotator/scorer decision, disclose limitation; owner: invoker | open; blocks T-018–T-020 |
| Q-001 | Primary provider/model/API/reasoning tuple? | Select from inventory before qualification; owner: invoker | open; blocks T-020/T-022 |
| Q-002 | Which repositories have objective historical checks? | Inventory selected repository pseudonyms, then map locally; owner: invoker | open; blocks T-020 fixture freeze only |
| Q-003 | Independent annotator and blinded scorer? | Human or consented model, fixed before Pass B; owner: invoker | open; blocks T-018–T-020 |
| Q-004 | Can compaction usage be captured? | Implement T-009A then run T-009B; owner: invoker / Bytes | open; blocks protocol freeze and paid replay |
| Q-005 | Pinned “current” Pi version? | Owner selects exact install and records integrity digest; owner: invoker | open; blocks T-020/T-021 |
| Q-006 | Distribution license? | Deferred; owner: invoker | deferred; does not block local Phase 1 |

## 8. Beads Handoff Notes

- Use a **new** feature graph; never reuse the deferred runtime IDs.
- Suggested root title: `Dynamic Context Pruning — Phase 1 Evidence Spike`.
- Labels: `feature:context-pruning`, `phase:evidence-spike`; add `data:local-sensitive` to T-017–T-023
  and `cost:confirmation-required` to T-009B and T-022.
- Preserve the task IDs and dependency edges above.
- Manual/content/provider leaves must retain both normal and verified hard-stop completion paths.
- Convert only after this plan is `Active` and `plan-ready-for-beads` passes.

## 9. Beads Trace

| Plan item | Bead ID |
|---|---|
| Root feature | `pib-context-pruning-evidence-bad9` |
| E-1: Safe evaluation foundation | `pib-context-pruning-evidence-bad9.1` |
| E-2: Content-free inventory and unbiased sampling | `pib-context-pruning-evidence-bad9.2` |
| E-3: Qualification, snapshots, and leakage control | `pib-context-pruning-evidence-bad9.3` |
| E-4: Feasibility and paired replay machinery | `pib-context-pruning-evidence-bad9.4` |
| E-5: Scoring, decision, reporting, and hermetic verification | `pib-context-pruning-evidence-bad9.5` |
| E-6: Execute the evidence protocol | `pib-context-pruning-evidence-bad9.6` |
| T-001: Establish the isolated context-pruning evaluation toolchain | `pib-context-pruning-evidence-bad9.1.1` |
| T-002A: Implement the private evidence run store and atomic records | `pib-context-pruning-evidence-bad9.1.2` |
| T-002B: Enforce evidence path containment, source integrity, and safe cleanup | `pib-context-pruning-evidence-bad9.1.3` |
| T-003: Land the frozen evaluation protocol, rubric, pricing, and report contracts | `pib-context-pruning-evidence-bad9.1.4` |
| T-004: Implement the streaming metadata-only Pi session inventory | `pib-context-pruning-evidence-bad9.2.1` |
| T-005: Reconstruct and validate final Pi branches conservatively | `pib-context-pruning-evidence-bad9.2.2` |
| T-006: Implement deterministic first-40 sampling and sensitivity summaries | `pib-context-pruning-evidence-bad9.2.3` |
| T-007A: Implement deterministic qualification criteria and complete-range validation | `pib-context-pruning-evidence-bad9.3.1` |
| T-007B: Implement blinded annotation ingestion, adjudication, and candidate selection | `pib-context-pruning-evidence-bad9.3.2` |
| T-008: Implement immutable evaluation snapshot, gold-ledger, and fixture freezing | `pib-context-pruning-evidence-bad9.3.3` |
| T-009A: Implement native-compaction usage capture instrumentation | `pib-context-pruning-evidence-bad9.4.1` |
| T-009B: Run the confirmed generated-fixture compaction accounting proof | `pib-context-pruning-evidence-bad9.4.2` |
| T-010A: Implement conservative provenance claims and ground-truth comparison | `pib-context-pruning-evidence-bad9.4.3` |
| T-010B: Implement the isolated cross-version lifecycle scenario runner | `pib-context-pruning-evidence-bad9.4.4` |
| T-011: Implement the isolated lifecycle performance benchmark | `pib-context-pruning-evidence-bad9.4.5` |
| T-012A: Implement deterministic teacher-forced paired replay core | `pib-context-pruning-evidence-bad9.4.6` |
| T-012B: Implement provider confirmation, retry policy, and complete usage ledger | `pib-context-pruning-evidence-bad9.4.7` |
| T-012C: Implement disposable sandbox continuation for objective task checks | `pib-context-pruning-evidence-bad9.4.8` |
| T-013: Implement blinded quality, recall, safety, and cost scoring | `pib-context-pruning-evidence-bad9.5.1` |
| T-014: Implement the exhaustive non-overridable decision engine | `pib-context-pruning-evidence-bad9.5.2` |
| T-015: Implement allowlisted reports, integrity verification, and cleanup | `pib-context-pruning-evidence-bad9.5.3` |
| T-016: Add the hermetic end-to-end evidence pipeline and project checks | `pib-context-pruning-evidence-bad9.5.4` |
| T-017: Run formal metadata inventory and freeze the first-40 sample | `pib-context-pruning-evidence-bad9.6.1` |
| T-018: Qualify and independently annotate sampled ranks 1–20 | `pib-context-pruning-evidence-bad9.6.2` |
| T-019: Qualify and independently annotate sampled ranks 21–40 | `pib-context-pruning-evidence-bad9.6.3` |
| T-020: Adjudicate qualification and freeze evaluation snapshots/protocol | `pib-context-pruning-evidence-bad9.6.4` |
| T-021: Run the pinned Pi lifecycle and performance evidence matrix | `pib-context-pruning-evidence-bad9.6.5` |
| T-022: Run confirmed paid paired replay and score all qualifying snapshots | `pib-context-pruning-evidence-bad9.6.6` |
| T-023: Produce the final aggregate report and record the owner decision | `pib-context-pruning-evidence-bad9.6.7` |

Explicit dependency edges verified: **81**. Runtime graph
`pib-pib-context-pruning-phase1-mydl` remains separate and deferred.

## 10. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-14 | Bytes | Created Draft Evidence Spike Implementation Plan from the Accepted PRD and Active Evaluation Design. |
| 2026-07-14 | Bytes | Resolved plan review: decomposed oversized storage/qualification/lifecycle/replay tasks into 29 leaves, isolated the confirmed compaction proof behind hermetic safety, promoted performance to P0, and clarified ownership/dependencies. |
| 2026-07-14 | Bytes | Closed final self-containment gaps: lifecycle evidence now depends on the private store, report cleanup reuses safety primitives, and paid compaction proof explicitly follows the hermetic gate. |
| 2026-07-14 | invoker | Activated the Evidence Spike Implementation Plan after the plan-ready-for-beads gate passed. |
| 2026-07-14 | Bytes | During bead conversion validation, split the combined T-018/T-019 dependency row so all four intended edges are encoded and machine-verifiable. |
| 2026-07-14 | Bytes | Converted the Active plan into the new `pib-context-pruning-evidence-bad9` graph and recorded the validated 36-node/81-edge trace. |
| 2026-07-14 | Bytes / invoker | Applied `context-pruning-change-001`; the baseline remains unchanged while the delta overrides affected contracts and adds four safety-ordering edges. |
