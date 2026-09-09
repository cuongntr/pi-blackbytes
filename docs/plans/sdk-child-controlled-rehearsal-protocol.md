# Managed SDK child v1 contract and controlled synthetic rehearsal proposal

Bead: `pib-2elc.1`. Sole requirements source: full `br show pib-2elc.1`.

**Disposition: APPROVED protocol by invoker (2026-09-09). Execution: NOT RUN.**
The invoker selected “Duyệt protocol (Recommended)” after the isolation, fake-provider,
no-network/install/real-credential boundaries and budgets were summarized. This permits
contract handoff and subsequent launcher implementation. Execution still requires the
reviewed immutable launcher/fixture candidate and its revision to be recorded below;
no live pilot, installation, real provider use, or release is authorized.
Independent R2 contract review completed; callback error classification and status
stage validation findings were fixed. Parent verification: 1021 passed, 2 Windows-only
skipped, zero failures; gzip 185996 bytes. No SDK rehearsal ran in this contract atom.

## Published private contract

`src/sub-agents/sdk-child-protocol.ts` is unadopted; nothing imports it from the
production entry point. Public delegate arguments and `types.ts` remain unchanged.
The transport schema is Blackbytes-owned, not a copy of permissive Pi JSON events.

### Stdin setup

Wire grammar: canonical ASCII decimal nonnegative safe integer, LF, exactly that
many UTF-8 bytes containing one JSON document, EOF. Decimal has no sign, leading
zero (except `0`), spaces, CR, exponent, or fraction. Sixteen digits derives from
`Number.MAX_SAFE_INTEGER`, not a prompt budget. Zero length is valid framing but
not valid JSON. A BOM, malformed UTF-8, second JSON document, overrun, truncation,
unsupported version, unknown fields, or expired deadline rejects setup. JSON
whitespace is legal within the declared body. No fixed prompt/body length cap and
no allocation of the declared size before bytes arrive. Reads stop and the source
is destroyed on rejection/deadline, including a silent sender or missing EOF.
The incremental decoder's caller must stop its source on throw; the Node pipe
adapter does so. Neither helper logs input or schema error details.

The v1 body contains only protocol/expected installed SDK versions, literal
`model:{provider,id}`, optional `requestedThinking`, normalized absolute `cwd` and
`agentDir`, captured boolean `projectTrusted`, finalized unique nonempty
`allowedTools` excluding `delegate_*`, `systemPrompt`, `userPrompt`, and positive
safe-integer `remainingMs`. Expected SDK version is setup negotiation metadata,
not a model selector. No credentials, model object, parent context/thinking,
resource inventory, or environment object. Prompts remain text (even path-like
text). No selector reparsing or prompt logging/persistence. Requested thinking
uses existing supported Blackbytes levels, not a new public input.

Capture parent cwd/trust/home/model/config/deadline synchronously at execute entry.
Queue, prompt-family build, lookup, startup and each eligible read-only fallback
consume that same deadline. Serialize remaining time only immediately before
launch; parent remains authoritative and never renews its deadline. The decoder
accepts an absolute local deadline, not a duration to restart on each chunk.
A late completion has no launch authority. Nothing informs workers about scarcity.

### fd 3 events

Only fd 3 carries protocol; stdout/stderr are bounded redacted diagnostic tails.
Every record is strict UTF-8 JSON plus LF, v1, at most 8192 bytes **including LF**,
derived conservatively from existing runner/progress 8192-character stream budgets.
Partial tails never grow past that budget. There is no total event/output limit.
`chunkChildDelta` splits supported text safely across frames, preserving Unicode
and JSON escapes. A consumer must process incrementally, not accumulate all events.
Schemas reject unknown fields; no full raw messages, tool args/results, queue
prompts, provider headers, model objects or registry dumps are permitted.

