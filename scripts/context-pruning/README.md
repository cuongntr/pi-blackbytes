# Context-Pruning Evidence Harness

This directory contains the local-only Phase 1 evidence harness. It is intentionally outside `src/`,
is not imported by the extension entry point, and is excluded from the published package. It must not
register Pi hooks, tools, commands, configuration, or runtime compression behavior.

## CLI

Run the dispatcher through the fixed package entry point:

```bash
bun run evidence:context-pruning -- --help
bun run evidence:context-pruning -- <command> [options]
```

The formal T-017 prerequisite implements the local-only sequence `init`, `inventory`, `sample`,
`select-target`, and `verify` (without `--input`). It uses only the explicit approved source root,
private evidence artifacts, and content-free stdout records; it makes no provider call. `verify --input`
retains the T-015 report-input verification behavior. Other known stages may still return a JSON
`E_EVAL_INCOMPLETE` error. Missing or unknown commands return `E_EVAL_CONFIG`.

The formal sequence accepts only its documented exact options: `init --run-id <id> --config <file>`,
`inventory --run-id <id> --source-root <root>`, `sample --run-id <id>`, and
`select-target --run-id <id> --target <file>`; each optionally accepts `--pi-agent-dir <path>`.
`verify --run-id <id>` validates the persisted terminal state. Unknown, duplicate, or missing options
fail closed. Do not run it against a real corpus without the owner-approved command parameters.

Provider-backed commands added by later beads must first produce a `--dry-run` plan digest and require
an exact `--confirm <digest>`; `--decline <digest>` records refusal without an external call.
`--not-applicable <upstream-hard-stop-digest>` is reserved for a verified upstream hard-stop.

### Terminal T-009B hard-stop

After a verified same-run T-009B resolution reports `blocking-incomplete`, do not open sampled
content, run lifecycle/Pi processes, score, or replay. T-018 and T-019 are two distinct authenticated
qualification records, so record both exact rank batches plus adjudication, freeze, lifecycle, and replay
with the exact `resolutionDigest` emitted by T-009B, then derive the sole terminal decision and reports:

```bash
bun run evidence:context-pruning -- qualify --run-id <id> --pi-agent-dir <path> --ranks 1-20 --not-applicable <t009b-resolution-digest>
bun run evidence:context-pruning -- qualify --run-id <id> --pi-agent-dir <path> --ranks 21-40 --not-applicable <t009b-resolution-digest>
bun run evidence:context-pruning -- adjudicate --run-id <id> --pi-agent-dir <path> --not-applicable <t009b-resolution-digest>
bun run evidence:context-pruning -- freeze --run-id <id> --pi-agent-dir <path> --not-applicable <t009b-resolution-digest>
bun run evidence:context-pruning -- lifecycle --run-id <id> --pi-agent-dir <path> --not-applicable <t009b-resolution-digest>
bun run evidence:context-pruning -- replay --run-id <id> --pi-agent-dir <path> --not-applicable <t009b-resolution-digest>
bun run evidence:context-pruning -- decide --run-id <id> --pi-agent-dir <path>
bun run evidence:context-pruning -- report --run-id <id> --pi-agent-dir <path>
bun run evidence:context-pruning -- verify --run-id <id> --pi-agent-dir <path>
```

Every disposition re-authenticates the immutable formal target anchor, verified run manifest identity,
private proof inputs, durable ledger, and exact same-run `blocking-incomplete` resolution before writing.
Its closed schema is corpus-key HMAC authenticated over the run, stage, qualification range, target, and
resolution binding. Unknown or duplicate options, duplicate dispositions, a wrong/cross-run digest,
missing upstream proof, and any attempt to pass an input, provider, adapter, or subprocess option fail
closed. Once the blocker exists, every ordinary run-bound qualification, adjudication, freeze, lifecycle,
replay, score, report, and verify mode fails before it opens an input or loads an adapter; only the exact
commands above are permitted. `decide` accepts no override and persists exactly one mechanically derived
`NO-GO`: G001–G004 are explicitly unavailable/blocked by T-009B, not fabricated observations, and its
trace records each threshold. Report publication is interruption-resumable: an identical existing sibling
is accepted, a conflicting sibling is rejected, and a missing sibling is published. The terminal report has
no source checks or observations: all inapplicable metrics are suppressed, while the committed-safe
aggregate contains no local identifiers, paths, or content.

