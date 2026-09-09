> **Current authority (2026-09-09): Active; Design-ready and Plan-ready PASS.** See §7 for invoker approval, superseding route and conversion scope. The original Draft below is retained verbatim as historical provenance; it does not override §7.

# Change 001 — Exact-model SDK child launcher

| Field | Value |
|---|---|
| Change ID | subagent-mechanism-hardening-change-001 |
| Original plan | [Phase 3a deterministic plan](subagent-mechanism-hardening-phase3-plan.md) |
| Status | Draft — Oracle technical findings addressed; detailed invoker approval pending; not Accepted or Applied |
| Design-ready / Plan-ready | Pending; amended contract approval blocks PASS and conversion |
| Owner | invoker (approval and risk accountability); Bytes (design/delivery) |
| Created | 2026-09-09 |
| Accepted / Applied | Not yet |
| Requirements / design baseline | [Accepted §13](../specs/subagent-mechanism-hardening.md#13-phase-3-mvp--reliable-delegation-product-amendment), [Active §14](../specs/subagent-mechanism-hardening.md#14-phase-3-technical-design--reliable-delegation) |
| Authority | Documentation only. Direction selected: “Thiết kế SDK launcher (Recommended)”; detailed lifecycle/security/packaging design and delivery gate approval remain pending |

## Routing Decision — superseding delta route

- **Variant preset:** brownfield; unchanged REQ-007–012 and applicable REQ-006 outcomes/personas.
- **Triggered risks:** new child bootstrap architecture, consumed launch/event contracts, selected-home
  provider/trust boundary, cancellation/settlement lifecycle, multi-owner producer/adoption handoff.
  R2 independent review required; R3 containment/rehearsal assessment below, not a production rollout.
- **Required artifacts/gates:** this change request owns proposed D-01 design and plan amendments;
  independent design/security review → invoker detailed approval → `design-ready` →
  `plan-ready-for-beads` → targeted conversion/audit → implementation → standard feature-done.
  PRD gate is not reopened: product intent unchanged. No governing ADR, docs/AGENTS.md,
  engineering/architecture directory, or project template exists; reuse the feature's numbered
  design-decision convention. D-01 replacement must be accepted explicitly, not treated as an argv fix.
- **Execution path:** plan → converter, BLOCKED on this Draft. One design decision changes, so a
  linked delta suffices; this is not a parallel feature plan or an in-place baseline rewrite.
- **Exceptions:** none; no approval/gate waiver inferred from the selected direction.
- **Decided:** 2026-09-09 — Bytes records route following invoker's SDK-design choice.
- **Supersedes:** [§13.1 routing](../specs/subagent-mechanism-hardening.md#131-routing-decision)
  only for the D-01/WP-002 launcher amendment and its impacted integrations. The 2026-09-08 product,
  D-01–05 design, and Phase 3a split/PASS approvals remain historical facts, not approval of this delta.
  Reverse linkage in frozen artifacts is deferred to an authorized additive reference after acceptance;
  their contents and statuses are unchanged in this task.

## 1. Summary and compelling reason

Replace canonical CLI `--model` transport for **registered managed attempts** with an
**out-of-process** Node child using Pi's public SDK and an exact model object from the child's own
catalogue. Retain parent invocation capture, exact selector normalization, independent thinking,
read-only fallback, process isolation, and truthful requested/reported evidence.

Evidence: `/tmp/pib-2m0i-investigation.TXzg0F/REPORT.md` and its `probe.mjs`, `probe.jsonl`, and version
source diffs. Its **182 passing counterexample fixtures** establish failures of the desired CLI
contract in Pi 0.83.0 and 0.85.1 on Node 24.18.0, without sessions, credentials or network. They do
not establish SDK correctness. Explicit `--provider` prevents some cross-provider drift but still
allows fuzzy/name matching, unregistered-ID synthesis, colon reinterpretation and a valid
self-provider slash-ID collision. Separate thinking/quoting does not repair these cases.

Current frontier: `pib-2m0i`, WP-002 group `pib-2elc`, and Phase 3a epic `pib-idmm` are blocked.
This supersedes the baseline plan's historical “no Phase 3 graph” observation for resume purposes,
not by editing that historical text. No tracker operation is performed here.

## 2. Before / after and design amendment D-01-SDK (proposed)

| Aspect | Frozen baseline | Proposed delta |
|---|---|---|
| D-01 transport | canonical provider/id on nested CLI argv | immutable provider and literal id tuple to SDK child; never reparse it as a selector |
| Child admission | CLI selection assumed adequate | require child catalogue membership/availability, explicit registered object, and owned admission checks |
| Runtime | `spawn("pi", ...)` | registered path spawns bundled child entry with Node; no SDK session in parent |
| Packaging | single extension JS entry | additional executable child JS in published dist; external peer SDK binding verified |
| Delivery | intent producer → attempt adoption | existing intent producer → launcher/contract producer → adoption → independent integration revalidation |
| Consumers | CLI JSON events | compatible internal JSONL adapter, same result/progress/failure meaning; SDK version provenance |

### 2.1 Parent/child sequence and exactness

1. Registered execute synchronously captures cwd and public `ctx.isProjectTrusted()` together,
   selected session home, parent provider/id, immutable configuration,
   and execute-entry deadline before awaits. Reuse `invocation-context.ts`, finalized tool policy and
   D-04 admission. No model object, registry, provider code, auth or parent thinking is serialized.
2. Each primary/fallback attempt gets a validated versioned private pipe envelope containing literal
   `{provider,id}`, optional requested thinking, cwd/home, captured `projectTrusted`, finalized tool
   names, system/user prompts and remaining budget. Stdin carries a declared UTF-8 byte length,
   exactly one JSON document of that length, then EOF. Validate a nonnegative safe-integer length,
   count bytes before decoding, reject truncation/extra bytes/invalid UTF-8/JSON/version, and stop
   reading on overrun or deadline. The declared length bounds parsing; impose no new prompt-size
   limit. No shell, envelope file, credential argv, prompt logging or parent-env expansion; malformed
   setup fails closed, never activates a legacy launch.
3. Child creates `SettingsManager.create(cwd, agentDir, {projectTrusted})` from that capture and
   passes it as `settingsManager` to public `createAgentSessionServices`. Omit
   `resolveProjectTrust`: preserve parent-active trust, not the SDK's trusted default or a fresh
   child-specific trust decision. Load approved resources and flush factory provider registrations
   **before** exact lookup; a bare session plus separately created ModelRuntime is not equivalent.
   Initialization/protocol throws are `failed`; missing/unavailable required model is
   `provider_or_model_unavailable`; missing/mismatched required tools are `invalid_tool_allowlist`.
   Classify service/resource diagnostics by these postconditions, not every diagnostic's severity:
   unrelated diagnostics become bounded redacted warnings, not blanket fatal startup errors.
4. Resolve `services.modelRuntime.getModel(provider,id)` and verify the literal tuple in
   `getModels()`; require the tuple in `getAvailableSnapshot()` and configured-auth evidence, without
   an extra `getAuth`, `checkAuth`, refresh or network probe for admission. Missing/filtered models
   fail `provider_or_model_unavailable`. Cached availability is not credential validity. Ordinary
   child SDK service initialization and eventual provider auth remain Pi-owned, not parent preflight.
5. Pass **that registered child object**, never a synthesized/copied parent object or undefined, to
   public `createAgentSessionFromServices` (which forwards to `createAgentSession`). Use
   `SessionManager.inMemory(cwd)` and explicit tools. Thinking is a separate optional SDK field:
   agent effort > recognized suffix resolved by the parent > omitted/current child default. Preserve
   literal colon/slash IDs and no parent-thinking inheritance. Pi capability clamping remains Pi-owned;
   0.85.1 per-model defaults versus 0.83 global default must be tested, not normalized away.
6. Install the owned closed request gate/event subscription **before**
   `session.bindExtensions({mode:"json", ...})`. Await `session_start`, `resources_discover` and
   settlement of runs they initiate (`waitForIdle`), all within the existing deadline. Such runs
   encounter the closed gate; any refusal latches failure permanently. Only after settlement and
   postcondition checks may admission open and the launcher call `session.prompt`. Never reset a
   mutated model to conceal a violation. Every eligible fallback repeats admission and rebuilds
   prompt family; no writer retry.

### 2.2 Admission boundary: supported gate and explicit limits (Q-02 resolved in design)

Public agent core exposes writable `session.agent.streamFunction`. Preserve the SDK-supplied
function and install a closed-before-bind wrapper. On refusal, latch a bounded classified failure
and return public pi-ai `createAssistantMessageEventStream()` containing a terminal `error` event
and completed error result; **never throw or return a rejected promise** (`StreamFn` prohibits it).
Do not call the original stream, fabricate `agent_end`, or allow handled input/error events to
clear the latch. Unexpected wrapper-check failures use this same terminal-error path.

After binding/startup settlement, require
`session.model === admittedObject === services.modelRuntime.getModel(provider,id)`, literal tuple
membership, cached availability/configured-auth evidence, and exact finalized active tool names
(`session.getActiveToolNames()`, not merely the requested filter). Before **every forwarded request**,
check the actual model argument's tuple and object identity, that same session/registry identity,
current cached availability/auth, open gate/no latch, wrapper ownership and exact active toolset.
Tool mismatch is `invalid_tool_allowlist`; identity/availability
refusal is `provider_or_model_unavailable`; gate/ownership/protocol failure is `failed`. Admission
adds no auth refresh/network probe. Forward unchanged only when all checks pass.

Inspected 0.83.0/0.85.1 source routes main turns, tool continuations, follow-ups/retries, compaction
and branch summaries through the agent stream function. The guarantee is deliberately limited:
**every request through the still-installed wrapper uses the exact registered admitted object**.
It does not contain arbitrary trusted-extension direct calls, deliberate wrapper replacement,
`before_provider_request` payload rewrites, or upstream routing; same-object in-place provider
behavior changes are not endpoint attestation. Same-tuple replacement objects are refused. This
is not a sandbox or universal all-request identity guarantee. Hooks that throw may be swallowed;
`ctx.shutdown()` in print mode is not a veto. Post-bind-only checking is insufficient because
startup hooks can run while binding. Coverage/negative fixtures remain future evidence, not a new
open design question or an assertion that source inspection proves runtime correctness.

### 2.3 Home, resources, trust and prompt parity

- Preserve D-02 resolver and all closed consumer work: both child home aliases equal the normalized
  session home. Read settings, models, auth and model-store paths there; no default-home search,
  credential/code copying, parent-only runtime provider transfer or automatic provider installation.
  Missing parent-only provider yields unavailable with selected-home/restart guidance.
- Preserve restricted inherited env: `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `NODE_ENV`, plus generated
  home aliases and `PI_NESTED_DEPTH=1`. Do not forward provider secrets, `NODE_OPTIONS`, proxy variables
  or the entire parent environment. Child-generated Pi process markers must match the bound SDK
  version (`PI_CODING_AGENT`, plus `AI_AGENT` where applicable), not add inherited privileges.
- Use normal global/settings/package resources and **only already-approved** project resources.
  Do not disable all extensions (would lose Blackbytes tools/providers), force trust, add project
  paths as trusted `-e` equivalents, or force-load parent extension code to cure missing tools.
  Exact finalized allowlist remains a hard SDK `tools` filter, including late registrations and
  activation; unknown required tools fail `invalid_tool_allowlist`, never use defaults. No
  `delegate_*`; empty finalized list refuses as today. Nested-depth refusal remains parent-side too.
- **Q-01 design decision: parent-active trust parity.** Capture public `ctx.isProjectTrusted()`
  synchronously with cwd; use the explicit SettingsManager above and omit the loader's
  `resolveProjectTrust` callback. Do not rerun child global trust handlers, saved-decision/default
  resolution or remember semantics: the parent has already established the active trust boolean.
  A child-specific handler/default must not change it. No new grant, trust-store write, internal CLI
  trust-helper import or forced project resource path. This is parity with the captured parent-active
  state, not a fresh reproduction of CLI decision handling. Package loading can install missing
  resources; rehearsal must use pre-existing local fixtures with network/install sentinels, never a
  real selected home. Existing Pi resource behavior is not a launcher grant to install or write trust.
- `noContextFiles:true` preserves CLI no-context behavior; D-03 mandatory manifest/recovery policy
  stays parent-owned. Use resource-loader custom system prompt override to preserve supplied text
  literally (not accidentally interpret prompt text as a file path). Preserve CLI ambient
  `APPEND_SYSTEM.md`, skills, templates and extension prompt transformations unless separately
  approved otherwise; “static” does not imply disabling all Pi augmentation. `promptMode:append`
  remains rejected and temperature remains reserved. `SessionManager.inMemory` means no resume or
  session transcript file, not no artifact/settings/extension writes. No parent context is copied.

### 2.4 Child distribution and SDK binding

Proposed producer adds `src/sub-agents/sdk-child.ts` → `dist/sdk-child.js`, built separately alongside
`dist/index.js` using existing Bun/node/ESM external-package conventions and declaration build.
Only index stays in `pi.extensions`; the child is not an auto-loaded extension. Existing `files:dist`
includes the child; assert this from the packed artifact and run it outside the source tree without
TypeScript loaders/dev-only modules. Preserve Node >=22.19.0, Pi peers >=0.83.0 <1, package version and
<500 KB gzip gate; no dependency/install/version change in this drafting task.

**Q-03 design decision:** spawn the absolute installed child entry with `process.execPath`;
resolve the **public SDK package root relative to installed Blackbytes**, using ESM import-condition
resolution (not a CJS-only `require.resolve` assumption). The parent records that binding's public
`VERSION` as expected version; child checks the same bound root's public `VERSION` and required
capabilities **before resources load**. Resolve the public pi-ai root relative to that **same SDK
installation** for the error-stream factory, not independently from Blackbytes or PATH. No production
`dist` internal imports, PATH/CLI fallback, or new dependency. Missing entry/import is `spawn_error`;
version/capability/protocol incompatibility is `failed`, with bounded redacted provenance.

Peer-over-PATH is an explicit consequence requiring approval: registered children may use a different
Pi version than the PATH CLI or host extension loader. Do not assert host/child version equality.
Missing/incompatible binding refuses rather than searching other installations. Packed-install tests
must execute `dist/sdk-child.js` outside the source tree with supported installed layouts, public
root binding/version mismatch negatives and no TS loader/dev-only imports. Internal chain/direct
runner remain PATH-based; availability diagnostics distinguish these launch paths. Tests are future
proof, not a condition left for the converter to design.

### 2.5 JSONL, exit, termination and evidence contract

**Q-04 design decision:** fd 3 is the dedicated bounded JSONL normalized protocol pipe; stdout
and stderr are bounded redacted diagnostics only, never parsed as protocol. Normalize session header,
message/progress deltas, tool-call progress, usage and reported provider/id into the existing internal
consumer meanings. Do not duplicate full raw streams. Bound frames/diagnostic tails using existing
artifact/return budgets below; chunk supported content rather than impose a new prompt/output limit.
Adapter fixtures cover raw SDK versus 0.85.1 CLI delta-only message_update and fragmented frames.
Launcher status carries only version, admission state and bounded redacted failure codes; no model
objects, headers, prompts, credentials or registry dumps. Use explicit classification, not stderr regex.

Only the launcher emits **one terminal frame**, after prompt/run settlement; raw `agent_end` is
progress, never terminal success. Process-only success requires a launcher success terminal, no
latched failure, exit 0, completed protocol flush and observed child `close`; never task verification.
Missing/duplicate terminal or corrupt protocol is `malformed_jsonl`; missing entry/import/spawn is
`spawn_error`; malformed setup is `failed`; tools/model failures use §2.1/2.2 postconditions.
Cancel/deadline/external signal retain `cancelled`/`timed_out`/`killed`. Existing legacy failure kinds
remain supported. Read-only fallback consumes only existing eligible unavailable outcomes and shared
remaining budget; no implicit retries. A latch cannot become success through an assistant error,
handled input, raw agent_end or a later successful run.

Child try/finally owns nonzero failure exit, unsubscribe and fd-3 flush. Use public
`createAgentSessionRuntime` around the exact-model factory so `await runtime.dispose()` emits
`session_shutdown`; plain `session.dispose()` alone does not. Close the gate, abort/wait for all
runs and dispose before terminal/flush/exit. Refuse replacement/reload command actions rather than
create another persistent or unguarded session; latch controlled `failed` without invoking replacement.
Signal handlers request cleanup but cannot extend the parent deadline. Startup/auth/resources,
queue and model work share the execute-entry deadline; late completions cannot authorize launch.

Parent sends TERM to the Linux detached process group (Windows direct-child fallback), then KILL
**after 100ms** if needed, and waits within the existing **5000ms shutdown drain** for child close and
pipe settlement. Kill-grace expiry alone is not reaping. Do not release the writer lease at raw
agent_end or initial abort. If no close is observed by the drain deadline, return the original
cancellation/timeout (or external-signal failure) with `reaped:false` and **permanently retire the
parent writer controller**, barring any later managed writer even after late close, reset or reload
in that parent lifetime. Only a fresh parent lifecycle can restore admission. Observed close proves
the direct child closed, not all descendants exited; retain process-group containment tests and that
explicit limitation. This amends registered SDK settlement only, not a claim about legacy runner
kill-grace behavior. WP-003 owns the unreaped barrier; launcher producer, adoption and compatibility
atoms must carry its evidence (§3), not defer it to an unrelated backlog.

Reuse parent artifact path/capture, redaction, 24576-character tail-preserving return cap, 512 KiB
artifact cap, seven-day retention and best-effort capture. Successful worker text remains byte-preserved
within the cap, possibly sensitive; errors/progress/new metadata/artifacts stay redacted and bounded.
WP-005's unverified prefix remains outside the cap. No request envelope/transcript persistence added.

## 3. Delivery delta and downstream effects (not graph edits)

Stable WPs remain WP-001–006; launcher is a distinct **producer checkpoint within WP-002**, not
extra scope hidden in the blocked adoption leaf. All requirements/exits not explicitly amended remain
in the baseline plan. Detailed slicing/root/terminal dependencies belong to the later converter.

| Delivery checkpoint | Coverage / design refs | Prerequisite producer | Exit evidence |
|---|---|---|---|
| WP-002 launcher/contract producer | REQ-007/008, REQ-006; §2 above | Closed exact intent and selected-home contracts; Q-01–04 contract approved | Versioned transport, packaged child, exact-object admission, trust/resource policy, failure/event/termination contracts, unreaped result contract and isolated negative fixtures independently reviewed |
| WP-002 registered adoption | REQ-007, REQ-006; §2.1/2.5 | Accepted launcher producer | Every registered primary/fallback uses structured intent; snapshot overwrite path fixed locally; prompt family and separate thinking correct; requested/reported identity remains distinct; no legacy unguarded registered branch; unreaped result retires writer controller |
| WP-003 lifecycle adoption/revalidation | REQ-010, REQ-006; baseline D-04 + §2.5 | Existing lease producer; launcher lifecycle for integrated adoption | Deadline includes SDK startup; binding/startup cancellation and delayed close cannot overlap writers; permanent unreaped barrier across late close/reset/reload verified; lease unit evidence retained |
| WP-004 instruction integration | REQ-009/011, REQ-006; D-03 + §2.3 | WP-001 home and WP-003 admitted preparation | Same manifest/recovery, optional-hook failure behavior, no-context-file and custom-prompt parity through SDK child; no new discovery policy |
| WP-005 consumers | REQ-012/011, REQ-006; D-05 + §2.5 | WP-002 metadata and WP-004 integration | New launcher failure/version provenance renders conservatively; missing/mismatch model observations stay unknown/warning; no false verified label or raw event leak; old details render |
| WP-006 independent revalidation/docs | REQ-006 and REQ-007–012 join; §4 below | WP-001–005 completed contracts | Minimum/current SDK matrix and packed distribution proof, unreaped-barrier/late-close and existing CLI chain compatibility, security review, full verification and operational guidance; missing cells block proof |

Coarse dependency changes: launcher consumes WP-001 home producer (already delivered); registered
attempt adoption consumes launcher instead of assuming argv exactness. WP-003 integrated lifecycle
consumes the launcher settlement contract, not all WP-002 adoption; avoid a WP-002↔WP-003 cycle.
WP-004 keeps home/admission prerequisites; WP-005 keeps intent/instruction prerequisites; WP-006 joins
all completed outcomes. No blanket reopening of WP-001 or reslicing its already-closed work.

**Affected beads, future disposition only:** coordinator must decide whether `pib-2m0i` remains the
adoption leaf with a new producer prerequisite or is superseded by separately sliced adoption leaves.
Do not close/reopen/retitle it here. `pib-2elc` and `pib-idmm` remain blocked; converter later attaches
accepted delta provenance and exact edges, then targeted audit precedes implementation.

**Four closed leaf evidence retained unchanged** (read-only JSONL close reasons, not reruns):
`pib-1oq7` selected-home resolver (952 pass, 2 Windows skips, 181571B gzip);
`pib-lkr2` consumers/env (967 pass, 2 skips, 182047B);
`pib-mf1e` FIFO leases (952 pass, 2 skips, 181571B);
`pib-mwvj` exact intent producer (992 pass, 2 skips, 183359B; sparse fallback fix and 25 focused tests).
Their R2 reviews and bounded scopes remain evidence, not SDK delivery proof. Closed WP-001 join
`pib-84aj` also remains untouched.

## 4. Compatibility, risk and controlled evidence

Use repository `node:test`/assert, temporary homes/checkouts, synthetic providers/tools with call
counters, denied networking and install/credential-operation sentinels. No model/credential call,
Pi session, pilot, installation or rehearsal is executed by this drafting unit.

Required cases: all 182 counterexample classes re-expressed at the new child boundary; successful
literal slash/colon and self-provider collision; duplicate IDs; missing/auth-filtered provider/model;
zero fake stream/tool calls on admission failures; explicit/default thinking; startup and later model
mutation; resource discovery/provider registration errors; missing required tool; parent-active
trusted/untrusted captures despite divergent child saved/global-handler/default trust cases;
official/legacy/divergent homes; fallback families and budget exhaustion;
abort before/during binding and after raw agent_end; UTF-8 byte framing/EOF/large prompts;
fd-3 fragmentation/corruption, stdout noise, duplicate terminal, nonzero exits, stalled cleanup,
unreaped permanent retirement across late close/reset/reload, reaping and descendants;
artifact/redaction/return-cap and legacy chain regressions.

Matrix remains Pi **0.83.0 and 0.85.1 × Node 22.19.0 and 24.18.0/current recorded runtime**. Verify
public types and packed child behavior with isolated existing dependencies, not a global replacement.
Linux process-group and Windows mock branches required; real Windows remains explicitly not run if
unavailable. SDK source inspection is not any executed matrix cell. Final delivery `bun run check`
(lint/typecheck/build/test/size) is mandatory; no floor increase or weakened size gate.

| Risk | Accountable owner / containment / review |
|---|---|
| R2: wrong-model execution or changed resource trust | invoker accountable; Bytes owns closure evidence; independent Oracle reviews candidate/API/security evidence, not author summary alone. Keep registered SDK adoption blocked until the amended Q-01/02 contract is approved; no silent CLI fallback. |
| R2: package binding/protocol/cleanup mismatch | invoker accountable; Bytes owns implementation proof. Packed-artifact matrix and late-settlement negatives required; disable affected delegates on failure. |
| R3 escalation assessment: process teardown and rollback can leave partial worker edits | invoker accountable. No data migration/shared-state cutover or authorized coordinated rollout, but select a **controlled no-network synthetic child rehearsal** before adoption to demonstrate containment/drain/reaping in disposable directories. Rehearsal protocol and execution authorization still pending; no real worker writes or credentials. If broader destructive/coordinated rollout becomes necessary, return for a new R3 decision. |

Default containment remains disabling affected delegates. Authorized package rollback requires
cancel/drain, restore prior version, restart Pi; never reset user edits or move credentials. Rollback
cannot undo worker edits and restores older model/writer/handoff limitations. A rehearsal validates
process safety, **not LLM obedience or ROI**. It is distinct from deferred **Phase 3b P3-Q-006** paired
behavioral pilot, which still needs invoker-approved cases/models/repetitions/spend/time ceilings or
an explicit evidence exception. Neither SDK direction nor this synthetic rehearsal selects that
budget, authorizes provider calls, grants release authority, or closes overall Phase 3.

### Inspected local API evidence (not execution proof)

Full installed 0.83 `docs/sdk.md` (including ResourceLoader), `docs/extensions.md`, and `docs/json.md`
were read; full 0.85.1 SDK/extension documentation deltas were compared. Linked SDK examples
`02-custom-model`, `03-custom-prompt`, `06-extensions`, `07-context-files`, and extension examples
`project-trust`/`input-transform` were read, not run. Package roots are recorded in the blocker report.
Public export/type and implementation checks used package-relative `dist/index.d.ts`,
`dist/core/{sdk,agent-session-services,resource-loader,model-runtime,agent-session-runtime}`,
`dist/core/agent-session.js`, `dist/main.js`, and `dist/modes/print-mode.js`; agent-core
`dist/agent.d.ts` exposes `streamFunction`. These are inspection references, not production import
paths. SDK/services version diffs confirm explicit model transport remains supported and identify
thinking defaults/abort differences. Root exports, not a docs snippet alone, govern feasibility.

### Remediation API checks (source-only, both local versions)

This localized pass rechecked root exports/types and implementation in project
`node_modules/@earendil-works/pi-coding-agent` (0.83.0) and
`/home/cmc-admin/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent`
(0.85.1): `ExtensionContext.isProjectTrusted`, `SettingsManager.create` trust option,
services' settingsManager injection, loader preservation when `resolveProjectTrust` is omitted,
public `VERSION`, runtime/session factories, `getActiveToolNames`, `waitForIdle` and stream-call paths.
Each installation's pi-agent-core `StreamFn` explicitly forbids throwing/rejection and its Agent
exposes `streamFunction`; each pi-ai public root re-exports `createAssistantMessageEventStream`.
Inspection of installed `dist` files is evidence only, never an authorized production import path.
A CJS resolution probe failed on pi-ai's import-only root exports; use ESM import-condition binding
and verify installed layouts in future packed tests. No session/provider/credential call was made.

## 5. Resolved design questions and pending approval

| ID | Concrete decision for invoker approval | Disposition |
|---|---|---|
| Q-01 | Parent-active trust capture/injection; no child trust re-resolution, grant or trust write (§2.1/2.3) | Design resolved; approval pending; trust fixture evidence future |
| Q-02 | Closed-before-bind nonthrowing error-stream gate; exact object/toolset per wrapped request; explicit non-sandbox limits (§2.2) | Design resolved; approval pending; coverage/negative evidence future |
| Q-03 | Installed-Blackbytes public SDK peer + expected VERSION; same-install public pi-ai; no PATH/internal fallback (§2.4) | Design resolved; peer-over-PATH approval pending; packed matrix future |
| Q-04 | Byte-length JSON+EOF stdin, dedicated fd-3 protocol, launcher-only settled terminal, observed close or permanent unreaped writer retirement (§2.5) | Design resolved; approval pending; transport/lifecycle/rehearsal evidence future |

**Decision summary — invoker must approve:** accept these four amended contracts together, including
parent-active rather than child-recomputed trust, the limited still-installed-wrapper guarantee,
peer-over-PATH binding and permanent loss of managed-writer admission after unreaped cancellation
in the same parent. Authorize the producer/adoption/WP-003/compatibility impact in §3 separately from
implementation or rehearsal execution. Controlled synthetic rehearsal protocol/authorization and
later coordinator-owned leaf disposition remain genuine delivery decisions; no new technical Q is
left for the converter to invent. Phase 3b pilot budget remains outside this delta.

**Review disposition:** one Oracle review already occurred; its supplied concrete findings are
addressed by this localized remediation, not a new automatic review or executed proof. No exception
claimed. **Design-ready: Pending / not PASS** and **Plan-ready-for-beads: Pending / not PASS** until
invoker detailed approval and dated gate dispositions. Status remains Draft, not Active, Accepted
or Applied; matrix/rehearsal/implementation evidence remains future work.

## 6. Apply plan, approval and deliberate non-changes

With the reviewed technical questions resolved in design, obtain invoker detailed contract approval
and record dated design-ready/plan-ready dispositions; do not automatically initiate another review.
Only then authorize additive baseline references
or a separately accepted design amendment without erasing 2026-09-08 approval history; hand accepted
scope to converter for coordinator-owned leaf disposition and targeted audit. Implementation remains
a later unit. Mark Applied only after actual artifact/graph/code delivery and recorded verification,
not after direction selection or review.

Unchanged: public delegate names/inputs, four roles, YAML optionality, D-02 home precedence, D-03
instructions, D-04 FIFO policy, D-05 process-unverified semantics, successful-output sensitivity,
read-only fallback eligibility, no writer retry, no parent thinking, no context copying, reserved
settings, internal chain exposure and direct runner policy. No in-process parent SDK session,
internal resolver import, CLI guard hard-exit shortcut, OS sandbox, scheduling platform, new dependency,
credential migration, pilot, version bump, release, tracker mutation or commit is in this task.

| Date | Author / authority | Revision |
|---|---|---|
| 2026-09-09 | Bytes drafting; invoker direction only | Created Draft change-001; baseline approvals/evidence preserved; detailed design/plan gates pending independent review |
| 2026-09-09 | Bytes localized remediation of supplied Oracle findings; invoker direction only | Resolved Q-01–04 at design level after local API checks; detailed approval and gate dispositions pending; no automatic rereview or execution proof |

## 7. Activation and superseding Routing Decision — 2026-09-09

**Current Status: Active — accepted delta; conversion authorized, implementation not yet applied.**
**Design-ready: PASS — 2026-09-09 — Bytes, checklist assessment following invoker approval.**
**Plan-ready: PASS — 2026-09-09 — Bytes; change-001 / Phase 3a WP-001–006 impacts only.**
**Plan-ready-for-beads: PASS — 2026-09-09 — Bytes.**

### Approval provenance and authority

On 2026-09-09 the invoker explicitly answered **“Duyệt delta và triển khai”** after the summary of
process isolation, peer-SDK-over-PATH binding, parent-active trust, no auth/code copying, exactness
limited to requests through the still-installed managed stream wrapper, and permanent writer
retirement after unreaped cancellation. This approves D-01-SDK/Q-01–04 together and the producer,
adoption, WP-003 and WP-006 impact in §3. It authorizes this graph conversion and later separately
delegated implementation, **not execution in this conversion unit**, a live pilot, installation,
release or rollback. No approval waiver is inferred. The original plan/spec and all closed work
remain frozen. Earlier Draft/pending statements in §§1–6 are historical snapshots superseded by
this dated section, not current blockers or assertions of delivery.

One supplied Oracle technical review occurred and its concrete Q-01–04 findings were addressed in
the recorded remediation/API inspection (§§2, 4–5). This is the design-review evidence accepted by
the invoker, **not a new independent review, Oracle runtime approval, or executed SDK proof**.
Independent candidate/security review remains required on the implemented contract/provider/adoption
and WP-006 evidence. The 182 CLI counterexamples remain counterevidence to argv exactness only.

### Routing Decision (current; supersedes the initial delta route)

- **Variant preset:** brownfield; existing accepted REQ-007–012 and applicable REQ-006, Phase 3a only.
- **Triggered risks:** child/bootstrap architecture, consumed launch/event/lifecycle contracts,
  selected-home trust/auth boundary, producer/consumer handoff, teardown with weak edit rollback (R2;
  R3 controlled rehearsal assessment retained).
- **Required artifacts/gates:** this accepted additive D-01-SDK design/delivery delta → design-ready
  PASS → plan-ready-for-beads PASS → conversion + targeted structural audit → separately delegated
  implementation/candidate review → WP-006 compatibility/security/documentation → standard
  feature-done. PRD gate N/A: product intent unchanged. Data/schema migration and cross-stack gates
  N/A: none introduced. No governing ADR/templates/docs engineering conventions found after checking
  repository context; reuse the numbered design-decision convention and node:test/Bun/ESM conventions.
- **Execution path:** plan → converter; this unit stops after graph verification, before any bead claim.
- **R3 decision:** invoker accountable; controlled no-network synthetic containment/drain/reaping
  rehearsal selected, because rollback cannot undo worker edits. Contract atom prepares protocol
  with disposable pre-existing local resources, sentinels, cases, stop conditions and bounded receipts;
  invoker's explicit protocol/execution disposition is required before provider rehearsal. No real
  selected home, credentials or worker edits. No unapproved rehearsal parameters become executable
  run leaves. Disable affected delegates as containment; package rollback needs separate authorization,
  cancel/drain and fresh Pi restart. A broader destructive/coordinated rollout returns for a new gate.
- **Exceptions:** none. Future protocol authorization is an execution hold, not completed rehearsal
  evidence. Phase 3b pilot protocol/budget/approval remains outside this delta and cannot be inferred.
- **Decided:** 2026-09-09 — Bytes records invoker's explicit approval above.
- **Supersedes:** this file's initial Routing Decision/Draft gate dispositions and the baseline
  §13.1 route only for D-01/WP-002 and explicitly impacted consumers; no baseline history is rewritten.
  Reverse provenance is recorded on current affected Beads rather than editing frozen plan/spec.

### Checklist assessment (artifact readiness, not delivered behavior)

| Gate / applicable checklist items | Evidence / disposition |
|---|---|
| Design: status, owner, routing, requirements, conventions, revision history | Active metadata and this dated approval; invoker accountable/Bytes delivery; accepted §13 and Active §14 links; AGENTS + actual package.json checked. No governing ADR found. |
| Design: boundaries and architecture/sequence/error flow | §§1–2.5 and §6 distinguish parent capture, peer-bound child services, closed-before-bind gate, literal object admission, fd-3 normalized events and settled shutdown; no parent SDK session or unguarded registered fallback. |
| Design: consumed API/events/security/reliability | Q-01–04 resolved and approved: captured trust/settings/services, cached availability without extra auth probes, exact active tools, import-condition SDK/pi-ai binding and VERSION, nonthrowing error streams, terminal/failure/reaping taxonomy, restricted env and explicit wrapper limits. |
| Design: compatibility/phase scope/rollback/R3 | §§3–4 + current route preserve D-02–05 and unmanaged chain/CLI; deterministic scope locked; disable/drain/restart containment, no edit rollback claim. Synthetic rehearsal selected; separate execution authorization remains future. |
| Design: test strategy and questions | §4 names negative fixtures, sentinels and four cells; Q-01–04 have settled approaches, no converter-owned architecture question. Oracle findings addressed by recorded source/API inspection, not runtime tests. |
| Plan: header/source/phase/MVP-lock/exits/checkpoint | This Active delta amends only Phase 3a WP-001–006; §§3–4 inherit original exits and locked REQ/AC, independent matrix/full check and containment; Phase 3b/release excluded. |
| Plan: stable WPs/outcomes/coverage/design refs/prerequisites/exits | §3 delivery table explicitly maps launcher contract/provider/adoption and impacted WP-003–006 to REQ/design, producers and exit evidence. Closed home/intent/lease producers retained; per-WP ordinary tests remain local. |
| Plan: decomposition/consumers/acyclic sequencing | Independent contract publication, runnable provider, registered adoption; existing original serves explicit terminal join. WP-003 semantic input is launcher settlement, not a reverse producer/adoption loop; prior shared-file serialization edge retained deliberately (map below). |
| Plan: risks/authorization/negative proof | Invoker R2 approval recorded; independent candidate review, no-network fixtures, future protocol disposition and unreaped negatives explicit. Future runtime/cell availability can block execution/proof, never be mislabeled PASS from inspection. |
| N/A modules and warnings | No persistent migration/backfill or cross-repo stack; no coverage percentage invented. Long contract is a writing/duplication warning, not an atomicity failure: contract/provider/adoption have distinct outcomes/proof/checkpoints. |

**Verdict:** both applicable artifact gates PASS with no exception. This activates/freezes only the
new delta's scope. No SDK matrix cell, packed-run proof, synthetic rehearsal, implementation,
behavioral acceptance or feature-done is claimed completed.

### Exact conversion map prepared before tracker writes

| Alias / existing ID | Disposition / primary boundary | Prerequisites / grouping |
|---|---|---|
| `contract` (new) | Versioned private launch/event/settlement contract, codec proof, independently reviewed protocol handoff; prepares controlled rehearsal protocol, does not run it | blocks on closed `pib-mwvj` (inherited) and `pib-lkr2`; parent `pib-2elc` |
| `provider` (new) | Peer-bound bundled runnable SDK child and focused package/containment proof; no registered cutover | blocks on `contract`; parent `pib-2elc` |
| `adoption` (new) | Registered primary/fallback exact-intent SDK consumer, truthful provenance and fail-closed unreaped callback | blocks on `provider`; parent `pib-2elc` |
| `pib-2m0i` | Rewrite unimplemented blocked leaf as scope-free **open** coordinator; clear claim, never implementation WIP | retain original `pib-mwvj` prerequisite + WP-002 parent; add block on terminal `adoption`; retain all five downstream dependents |
| `pib-yd3k` | Amend startup/deadline/settlement acceptance and add explicit semantic producer edge | add block on `provider`; retain `pib-mf1e` and `pib-2m0i` (the latter solely for existing shared register/types/fallback edit serialization) |
| `pib-nkj1` | Amend retirement: `reaped:false` permanently poisons managed writer admission across late close/reset/reload; only fresh parent lifecycle recovers | existing `pib-yd3k` prerequisite retained; no WP-002 reverse edge |
| `pib-33zb` | SDK no-context/custom-prompt/ambient augmentation parity in existing mandatory-instruction acceptance | existing edges unchanged |
| `pib-0ext`, `pib-6fr4` | Launcher-only settled process success and bounded version/failure provenance; old details and unmanaged semantics remain conservative | existing edges unchanged |
| `pib-ll8n` | Extend joined security/protocol/reaping acceptance without matrix/behavioral claims | existing five terminal producer/join prerequisites unchanged |
| `pib-4bsc` | Four-cell peer-SDK + packed-distribution/protocol compatibility, retained unmanaged CLI/chain evidence | existing five terminal producer/join prerequisites unchanged |
| `pib-04hc` | Add precise SDK binding/trust/exactness/reaping/protocol and execution-authority operational documentation obligations | existing five terminal producer/join prerequisites unchanged |
| `pib-idmm`, `pib-2elc` | blocked → in_progress coordination only **after** gates and graph-ready audit | no premature group closure; other groups reflect current actual progress |

**Planned delta:** 3 new task atoms, 3 parent-child + 6 blocks edges = **9 new edges**, no removed edges.
All new atoms are siblings of the original under WP-002: parenting them under `pib-2m0i` while making
that original depend on terminal adoption would form a mixed hierarchy/blocks cycle in br's graph.
Distinct grouping parent and join avoid both that cycle and same-pair dependency primary-key collision;
no force, reconciliation or SQL writes. The original closes only after terminal adoption closes and
its transitive contract/provider review + authorized rehearsal evidence is checked and summarized;
only then may its downstream consumers start. WP-003 owns real cross-generation retirement; adoption
consumes/tests the fail-closed hook, not a new lifecycle policy. The extra direct provider edge on
WP-003 records semantic dependency while retaining established shared-file serialization, not an
invented WP-002↔WP-003 cycle. Independent DAG branches still require serial shared-file ownership.

| Date | Author / authority | Revision |
|---|---|---|
| 2026-09-09 | Bytes; invoker “Duyệt delta và triển khai” | Accepted and activated only change-001; superseding Routing Decision, Design-ready/Plan-ready PASS with honest source-vs-execution evidence; prepared exact split/impact map. Frozen plan/spec, 212 historical records, four closed Phase 3a leaves and WP-001 join remain untouched; graph receipts follow after verification. |

### Conversion and targeted audit receipt — 2026-09-09

**Graph conversion completed; change remains Active, not implementation-Applied or feature-done.**

- Actual IDs: `contract` = **pib-2elc.1**, `provider` = **pib-2elc.2**, `adoption` =
  **pib-2elc.3**; all open, P2, `feature:reliable-delegation-phase3a`, `service:pi-blackbytes`,
  `change:001`, with `Split-from: pib-2m0i`. Stack label N/A: one existing TypeScript extension
  service, no FE/BE or cross-repo split. Full approved Q-01–04 constraints are embedded in each
  executable brief, not dependent on reading this plan.
- Exact new blocks edges (dependent → prerequisite): `pib-2elc.1 → pib-mwvj`,
  `pib-2elc.1 → pib-lkr2`, `pib-2elc.2 → pib-2elc.1`, `pib-2elc.3 → pib-2elc.2`,
  `pib-2m0i → pib-2elc.3`, `pib-yd3k → pib-2elc.2`. Three new parent-child edges are
  `.1/.2/.3 → pib-2elc`. **3 new atoms, 9 new edges, zero removed edges**; every original
  downstream dependency and inherited prerequisite retained. No mixed hierarchy cycle or pair collision.
- `pib-2m0i` is now open/unassigned, scope-free non-WIP join with explicit verified terminal-close
  protocol. After gates and graph-ready audit, `pib-idmm` and `pib-2elc` moved blocked → in_progress
  for coordination only. WP-003 `pib-x1q9` remains in_progress; WP-004/005/006 groups remain open;
  WP-001 `pib-84aj` remains closed. No implementation leaf was claimed or closed.
- Changed existing IDs: `pib-2m0i`, `pib-yd3k`, `pib-nkj1`, `pib-33zb`, `pib-0ext`, `pib-6fr4`,
  `pib-ll8n`, `pib-4bsc`, `pib-04hc`, plus the two coordination groups above. Changes are only
  approved launcher adoption, retirement, prompt/consumer/protocol/matrix/documentation impacts.
- Full affected open-leaf prerequisite/dependent closure audited without sampling:
  `pib-2elc.1`, `.2`, `.3`, `pib-yd3k`, `pib-nkj1`, `pib-dcip`, `pib-33zb`, `pib-0ext`,
  `pib-6fr4`, `pib-ll8n`, `pib-4bsc`, `pib-04hc` (12). `pib-dcip` is the unchanged trusted
  manifest baseline, inspected for dependency context and not rewritten. Closed prerequisites were
  read only for evidence/provenance. Ten required fields and canonical provenance are present; all
  five atom invariants reviewed: contract publication/codec proof; runnable provider/focused package
  and authorized synthetic containment proof; registered consumer/adoption traces; lease lifecycle;
  retired-generation containment; manifest and prompt adoption; truthful result/consumer contracts;
  joined integration evidence; isolated version matrix; operational docs. Each has one attributable
  proof loop and an explicit disable/scoped revert/checkpoint, not invented rollout authority.
- Structural split corrective pass fixed the coordinator's own lint heading; targeted second pass
  found no remaining changed-scope exceptions. `br lint` is clean. `br lint --status all` reports
  **100 pre-existing historical closed/tombstone template warnings**, all outside Phase 3a and
  byte-identical to baseline; they were not rewritten to manufacture a globally clean history.
- Graph-wide floor checked **236 records and all 446 edges** (before: 233/437): every planned edge
  exists, no dangling references or duplicate pairs, no cycles including closed/history (both
  read-only DFS and `br dep cycles --include-closed`), no false-ready implementation node. `br graph`,
  `br dep tree pib-2m0i` and `br ready` corroborate the actual graph. Sole ready implementation leaf:
  **pib-2elc.1**. Provider/adoption/join and all impacted downstream leaves remain blocked by edges.
- Preservation proof compares full JSONL record bytes: **all 212 historical records**, closed leaves
  **pib-1oq7 / pib-lkr2 / pib-mf1e / pib-mwvj**, and **pib-84aj** unchanged, including evidence,
  notes, statuses and dependencies. All other non-target records unchanged. Source/config/test files
  and original plan/spec hashes match the invocation baseline; the initial delta text is retained
  verbatim with only current-authority notice and dated additive sections. Temporary maps/scripts and
  snapshots remain outside the repository; permanent approval/map/check receipts are here and in notes.
- Repository verification: **`bun run check` PASS — lint, typecheck, build, 992 passing tests,
  2 Windows-only skips, 0 failures; 183359-byte gzip (<500 KB)**. This verifies unchanged existing
  code, not SDK correctness. No SDK matrix cell, packed SDK-child execution, synthetic rehearsal,
  new candidate review, model/provider call, installation, implementation or pilot was performed.

**Handoff verdict:** artifact gates PASS; affected graph implementation-ready with the sole
**dependency-ready** contract leaf above. Controlled rehearsal protocol approval is still required
before future provider rehearsal; matrix/rehearsal evidence remains future, not waived. Parent now
verifies this conversion and may delegate **one** bead. Stop this conversion unit here; no automatic
claim, implementation, commit or release.

| Date | Author / authority | Revision |
|---|---|---|
| 2026-09-09 | Bytes; approved change-001 conversion | Converted exactly 3 atoms/9 edges, retained original terminal join and historical records, amended only impacted consumers; complete targeted audit plus graph-wide verification and existing-code full check recorded. Active delta; implementation and all new SDK evidence remain pending. |