| Discriminant | Meaning for later consumer |
| --- | --- |
| `session` | Minimal ephemeral session header; no transcript path/cwd dump |
| `status` | `stage:version`/`stage:admitted` forbid `code`; `stage:warning` requires `code:resource_warning`; no free-text status |
| `model` | Bounded/redacted reported provider/id for display, never admission proof |
| `progress` | Agent/turn/message start/end; raw `agent_end` is progress only |
| `delta:text`, `delta:thinking` | Redacted live preview deltas, same existing UI meaning |
| `delta:output` | Selected successful worker return text chunks, byte-preserved; never append preview a second time |
| `tool` | Call/start/update/end, redacted name/call ID and optional <=50-character summary/error flag; no raw argument or result data |
| `usage` | Per-completed-assistant-message usage (input/output/total/cost), emitted once and accumulated by consumer |
| `terminal` | Launcher-only success/failure and child cleanup evidence |

Output chunks correspond to the existing runner's selected final assistant text,
not every intermediate message or a duplicated raw event stream. The eventual
normalizer owns this selection and the preview/output distinction. Non-output
strings must be redacted **before encoding**; codec validation is not a redactor.
Oversized metadata is redacted and bounded by the producer before encoding, not
silently accepted. Successful text can be sensitive. Parent preserves 24576-char
tail-preserving return cap, opt-in redacted 512 KiB artifacts, seven-day retention,
best-effort capture, and no envelope/transcript persistence. WP-005's unverified
prefix remains outside the return cap. These existing policies are not implemented
or changed here.

Exactly one terminal is required before protocol EOF, with no later bytes/records.
No raw SDK event can terminate a successful attempt. A success terminal requires
closed gate, idle runs, disposed runtime, and false refusal latch. Failed setup can
honestly report incomplete cleanup; it cannot claim success. Failure code/kind
pairs are validated: tool mismatch -> `invalid_tool_allowlist`; unavailable or
identity mismatch -> `provider_or_model_unavailable`; version/capability/setup/
protocol initialization/gate/ownership/replacement/runtime -> `failed`;
cancellation/timeout/external signal retain `cancelled`/`timed_out`/`killed`.
Resource warnings are not terminal failure codes. Required postconditions, not
unrelated resource diagnostics or stderr regexes, determine classification.
Parent maps malformed/missing/duplicate terminal or corrupt fd 3 to
`malformed_jsonl`; entry/import/spawn failure to `spawn_error`. Consumer callback
exceptions stop decoding and clear retained state but propagate unchanged, never
as wire corruption. Other legacy
failure kinds remain parent-owned classifications; they are not fabricated child
terminals. The public taxonomy is unchanged.

### Settlement is not verification or descendant reaping

Child reports its own gate/run/disposal state; it cannot report its own observed
process close or promise a flush that has not yet completed. Parent records
`ManagedSettlement`: observed direct-child close (`reaped:true`), exit/signal,
complete protocol EOF/validity and validated terminal. Process success requires
all of: success terminal/no latch, exit 0/no signal, complete valid protocol flush
as observed through EOF, and observed child close. It is **not task verification**.

Parent cancellation sends TERM to the Linux detached process group (Windows:
direct child), KILL after 100ms if needed, and observes close and pipe settlement
within the existing 5000ms drain. Grace expiry alone is never reaping. No close by
drain cap returns original cancelled/timed_out/killed with `reaped:false` and
`writerRetired:true`. WP-003/adoption must permanently retire that parent writer
controller across late close, reset/reload and generations; only a fresh parent
lifecycle recovers. This schema exposes the obligation but implements no barrier.
Direct child close proves nothing about all descendants. Never release a writer
at raw `agent_end` or initial abort. Cleanup cannot extend parent launch authority.

## Public SDK API/trust/lifecycle review basis (source inspection only)

Installed package inspected: `@earendil-works/pi-coding-agent` **0.83.0**, public
root exports with ESM `import` condition (`package.json:1–22`). Package authority
remains Node >=22.19.0 and Pi >=0.83.0 <1. No 0.85.1 installation or runtime matrix
was executed. Do not claim host/child equality or 0.85.1 runtime proof.