For completed formal runs, `report` additionally appends the immutable canonical
`terminal-hard-stop/report-supplement-v1.json`; it never rewrites `decision.json`, `report.local.json`,
or `report.aggregate.json`. The supplement revalidates only persisted structural T-017 inventory/sample/
target bindings, then records safe aggregate counts, the passed first-40 sample count, and the still-blocked
qualification/applicability evidence. Nonzero subgroup counts below five and dominant-repository details
backed by fewer than five sessions are represented as suppressed `null` values. Its stdout candidate
adds the identifier-free `corpusSummary` in memory only; the existing aggregate report remains unchanged. `verify` returns `nextStage: "report"` when
legacy primary reports are valid but this supplement is absent, so they can be upgraded append-only. No
source session, selected copy, provider, or subprocess is opened by this upgrade.

T-009B adds the exact owner-facing, generated-only sequence (the default Pi agent directory is used
when `--pi-agent-dir` is omitted):

```bash
bun run evidence:context-pruning -- lifecycle --run-id <id> --scenario compaction-accounting --dry-run
bun run evidence:context-pruning -- lifecycle --run-id <id> --scenario compaction-accounting --decline <plan-digest>
# Only after owner approval; no adapter is discovered by default.
bun run evidence:context-pruning -- lifecycle --run-id <id> --scenario compaction-accounting --confirm <plan-digest> --adapter-module <local-path>
```

Dry-run is adapter-free and writes nothing. It emits only the frozen target tuple, generated-only input
declaration/digest, planned calls, one-retry maximum, upper cost, policy/proof/environment digests, and
the exact confirmation/plan digest. Decline writes a content-free blocking resolution plus a
plan-bound decline disposition and makes zero calls. Confirm rederives the same plan before loading the
explicit local module, which must export `GeneratedCompactionProofAdapter`; there is no configured,
default, or provider adapter lookup.

Before dry-run, a local setup may call the exported `prepareT009BPrivateInputs()` with the already
verified target, full provider policy, generated-proof policy, and environment declaration. It can write
only these immutable SafeRun paths: `private/t009b-compaction-accounting/provider-policy.json`,
`private/t009b-compaction-accounting/proof-policy.json`, and
`private/t009b-compaction-accounting/environment.json`. The policy digest must exactly equal the target
record's `providerPolicyDigest`; changing any prepared input fails closed. `verify --run-id <id>` remains
a valid T-017 check before T-009B and, after a persisted T-009B result, additionally returns the
content-free `compactionAccounting` outcome.

The `lifecycle` entry otherwise remains an opt-in T-021 handoff, not evidence that the real matrix ran. It requires
`--opt-in`, separate protocol pins and local installation paths in `--metadata`, a verified private
run, `--attempt-id`, and `--event-timestamp`. T-010B validates both pinned packages, binaries, and
`--version` probes before stopping with `E_EVAL_INCOMPLETE`; T-021 alone supplies the real isolated
subprocess executor and copied-session scenarios.

`bun run bench:context-pruning-lifecycle -- --opt-in` is the separate T-021 performance handoff. The
parameterized runner records fixed 100-warmup/1,000-measurement per-fixture results in
`benchmarks.jsonl`, including cold start, nearest-rank p50/p95/max, no-op-adjusted overhead, and the
maximum per-fixture absolute-p95 gate. T-011 hermetic tests use generated fixtures and mocked process
metadata only; they never execute or claim the real benchmark.

## Error contract

Errors are a single JSON object on stderr:

```json
{"code":"E_EVAL_INCOMPLETE","message":"Command 'inventory' is not yet implemented in T-001."}
```

The allowed `E_EVAL_*` codes and versioned core interfaces live in `types.ts`. Canonical records use
`canonicalJson()` and `canonicalDigest()`; unsupported values fail with `E_EVAL_SCHEMA` rather than
being silently coerced.

