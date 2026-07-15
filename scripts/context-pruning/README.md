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

T-001 exposes the complete command vocabulary but does not implement evidence stages yet. A known
stage returns a JSON `E_EVAL_INCOMPLETE` error on stderr with a non-zero exit code. A missing or unknown
command returns `E_EVAL_CONFIG`. Only `--help` exits successfully. No stub reads session content,
contacts a provider, or deletes data.

Provider-backed commands added by later beads must first produce a `--dry-run` plan digest and require
an exact `--confirm <digest>`; `--decline <digest>` records refusal without an external call.
`--not-applicable <upstream-hard-stop-digest>` is reserved for a verified upstream hard-stop.

The `lifecycle` entry is an opt-in T-021 handoff, not evidence that the real matrix ran. It requires
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