Installed docs read in full: `docs/sdk.md`, `docs/security.md`,
`docs/environment-variables.md`, `docs/json.md`, `docs/custom-provider.md`, and
`docs/packages.md` under `node_modules/@earendil-works/pi-coding-agent/`.
Public declaration references below describe exports reached through the public
root; **they are inspection citations, never authorization for production internal
imports**. Contract code has no SDK runtime import.

- Q-01 exact child setup: public `createAgentSessionServices` and
  `createAgentSessionFromServices` exports (`dist/index.d.ts:18`;
  `dist/core/agent-session-services.d.ts`, complete interfaces). Supply captured
  `SettingsManager.create(cwd,agentDir,{projectTrusted})`
  (`dist/core/settings-manager.d.ts:110,147`); omit `resolveProjectTrust`.
  SDK doc's short two-argument settings example omits this public third option.
  Parent-active false/true wins saved/global/default child decisions without
  remember/write/grant semantics. No private trust helper or forced trusted path.
  `docs/security.md#project-trust` distinguishes input-loading trust from a sandbox.
- Q-02 resources/model: services normally load resources; factories register
  providers before lookup (`docs/custom-provider.md#quick-reference`,
  `#register-new-provider`). Do not disable all extensions or transfer parent
  registrations. Public `ModelRuntime.getModel`, `getModels`,
  `getAvailableSnapshot`, `hasConfiguredAuth` (`dist/core/model-runtime.d.ts`)
  supply literal membership, exact object and cached auth/availability evidence.
  No additional getAuth/checkAuth/refresh admission probes. Pass **that object**
  to the exact-model factory; same tuple/new object is not equal. Home aliases,
  settings, models/auth/model-store all stay in normalized selected home with no
  default search/install. Missing parent-only provider gets fixed selected-home/
  restart guidance, not a registry dump. `docs/packages.md#install-and-manage`
  warns normal startup may install missing packages: rehearsal fixtures must
  already exist and sentinels must be armed before resources load.
- Q-03 guard: public `AgentSession.subscribe`, `agent.streamFunction`,
  `bindExtensions`, `waitForIdle`, `getActiveToolNames` (SDK doc AgentSession,
  Agent and Events; `dist/core/agent-session.d.ts:311,441,513`; public
  pi-agent-core `dist/agent.d.ts:38` declares `streamFunction: StreamFn`). Install CLOSED
  owned wrapper and subscription **before** bindExtensions({mode:"json",...});
  await startup/resources_discover and initiated runs. Refusal permanently latches;
  return public pi-ai `createAssistantMessageEventStream` with terminal error event
  and completed error result, never throw/reject or call original on refusal
  (`docs/custom-provider.md#stream-pattern`; pi-ai
  `dist/utils/event-stream.d.ts:20`, re-exported by public root `dist/index.d.ts:27`).
  Unexpected checks fail through that same error stream. Open only after model
  object/registry/tuple/cached auth/tool postconditions. Recheck all before every
  forwarded request; forward original arguments unchanged. Never reset a mutated
  model, clear latch on handled input/error/later success, or fabricate agent_end.
  Guard guarantees only requests through the still-owned wrapper, not arbitrary
  trusted-extension direct calls, wrapper replacement, provider-request payload
  rewrite, upstream routing or same-object endpoint mutation. ctx.shutdown is not
  a veto; throwing hooks can be swallowed.
