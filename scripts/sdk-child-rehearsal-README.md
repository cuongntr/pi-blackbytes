# Integration attempt — source-level containment conflict, SDK NOT RUN

The requested connected C01/C04 slice is **not delivered / not READY FOR REVIEW**.
This attempt used the task's source-level API-problem stop condition rather than
removing the driver/preload guards or claiming that public-method counters cover
ordinary SDK factory credential activity. No runtime, production, tracker, frozen
protocol, lock allowlist or parent authorization was changed. Baseline copies:
`/tmp/sdk-integration-baseline`; initial scoped diffs: `/tmp/sdk-initial.diff` and
`/tmp/sdk-initial-staged.diff`. All harness WIP ownership was accepted.

## Newly inspected conflict: offline factory probes an unenumerated ADC path

This is an incompatibility between the **current harness credential-metadata
policy** and the ordinary installed 0.83.0 factory, not a claim that a missing
synthetic ADC path contains real credentials, and not an SDK core bug finding.
The existing policy deliberately denies metadata as well as content access to
unlisted credential paths, including `.config/gcloud`. Its swallowed-denial
counter must remain authoritative. The lock amendment only admits the three
specified auth/settings lock lifecycles; it does not resolve this separate probe.

Literal **source-inspected** callgraph (not a connected harness execution claim):

```text
runSdkChildProvider
 -> public createAgentSessionServices
 -> public ModelRuntime.create
 -> actual ModelRuntime.refresh({allowNetwork:false})
 -> pi-ai Models.refresh
 -> Models.resolveRefreshCredential
 -> built-in googleVertexProvider apiKey.resolve
 -> defaultProviderAuthContext.fileExists("~/.config/gcloud/application_default_credentials.json")
 -> os.homedir() + synthetic relative suffix
 -> node:fs/promises.access
 -> instrumentFs -> createPolicy.check(path, "metadata")
 -> credential denial counter increments; throws
 -> defaultProviderAuthContext catches, returns false
 -> factory can continue, but zero-denial rehearsal receipt is impossible
```

With empty synthetic auth and scrubbed environment, the Vertex resolver checks
ADC existence **before** checking project/location. `allowNetwork:false` does not
skip API-key resolution. `PI_OFFLINE` likewise only changes model network policy.
Scrubbing HOME contains the probe to a synthetic home but does not make the current
sentinel accept that unenumerated path. Prototype instrumentation of the public
`ModelRuntime.getAuth/checkAuth` methods does not see this path: the SDK invokes
pi-ai provider resolution directly. Availability refresh also traverses providers.
This affects both requested cells before C01 request admission or C04 model lookup.

Exact installed source references (all below `node_modules/@earendil-works/`):

- `pi-coding-agent/dist/core/agent-session-services.js:58–66`: ordinary public
  service factory calls `ModelRuntime.create` with selected-home auth/models paths.
- `pi-coding-agent/dist/core/model-runtime.js:57–80`: retains builtins and runs
  offline refresh; `:152–160,373–379`: refreshes provider availability/auth.
- `pi-ai/dist/models.js:72–95,119–142`: offline refresh still resolves API-key auth.
- `pi-ai/dist/providers/google-vertex.js:4,57–66`: default ADC path and unconditional
  existence check when no configured key, before project/location checks.
- `pi-ai/dist/auth/context.js:25–38`: resolves tilde through `os.homedir`, calls
  `fs.access`, catches all errors and returns false.
- `sdk-child-rehearsal-policy.mjs`, `createPolicy.checkPath`: `protectedPath` guard
  applies to metadata too; `sdk-child-rehearsal-fs.mjs` routes `access` to it.

SHA-256 of those principal installed source files, in the same order as the four
runtime files after `agent-session-services` above:

```text
e9b24f9de85311877275f88a409bd9448f2ef31453e896cf97a06b5152dc47fc  model-runtime.js
ceb81be470cd45410f5586844b27ee65a70c474acc7eae7e8911752b5dfa7c2e  models.js
868f99d1515fb57e3a697d51c850b1073aab01f864d6be023216b183d9b4526a  google-vertex.js
5d0ea91a2fd2acf84e3b9717ce59e75006933c68d8efa91873894a9d963d41a0  auth/context.js
```

The added regression in the **existing** policy test file uses only fake filesystem
originals and existing `instrumentFs/createPolicy/modelRuntimePolicy`: an absent
synthetic ADC probe returns false, original access calls remain zero, public auth
method counts remain zero, and the filesystem credential denial count is one.
It is not SDK execution, not an actual-runtime receipt, and not an extra validator.

## Remaining disposition and execution path