## Tests

`bun run test` discovers normal `*.test.ts` files in `scripts/context-pruning/` and sets
`EVIDENCE_HERMETIC_TESTS=1`. Standard tests must remain generated-fixture-only and must not use a
provider, real session corpus, external Pi installation, or repository fixture.

Opt-in tests are excluded when either condition holds:

- the filename ends with `*.opt-in.test.ts`; or
- the file is under a directory named `__opt_in__`.

Run an opt-in test only after reviewing its content and required confirmations:

```bash
node --import tsx --test scripts/context-pruning/path/to/example.opt-in.test.ts
```

Never represent an opt-in test as part of `bun run test` or `bun run check`.

## Verification

```bash
bun run typecheck
bun run test
bun run build
bun run check:size
bun run check
```

The build and package-size checks must continue to operate only on the production extension rooted at
`src/index.ts`.

## Private evidence store (`evidence-store.ts`)

T-002A provides the private run store for all evidence artifacts. It is a standalone module with
no production imports and no provider/session access.

### Capability-confined run roots

`ensurePrivateRunRoot(piAgentDir, runId)` from `path-safety.ts` creates the canonical `0700` tree and
returns an opaque, runtime-registered `PreManifestRun`. `loadOrCreateCorpusKey(preRun)` and
`atomicManifestWrite(preRun, manifest)` initialize fixed `0600` artifacts without accepting raw paths.
`openSafeRun(piAgentDir, runId)` then verifies the canonical exact-schema manifest, actual private key
digest, root identity, and every evidence-root component before returning an opaque `SafeRun`.
Forged handles, traversal, globs, symlinks, special files, device crossings, and unknown runs fail closed.

### Corpus keys, manifests, and events

- `loadOrCreateCorpusKey(preRun)` atomically publishes or resumes `corpus.key`; concurrent creators
  converge without overwrite. The raw key is forbidden from manifests, events, reports, and logs.
- `corpusKeyDigest(key)` and `hmacDigest(key, sourceBytes)` validate and decode the 32-byte
  lowercase-hex key. HMAC inputs are source bytes, never source paths.
- `atomicManifestWrite(run, manifest)` accepts only a registered pre-manifest or verified run handle,
  uses canonical JSON plus fsynced temp/rename, and preserves prior bytes on before-rename failure.
- `appendEvent(safeRun, relativePath, event)` and `loadExistingEventIds(safeRun, relativePath)` accept
  only a verified run and validated relative paths. JSONL is canonical, append-only, serialized per
  path, resume-hardened to `0600`, and fail-closed on corruption, duplicate IDs, or ID/content drift.

### Source integrity and cleanup

`createSourceGuard(sourcePath, corpusKey)` opens the source read-only with `O_NOFOLLOW`, streams HMAC
from that descriptor, checks identity before/after, and returns only path-free digest evidence.
`verifySourceIntegrity(guard)` reuses its private stored path and returns matching after evidence; any
mutation, replacement, retarget, or digest mismatch raises `E_EVAL_INTEGRITY` without path leakage.

Cleanup scans only verified run descendants. It rejects symlinks, hardlinks, special files, mounts, and
identity drift; produces a deterministic HMAC-sealed canonical manifest; and requires exact run-ID plus
plan-digest confirmation. Execution performs a complete no-delete preflight, then unlinks/rmdirs only
the sealed leaf-first targets, control manifest, and run root. It never uses recursive removal, force,
globs, or caller-selected absolute paths. Deletion is not transactional after preflight, and Node cannot
fully eliminate a malicious same-user parent-swap race; both limitations are explicit and fail-closed
where detectable. Dry-run target names remain private local output and are never committed.

### Artifact layout (under the run root)

```text
<run-root>/
├── corpus.key              # Raw private key, 0600, local-only and never exported
├── manifest.json           # Canonical manifest with corpusKeyDigest only
├── cleanup-manifest.json   # Canonical HMAC-sealed relative cleanup plan
└── events.jsonl            # Append-only canonical evidence events
```

`RunManifest`, `EvidenceEvent`, and source evidence contain no source path or raw corpus-key field.