- Q-04 lifetime: public `SessionManager.inMemory(cwd)` and loader options
  `noContextFiles:true`, `systemPromptOverride:()=>text`
  (`docs/sdk.md#system-prompt`, `#session-management`;
  `dist/core/resource-loader.d.ts:81,117`). Keep APPEND_SYSTEM.md, skills/templates
  and extension transformations. Exact explicit tools include late registration/
  activation, no defaults/delegates. Requested effort precedence remains agent >
  recognized parent-resolved suffix > omitted Pi default; no parent thinking or
  literal slash/colon reparsing. Capability clamping/defaults are Pi-owned.
  Public `createAgentSessionRuntime`/`runtime.dispose():Promise<void>`
  (`dist/core/agent-session-runtime.d.ts`, SDK runtime section) owns shutdown;
  session.dispose alone is insufficient (installed runtime implementation
  `dist/core/agent-session-runtime.js:288–290` emits `session_shutdown`).
  Close gate, abort/wait runs, await runtime
  disposal/session_shutdown before terminal; try/finally owns unsubscribe, fd 3
  flush and nonzero failure exit. Refuse replacement/reload rather than construct
  a persistent or unguarded replacement. inMemory prohibits transcript/resume,
  not every artifact/settings/extension write.

Later launcher resolves installed public SDK root relative to Blackbytes using
ESM import conditions, compares public VERSION/capabilities before resources, and
resolves public pi-ai relative to that SDK installation. Absolute installed
`dist/sdk-child.js` runs with `process.execPath`, no shell/PATH/TS loader/internal
imports/alternate installation search. Allowed inherited env is only PATH, HOME,
USER, SHELL, TERM, NODE_ENV plus generated normalized home aliases, nested depth 1,
and SDK-version-appropriate PI_CODING_AGENT/AI_AGENT markers (installed 0.83 doc
explicitly documents PI_CODING_AGENT=true, not AI_AGENT; later adapter must check
its installed version). No provider secrets, NODE_OPTIONS or proxies. The separate
child build/packaging remains later work, as do readonly-only eligible fallback
and registered adoption. Internal chain/direct PATH-based runner stays unchanged.

## Proposed controlled synthetic rehearsal — approval required before execution

### Resources and authority

Invoker must approve a specific immutable candidate diff/build and this protocol
revision, name executor/reviewer, authorize fixture preparation/execution, and
identify pre-existing installed SDK roots (0.83.0 and, only if already available,
0.85.1). Missing versions stay **not run**; no installation or alternative lookup.
Inventory/hashes and disposable paths must be recorded before each authorized run.

Proposed isolated root: one `mkdtemp` directory `bb-sdk-rehearsal-*` under the OS
temp directory, containing `os-home/`, `agent-a/`, `agent-b/`, `checkout/`,
`fixture-package/`, `sentinel-bin/`, and `receipts/`. These fixture resources are
prepared and reviewed **before launcher startup**, not dynamically installed by
Pi. Use synthetic settings/models/trust entries and reviewed local JS extensions
only; no copied real home, auth, credential files, third-party packages or agent
transcripts. HOME is the disposable os-home; both agent aliases select agent-a.
agent-b contains a canary model/default/trust decision that must never be consumed.
The fixture package is referenced by pre-existing absolute local path only;
reject npm/git/URL sources, absent resources and unreviewed symlinks at preflight.

Fake provider `fixture-selected` registers `literal/slash:high`; a second fake
`fixture-decoy` provides the wrong-model counterexample. Both use a deterministic
in-process stream and zero-cost usage, never an HTTP endpoint. Fake tools
`fixture_read` and `fixture_write` increment per-case counters in memory and write
only synthetic counter receipts under the disposable root. No real credentials:
use the documented custom stream registration with a literal synthetic fixture
key (no environment interpolation or command resolution) to establish configured
auth without a real service. Only reads of pre-created empty synthetic auth files
under the fixture homes are allowed and counted; any real/out-of-root credential
read, credential write/login/logout/refresh or credential command is a stop.
Expected factory availability calculations must be distinguished from prohibited
extra admission probes; record method counters, not auth values.