Parent review must adjudicate whether a narrowly enumerated **absent synthetic
ADC metadata probe** is admissible, with realpath/absence checks and no content
read authority, or retain the current block. No permission is inferred here.
Do not inject Google credentials, replace auth context/storage/runtime, remove
builtins, suppress counters, or broaden credential read grants to get a green run.

After that disposition, the connected driver/preload/adapter work remains to be
implemented and independently R2 reviewed. Current literal harness path is still
`--inventory -> runtimeInventory` (metadata only), `--run -> requireRunnable ->
BLOCKED`, and explicit preload -> BLOCKED. **No connected launcher callgraph is
claimed.** Bound parent candidate authorization has not been created. All other
protocol variants/versions remain non-runnable and NOT RUN; no bead completion.

## Verification of this attempt (no SDK rehearsal)

- Full pure harness tests: 35 passed; actual production codec pure check: 220
  fragment splits and 5 corruption checks passed.
- `bun run check`: first attempt failed on two existing integration wait-for-
  EnabledSet timeouts (`session-start.test.ts`, `tool-result.test.ts`). An unchanged
  full rerun passed lint, typecheck, build, 1282 tests (2 Windows skips), and package
  size (194801 gzip bytes). No gate/test timeout was weakened or edited.
- Logs: `/tmp/sdk-integration-pure.log`, `/tmp/sdk-integration-codec.log`,
  `/tmp/sdk-integration-check.log`, `/tmp/sdk-integration-check-retry.log`.
- Scope: this README and one regression in the existing policy test file only.
  Driver/preload/adapter placeholders remain; this is the explicitly reported
  API/policy stop, not the requested completed integration or review authority.

---

# C01/C04 wiring continuation — partial, SDK NOT RUN

This continuation accepted parent ownership authorization for all harness WIP; no
ownership blocker exists. Snapshot/evidence: `/tmp/pib-wiring-OSopZP`. Only new
review/receipt helpers and this README changed; production, tracker, frozen docs
and prior harness implementations were preserved. **The requested complete
review-ready vertical slice is not delivered by this continuation.**

- `-review.mjs`: import-safe exact-inventory parent-review check binding candidate,
  protocol, erratum and amendment; only C01 `legacy-exact-tool-output` and C04
  `missing-model`. It requires a separately parent-controlled disposition, not
  self-authorization. It does not authenticate the source of a supplied JSON review.
- Its injected observer consumes the actual decoder interface, retains rolling
  byte canary tails, latches refusals, requires terminal/EOF/exit/close and bounded
  receipts. C01 checks supplied assistant/tool/usage/hash/recomposition/identity/
  shutdown evidence; C04 requires zero activity and nonzero unavailable exit.
  Supplied evidence is **not yet captured from actual runtime instrumentation**.
- `-review.test.mjs`: fake-original boundary tests. `-codec-check.mjs`: pure actual
  `ChildEventDecoder` fragmentation/corruption checks; no SDK or adapter import.
- Driver/preload unconditional stops and immutable NOT RUN matrix remain. Helpers
  are not yet connected to the launcher. Parent/child containment, prepared immutable
  fixture inventory, operation-specific lock interception, ordinary public-runtime
  instrumentation/request-time auth scope, authentic output/usage and stage receipts,
  and ownership/hash cleanup orchestration still need implementation and R2 review.
  No reduced DoD, runtime receipt or runnable candidate is claimed.

Future **safe verification** command (not SDK execution):

```sh
node --test scripts/sdk-child-rehearsal*.test.mjs
node --import tsx scripts/sdk-child-rehearsal-codec-check.mjs
bun run check
```

There is still no safe future SDK execution command: the launcher integration and
parent-controlled review source are absent. Do not bypass either stop. Existing
inventory continues to report BLOCKED and bind all new helper bytes automatically.

## Previous lock remediation context

# Synthetic lock policy remediation — in progress, SDK NOT RUN

Current authority: [synthetic lock amendment](../docs/plans/sdk-child-synthetic-lock-amendment.md),
recorded 2026-09-09T14:24:15+07:00 for user “Cho phép lock giả lập”. Frozen protocol
and change-002 are unchanged; the amendment resolves only the storage-lock policy
conflict. pib-2elc.2, WP pib-2elc and epic pib-idmm resume in_progress, not closed.

- `-locks.mjs`: pure exact canonical file→lock manifest and captured-original
  mkdir/mtime/stat/rmdir policy; no generic credential writes, symlink components,
  preexisting/replaced/unowned locks, descendants, unexpected files or stale takeover.
  Synthetic data hashes and closed ownership must hold; failures retain a counter.
  General `-policy.mjs` still denies direct lock access and all settings data writes.