Arm sentinels before SDK imports/resources: network calls (fetch/http/https/net/
tls/dns), package-manager/git commands, credential operations/command resolution,
and filesystem access outside fixture roots plus the approved read-only installed
SDK/dependency roots. Instrumentation is controlled-test evidence, **not a product
sandbox**. Only fixture child/descendant processes are spawn-allowlisted; command
args and env are not logged. Sentinel wrappers must fail closed and increment
fixed-name counts. Do not inherit NODE_OPTIONS to inject instrumentation: use the
explicit approved harness. If sentinels cannot cover the required path, BLOCK that
cell rather than run with weaker protection. No network, install or credential
sentinel smoke test may perform the forbidden operation itself.

### Cases and expected receipts (all NOT RUN)

| Cell | Controlled action | Required result |
| --- | --- | --- |
| C01 | Exact model, one fake tool, complete output/usage | Selected counter >0, decoy=0, exact tools, one success terminal, shutdown before terminal, EOF/exit0/close |
| C02 | Parent true vs child saved false/global never; parent false vs saved true/global always | Parent boolean controls project factory/tool discovery; trust file hashes unchanged; no grant writes |
| C03 | Selected home A vs decoy B/default home | Only A resource/model/auth-store paths observed; no fallback search or parent provider transfer |
| C04 | Missing model/provider, unavailable snapshot, missing configured auth | No original stream call; provider_or_model_unavailable; no admission auth probe |
| C05 | Factory registers model; session_start/resources_discover initiates a run while closed | Nonthrowing completed error stream, original counter=0, permanent refusal despite handled input/later success |
| C06 | Startup or before-request tuple mutation, same-tuple replacement, registry replacement, wrapper ownership loss | Latched refusal with required classification; never repair model; decoy=0 for still-guarded paths |
| C07 | Late tool add/remove/activation or delegate tool | invalid_tool_allowlist before forwarding; no implicit defaults |
| C08 | Literal slash/colon and effort explicit/suffix/omitted | Exact tuple preserved; child capability/default behavior measured separately per installed version |
| C09 | Path-like system text, AGENTS/APPEND, template/skill, extension transformations | No context files, text override not file read; approved ambient append/transform behavior retained; no parent transcript |
| C10 | Version/capability mismatch, missing/import-failed entry, setup throw, unrelated resource warning | Required failed/spawn_error taxonomy, fixed bounded diagnostics; warning alone not fatal |
| C11 | Wrong stdin length/UTF8/version, fragments, slow body/EOF; fd3 corruption/oversize/duplicate/missing terminal; noisy stdout/stderr | Stop deadline/overrun; malformed_jsonl only on event corruption; stdout/stderr never protocol, no private canaries in diagnostics |
| C12 | Raw agent_end followed by queued work/shutdown throw | No premature success or writer release; terminal only after settlement; failure stays failure |
| C13 | Cancel during factory/auth/startup/prompt/queue/disposal | Same execute-entry deadline, no late launch authority; original cancelled retained, orderly abort/dispose where possible |
| C14 | Cooperative TERM then ignored TERM | TERM group on Linux; KILL after 100ms if necessary; close/pipe settlement observed within 5000ms drain |
| C15 | Inject stalled close notification past drain, then deliver late close/reset/reload | reaped:false + permanent writer retirement; original timeout/cancel/signal preserved; no new writer even after late close |
| C16 | Fixture descendant holds pipe; another descendant outlives direct child | Pipe/close evidence correctly distinguished, no assertion that all descendants are reaped; cleanup kills only recorded fixture descendants |
| C17 | Replacement/new/resume/fork/import/reload request | Latched failed; no replacement session/transcript or unguarded factory |
| C18 | Read-only eligible unavailable fallback with little remaining time; writer unavailable | Shared remaining deadline and repeated admission/prompt family; zero writer retries; no CLI fallback |
| C19 | Long escaped/Unicode success + private diagnostic canaries | Successful text preserved within existing cap; bounded redacted progress/artifacts/diagnostics; no envelope/transcript persistence |
| C20 | Windows direct-child fallback (only if pre-existing approved Windows environment) | Direct-child signal/close evidence; otherwise not run, never infer from Linux |

C15 is an explicit controllable observer seam test, not a claim that grace expiry
or a stubbed close equals actual OS reaping. C16 uses only recorded disposable
fixture descendants; no signal to unrelated processes. C18 and permanent barrier
execution require their later provider/adoption/WP-003 candidates and authority,
not a contract-only mock presented as delivery proof.

### Budgets, stops, receipts and cleanup

Proposal: one case at a time, <=10 seconds execute-entry budget per case plus the
existing <=5000ms drain (not additional launch authority), <=20 minutes wall time
for a version suite, no retry of failed safety cells. Invoker may narrow these.
TERM/KILL timing fixtures use monotonic timestamps with documented scheduling
tolerance; do not widen production deadlines to make tests pass.

Immediately stop the suite on any network/install/forbidden-credential sentinel, unexpected
provider/tool call, access outside allowed roots, prompt/credential/registry dump,
untracked process, false success, missing cleanup evidence, or inability to enforce
the boundary. Revoke launch authority and terminate only recorded fixture process
groups/children. Preserve original failure classification; report blocked/not run
cells without trying an alternate real provider/home or installing a version.

Receipts: per-case ID, candidate/fixture hash, installed public version and root
label (not real home), platform, expected/actual fixed code, numeric counters,
monotonic stage timestamps, terminal count, EOF/exit/close/reaped evidence,
retirement assertion and sentinel counts. Bound each receipt to 8192 bytes,
redact before storage; keep no prompts, raw streams, headers, credential values,
model objects, argv or env. Synthetic successful output comparisons use hashes
and lengths; canary leak receipts report boolean only. Matrix status is
pass/fail/blocked/not run, never inferred from source inspection.

Finally abort/drain owned fixture children and descendants; prove their recorded
PIDs closed before deleting disposable resources. If uncertain, stop and retain
only the isolated fixture directory for invoker-directed cleanup; do not claim
reaped or remove evidence under an active process. Verify no sessions/auth/trust
writes except explicitly expected synthetic fixture changes; compare pre/post
workspace and external resource hashes. Remove only the canonical mkdtemp-owned
root after bounds/symlink checks and retain bounded approved receipts separately.
Never reset/stash/commit real work, mutate tracker, delete an installed SDK or
copy/move real credentials.

## Disposition record (parent-owned)

- Invoker approved the protocol on 2026-09-09 via “Duyệt protocol (Recommended)”.
- Reviewed protocol before this disposition: SHA-256
  `01f53401b733fc1c996d5a00ee7982c3a0164519db26086a2c7f1398a02c21bf`.
- Reviewed contract source: SHA-256
  `f8e58104ee26324ccf9d2aef0e81754bd82737f7c953488db5a29be78e50a6f5`;
  tests: `aa0dfab808fa926468cc660c21f742b1ea5ae73b6c41e0826ef3c223b3ad6eee`.
- Executor: Bytes with one scoped worker per implementation bead; parent records
  candidate review, immutable launcher/fixture hashes and preflight inventory before
  any authorized execution. Those candidate records are **pending**, not assumed.
- Cases C01–C20 follow their stated applicability and later-unit prerequisites;
  only pre-existing approved local SDK roots 0.83.0/0.85.1 and disposable roots above.
  Unavailable platforms/versions stay not run. No installation is authorized.
- Approved limits: at most 10 seconds per case plus the existing 5000ms drain,
  at most 20 minutes per version suite, serial cases, no failed-safety-cell retries;
  all sentinels, stop conditions and bounded receipts above remain mandatory.
- Contract handoff may close. Launcher and later lifecycle candidates must still be
  implemented, reviewed and recorded before their applicable cases execute.
  Approval is not execution evidence, a gate waiver, live-pilot or release authority.