- `-permission.mjs`: optional `lockFixture:{root,files}` adds only enumerated absent
  lock paths, never parent/home/auth/settings file write grants. The builder assumes
  reviewed canonical inputs; `-locks.mjs` enforces their filesystem identity. This is
  not yet wired into actual SDK operations; the old generic wrapper remains dormant.
- `-lock-preflight.mjs`: trusted tiny disposable program, no SDK; Node v24.18.0 exact
  new-lock-path grants verified for mkdir/stat/mtime/rmdir. Denied capabilities are
  queried, never attempted. Pre/post synthetic hashes, observed direct-child close,
  absent locks and canonical nonrecursive cleanup proved; no child capability granted.
- Sensitive source-name entries are inventoried as DENY_IF_REQUESTED without content
  reads or load authority, like unused unresolved optional edges. Symlink/special and
  required-dependency gaps remain blocking. Inventory binds amendment SHA-256 in the
  candidate hash alongside protocol/erratum; no inventory constitutes authorization.

Safe checks (no SDK sessions): `node --test scripts/sdk-child-rehearsal*.test.mjs`,
`node scripts/sdk-child-rehearsal-lock-preflight.mjs`, existing permission preflight,
syntax checks, isolated existing-Bun adapter build, inventory and `bun run check`.
Core baseline retained: 1282 pass, 2 Windows skips; not SDK proof.

## Exact next capsule wiring (implementation/review only)

1. Prepare/review one immutable synthetic fixture and exact canonical file+hash/lock
   manifest; prove no symlinks and closed process ownership. Keep selected agent-a,
   decoy agent-b denied and only enumerated checkout settings. No SDK execution yet.
2. Bind manifest plus protocol/erratum/amendment, change-001 provenance and actual
   child/adapter/preload/module hashes. Constrain parent VERSION import and exact
   launcher spawn with reviewed Node profiles, env, public-root URL/hash hooks and
   fail-closed sentinels **before** any SDK import. Integrate actual lock operations
   separately from credential data writes, forwarding receiver/args/results and
   retaining swallowed-denial counters. No storage substitution or broad FS grants.
3. Wire actual ModelRuntime prototype instrumentation before ordinary factory,
   legacy provider recomposition and captured factory/session/request identity;
   actual launcher + ChildEventDecoder C01 legacy-exact-tool-output/C04 missing-provider.
   Add bounded output-hash/usage, selected/decoy/tool/auth counts, canaries, monotonic
   shutdown→terminal→EOF/exit/close, hash/lock cleanup and ownership receipts.
4. Pure/injected/full checks and independent parent R2 review of actual immutable
   candidate first; record candidate authorization separately before any execution.
   Do not remove `--run`/preload stops in this remediation unit. Other cells/versions
   remain NOT RUN; no adoption, production changes, install or live pilot.

## Historical pre-amendment snapshot (not current lock disposition)

The following prior capsule is preserved verbatim as history; its receipt-only
blocker and “no tracker changes this unit” statements describe that previous unit.

# Managed SDK rehearsal — bounded permission/API review capsule, BLOCKED

Scope: one completion attempt within **pib-2elc.2**, not the whole bead, adoption,
C18, permanent retirement, installation or release. Parent independent R2 review
and candidate authorization remain pending. **No SDK/provider rehearsal ran.**
The approved protocol and change-002 erratum are unchanged.

## Specific ordinary-factory blocker (installed 0.83.0, source inspection only)

The requested C01 `legacy-exact-tool-output` and C04 `missing-provider` cannot
currently satisfy the receipt-only write policy using ordinary unmodified services:

1. `createAgentSessionServices` calls actual `ModelRuntime.create` with selected-home
   `authPath`; that calls `AuthStorage.create` and `reload`.
2. `FileAuthStorageBackend.withLock` always acquires `proper-lockfile.lockSync`,
   even for a pre-created empty synthetic auth file and a read-only callback.
3. `proper-lockfile` acquires `${authPath}.lock` with `mkdir`, probes/updates mtime,
   and removes the lock on release. Those are **not synthetic receipt writes**.
4. `AuthStorage.reload` swallows the lock error. This cannot grant success: a fixed
   sentinel counter must retain the violation and stop the case. A pure fake-original
   regression proves refusal even when the caller catches the exception.
5. Pre-created settings have the same lock-directory issue in
   `FileSettingsStorage.withLock`. Precreating a lock does not solve acquisition.

This is an API/policy incompatibility, not an absent Node permission capability.
No lock-write grants, storage replacement, copied runtime, redirected lock,
in-memory auth substitution, skipped sentinel or alternate SDK installation was
introduced to work around it. C01/C04 remain **not runnable / NOT RUN**. There is
no complete vertical-slice candidate and no whole-cell PASS.

## Architecture and implemented safe subset

- Node **v24.18.0** local `--help` confirms `--permission`, `--allow-fs-read`,
  `--allow-fs-write`, and opt-in child/worker/addon/WASI permissions.
  `sdk-child-rehearsal-permission.mjs` runs only a tiny trusted disposable program
  with scrubbed empty env, exact program read and synthetic receipt-file write
  grants. Eleven `process.permission.has` checks passed; it attempts no forbidden
  operation, network, credential access, service, SDK import or session.
- Pure permission argument profiles deny nested child/worker/addon/WASI/inspector
  for `sdk-provider`; `launcher-parent` only adds child permission and still requires
  a reviewed exact-spawn sentinel. These are policy builders, **not wired authority**.
  Actual launcher integration, contained parent VERSION import, canonical manifest
  validation and environment validation remain blocked, not claimed complete.
- Stop building a generic JavaScript filesystem sandbox. The approved architecture
  is the Node permission backstop plus exact reviewed fixture/module hashes and
  narrow operation sentinels. Existing `-fs.mjs` remains dormant with its fake-original
  regressions; it is not coverage proof or a reason to broaden grants.
- Public ModelRuntime policy now allows only explicitly offline factory refresh;
  admission getAuth/checkAuth/refresh stay forbidden. Request-time getAuth requires
  the captured selected literal object (`fixture-selected`, `literal/slash:high`),
  no replacement/string overload or credential/env override. Undefined apiKey/env
  data fields used by public prepareRequest are allowed. Counters have fixed keys.
  Login/logout/key mutation stay blocked. The injectable prototype installer forwards
  the original receiver/arguments/result unchanged. It is pure-tested but **not yet
  installed on the actual SDK prototype before factory**; the preload remains stopped.
- Missing declared optional/platform or optional-peer dependencies are inventoried
  as `DENY_IF_REQUESTED` unresolved edges, not global closure gaps. An actual unresolved
  module request blocks without a second resolution/install. Required missing deps,
  symlinks and sensitive/special package files still cause gaps. Synchronous hooks
  retain exact canonical URL/hash checks at resolution and load. Reviewed preload,
  fixture and public-root URL closure still needs runtime integration.
- The existing isolated adapter imports the actual `launchManagedSdkChild` and exports
  the actual `ChildEventDecoder`; its old preload-only spawn seam remains unarmed.
  No production launcher/provider/model-authority code changed. Pure/injected core
  launcher, codec and provider tests are included in the full repository check.

The driver `--run` and preload both retain unconditional stops. **Do not remove them
on pure-test success.** Parent review must first adjudicate the specific storage
blocker within the approved boundary, then independently review an actually complete
candidate and record authorization. No unsafe SDK smoke test is needed to establish
this source-derived blocker.

## Reproducible safe verification

```sh
OUT=$(mktemp -d /tmp/pib-harness-review-XXXXXX)
node --version
node --help > "$OUT/node-help.txt"
node scripts/sdk-child-rehearsal-permission.mjs > "$OUT/permission-preflight.json"
node --test scripts/sdk-child-rehearsal-policy.test.mjs scripts/sdk-child-rehearsal-permission.test.mjs > "$OUT/pure-tests.log" 2>&1
for file in scripts/sdk-child-rehearsal*.mjs; do node --check "$file" || exit; done
bun build scripts/sdk-child-rehearsal-adapter.ts --outfile "$OUT/adapter.mjs" --target node --packages external
bun run check > "$OUT/check.log" 2>&1
node --experimental-import-meta-resolve scripts/sdk-child-rehearsal.mjs --inventory "$PWD/dist/sdk-child.js" "$OUT/adapter.mjs" > "$OUT/inventory.json"
node scripts/sdk-child-rehearsal.mjs --matrix > "$OUT/matrix.json"
```

Build is not adapter import/execution. Inventory hashes package ordinary files and
public roots without SDK import; sensitive contents are never read. No real settings,
auth or trust paths are read. Runtime pre/post synthetic fixture hashes, selected/
decoy/tool and session/request identity counts, new-output hash/usage, monotonic
shutdown/terminal/EOF/exit/close, rolling canary checks and <=8192-byte case receipts
remain **absent**, not source-derived runtime evidence. No fixture was prepared.
All other variants remain explicitly not runnable / NOT RUN in the immutable matrix.
0.85.1 and Windows remain NOT RUN; no alternate lookup or install.

Current evidence capsule: `/tmp/pib-harness-permission-5W0OY5/README.md` contains
baseline snapshot, scoped delta, actual inventory/hash summary and verification.
There is deliberately **no executable future SDK command** until the blocker is
resolved and parent R2 review plus immutable candidate authorization are recorded.
No tracker/commit/docs-baseline/closed-work mutation is part of this unit.
