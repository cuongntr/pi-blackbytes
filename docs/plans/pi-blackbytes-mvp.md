# Execution Plan — `@blackbytes/pi-blackbytes` MVP

Source: `docs/plan/pi-blackbytes-prd.md` (Draft v1).

This plan re-organizes the PRD into a delivery-oriented structure for AI-driven implementation. The PRD is the source of truth for product intent; this plan is the source of truth for execution sequencing, decision capture, and task graph shape.

---

## 1. Executive Intent

**Problem.** Bytes power-users on OpenCode get a curated agent stack (`bytes` primary, `explore`/`oracle`/`librarian`/`general` sub-agents, hashline edit workflow, ast-grep tools, Exa/Context7/grep.app via MCP) through `oc-blackbytes`. Pi (`@mariozechner/pi-coding-agent`) users have none of it because Pi is single-agent and has no MCP support.

**Why it matters.** Maintains tool/workflow parity across two CLIs the same users alternate between, removes a major reason to fork or wrap Pi, and lets future Bytes work ship to both runtimes by sharing tool source.

**Core outcomes (MVP).**
1. Pi extension that ports the 5 personas via runtime-enforced `delegate_*` tools (not prompt-only).
2. 1:1 port of the 5 bundled tools (`hashline_edit`, `ast_grep_search`, `ast_grep_replace`, `grep`, `glob`) reusing existing TS source where feasible.
3. Functional parity of the 3 MCP servers as 5 custom HTTP tools with canonical names (`websearch_search`, `websearch_fetch`, `context7_resolve_library_id`, `context7_query_docs`, `grep_app_search_github`).
4. Hashline post-processing on `read`/`write`, `<available_resources>` injection, and Copilot `x-initiator` header.
5. `/setup-models` wizard writing safe JSON to `~/.pi/agent/settings.json`.
6. Buffered file logger and configurable enable/disable per tool and per sub-agent.

**Non-goals to protect.**
- No replacement of Pi's built-in `read`/`write`/`edit` tools (only intercept output).
- No permission system port — Pi has none.
- No global model fallback chain (deferred to v2).
- No JSONC support for settings (Pi disallows).
- Beads/theme not bundled.

**Delivery success.** v0.1.0 published to npm, installable via `pi install npm:@blackbytes/pi-blackbytes`, all 14 tools register and respect config, integration tests cover both success and error paths for the four critical handlers (`before_agent_start`, `before_provider_request`, `tool_result`, nested sub-agent runner) plus config loading.

---

## 2. Scope Framing

**MVP (G1–G12 in the PRD §2.1):** all twelve goals.

**Explicitly deferred:**
- Permission map (Pi lacks the primitive).
- Global model fallback chain.
- Replacing Pi's edit tool (only `hashline_edit` runs in parallel).
- Beads integration, theme bundling.

**Boundary notes.**
- `bytes` persona is **not** exposed as a `delegate_bytes` tool. It manifests as the global system-prompt augmentation and `<available_resources>` block.
- Sub-agent capability is enforced at the **runtime tool-allowlist level**, not just by prompt instructions. If a chosen execution path cannot enforce the allowlist, that path is disqualified for the persona in MVP (PRD §4.4).
- Tool names in PRD §5.1 are the **single public contract**; prompts, skills, `<available_resources>`, docs, and tests must use those exact names.

**Stable assumptions.**
- Target Pi version `>= 0.67.x` and pinned narrowly via peer range.
- Node `>= 20`.
- Settings live in `~/.pi/agent/settings.json` with a top-level `blackbytes` block; other keys must be preserved.

---

## 3. Delivery-Relevant System Understanding

**Pi extension primitives we rely on.**
- `default (pi: ExtensionAPI) => void` entry exported from `dist/index.js`.
- `pi.registerTool` with `@sinclair/typebox` schemas.
- `pi.registerCommand` for `/setup-models` (and optional `/blackbytes-status`).
- Events: `session_start`, `resources_discover`, `before_agent_start`, `model_select`, `before_provider_request`, `tool_call`, `tool_result`, `session_shutdown`.
- `ctx.ui.{select,confirm,input,notify,setStatus,setWidget}` for the wizard.
- `pi.setActiveTools` for filtering — **availability and dynamism** must be confirmed in M0.

**Integration points.**
- Settings file (read on `session_start`, written by `/setup-models`).
- Provider request payload (header + thinking-param mutation).
- Tool result stream (read/write rewrite).
- System prompt assembly (`<available_resources>` + language block).

**Trust boundaries.**
- Settings file is user-owned; never log secret values.
- HTTP tools call third-party services (Exa/Tavily, Context7, grep.app) — secrets stay in memory, never logged, never echoed in errors.
- Nested sub-agent sessions inherit `cwd` and an allowlisted env subset only.

**Data flow.**
- `session_start` → load+validate config → compute the **single enabled-set** of tools/sub-agents/skills → register only that set.
- Each turn: `before_agent_start` augments the system prompt → `model_select` caches family → `before_provider_request` mutates payload → tools execute → `tool_result` rewrites read/write outputs.

**State ownership.**
- Per-session config snapshot held in a module-level singleton populated at `session_start` (immutable for the session).
- Active model family cache invalidated on each `model_select`.
- Logger owns its own buffer and rotation state.

**Operational constraints.**
- `session_start` budget: < 200ms.
- `tool_result` overhead: < 50ms average.
- Package size: < 500KB gzipped.
- Logs rotate daily, capped at 10MB.

**Concurrency / consistency concerns.**
- `/setup-models` writes settings concurrently with a possibly running Pi process — write atomically (write-temp + rename) and re-read before merge.
- Nested Pi sessions must propagate cancellation from the parent `signal`.

**External dependencies.**
- `@mariozechner/pi-coding-agent` (peer, pinned narrow), `@sinclair/typebox`, `zod@^4`, optional `fast-glob`/`ripgrep`, `ast-grep` binary in PATH for ast-grep tools.
- HTTP services: Exa/Tavily, Context7, grep.app.

---

## 4. Workstream Decomposition

### WS-A — Project skeleton & config plane
**Purpose.** Stand up the package, the entry point, the event-subscription bootstrap, and the config loader/validator. Without this, no other work can land.
**Produces.** `package.json` with `pi` field, `src/index.ts`, `src/bootstrap.ts`, `src/config/{loader,schema}.ts`, `src/shared/logger.ts`, baseline tests.
**Considerations.** Compute the **single enabled-set** here so every subscriber agrees on what is active (PRD §5.1 activation semantics). All handler failures must be caught and surfaced via `ctx.ui.notify` without crashing Pi.
**Risks.** Pi event signature drift; settings file race during writes.
**Interfaces.** Exposes `getConfig()`, `getEnabledSet()`, `logger` for every other workstream.

### WS-B — Feasibility spike (M0)
**Purpose.** Resolve the three open questions blocking M1/M4 (PRD §9 Q1–Q3) before any implementation work commits to a path.
**Produces.** A short decision record (`docs/decisions/m0-feasibility.md`) chosen path + fallback for: (a) nested session execution (`AgentSession` programmatic vs `pi -p` subprocess), (b) header injection in `before_provider_request`, (c) dynamic `pi.setActiveTools` semantics, (d) tool-allowlist enforcement for nested sessions, (e) cancellation/timeout/result-transport contract, (f) recursion guard.
**Considerations.** Output of M0 directly constrains WS-A bootstrap (active-tools strategy) and WS-F (sub-agent runner). M1 and M4 do not begin until this lands.
**Risks.** Pi may not expose a programmatic `AgentSession`; subprocess fallback must be acceptable on perf and on enforcing tool allowlists.

### WS-C — Bundled tools port
**Purpose.** Bring `hashline_edit`, `ast_grep_search`, `ast_grep_replace`, `grep`, `glob` into Pi via `pi.registerTool`.
**Produces.** `src/tools/{hashline-edit,ast-grep,grep,glob}/` and tests.
**Considerations.** Reuse logic from existing TS source; only swap the runtime adapter to TypeBox + Pi tool surface. Respect `disabled_tools`. ast-grep tools must fail gracefully when binary is missing.
**Risks.** TypeBox vs original schema drift; ast-grep binary discovery on macOS/Linux.

### WS-D — HTTP-backed tools (MCP replacements)
**Purpose.** Replace MCP servers with custom HTTP tools using the canonical names from PRD §5.1.
**Produces.** `src/tools/{websearch,context7,grep-app}/` exposing five tools.
**Considerations.** Each tool needs default timeout, normalized error shape, secret redaction, explicit retry-or-no-retry per provider, and config-driven API keys (PRD §6 HTTP resilience). websearch supports either Exa or Tavily based on config.
**Risks.** API surface drift; secret accidentally logged in error chain.

### WS-E — Post-processing, prompt injection, header mutation
**Purpose.** Implement the cross-cutting handlers that make Bytes Bytes: hashline rewrite, `<available_resources>` injection, Copilot header, and reasoning-effort mapping.
**Produces.** `src/handlers/{tool-result,before-agent-start,before-provider-request,model-select}.ts`.
**Considerations.** Hashline rewrite must skip non-text payloads, preserve `isError`, guard malformed inputs, and not duplicate prompt blocks across turns (idempotency). Reasoning-effort mapping should only intervene where Pi does not already handle it.
**Risks.** Conflict with Pi internals on `read`/`write` output; double-injecting prompt block on multi-turn sessions.

### WS-F — Sub-agent delegation runner
**Purpose.** Implement `runNestedPi` and the four `delegate_*` tools with persona-specific allowlists, `maxDepth = 1`, timeouts, cancellation propagation, and structured failure normalization.
**Produces.** `src/sub-agents/{runner,explore,oracle,librarian,general}.ts` plus prompt files.
**Considerations.** Strategy fixed by M0. Allowlist is enforced at runtime, never relying solely on prompt. Recursion guard prevents nested `delegate_*` calls inside spawned sessions.
**Risks.** Token/cost amplification; subprocess strategy may not enforce allowlist cleanly — if so, M0 must reject it.

### WS-G — UX surface
**Purpose.** `/setup-models` wizard (and optional `/blackbytes-status`), bundled skills, README, examples.
**Produces.** `src/commands/setup-models.ts`, `skills/{blackbytes-overview,hashline-workflow,delegation}/SKILL.md`, README.
**Considerations.** Wizard writes JSON only, must preserve unrelated keys, dedupe `packages`, validate before write, never log secrets, confirm before overwriting existing `blackbytes` keys, and handle missing/malformed file cases (PRD §6 Config safety).
**Risks.** Settings clobber if write isn't atomic.

### WS-H — Quality gates & release
**Purpose.** Integration tests covering success and error paths for the four critical surfaces, performance/size budgets, README/docs, and v0.1.0 npm publish.
**Produces.** `test/` suite, CI matrix, README, CHANGELOG, npm release.
**Considerations.** PRD §6 explicitly mandates integration tests for `before_agent_start`, `before_provider_request`, `tool_result`, nested runner, and config loading — both paths each.
**Risks.** Pi version drift between dev and release.

---

## 5. Dependency and Sequencing Model

**Hard chain.** WS-B (M0 spike) → WS-A (skeleton) → WS-E + WS-F can begin. WS-C and WS-D can begin in parallel with WS-A as soon as the package skeleton compiles, because they only depend on `pi.registerTool` and config access.

**Soft preferences.**
- WS-E's `<available_resources>` work benefits from WS-C and WS-D being landed (so the block lists realistic tool names), but can be developed against a stub list.
- WS-F prompts can be ported in parallel with the runner once M0 fixes the strategy.
- WS-G wizard can be drafted any time after WS-A, but should land after WS-D (so it can configure websearch/context7 keys).

**Critical path.** WS-B → WS-A → WS-F (sub-agents) is the longest chain because allowlist enforcement and runner contract have the most unknowns. Front-loading M0 is the single biggest risk reducer.

**Parallelizable.** WS-C, WS-D, WS-E, and the prompt files in WS-F can run concurrently once WS-A is up.

**Why this order reduces rework.** Locking nested-session strategy and active-tools dynamism in M0 prevents two of the highest-impact rewrites: changing how `delegate_*` tools execute, and changing how the enabled-set is propagated.

---

## 6. Key Design and Delivery Decisions

1. **Single source of truth for enabled tools/sub-agents.** Compute once at `session_start`; every event handler, the `<available_resources>` injection, `resources_discover`, and `/blackbytes-status` read from the same set. Rationale: prevents drift between what the model is told vs what's actually invocable. Consequence: dynamic enable/disable mid-session is **not** supported in MVP.
2. **Runtime allowlist enforcement for sub-agents.** Persona capability is enforced where the nested session executes, not via prompt. Rationale: prompt-only "you are read-only" is a known footgun. Consequence: if subprocess path can't enforce allowlist, MVP must use programmatic API.
3. **`maxDepth = 1` for nested delegation.** Sub-agents cannot call `delegate_*` again. Rationale: cost control and recursion safety. Consequence: oracle/librarian results are final; chained reasoning happens in the parent.
4. **JSON-only settings, atomic write.** Wizard reads → merges → validates → writes via temp + rename. Rationale: PRD bans JSONC; concurrent Pi reads must never see partial files. Consequence: no inline comments allowed; document this in README.
5. **Hashline rewrite scope is narrow.** Only `read`/`write` text payloads; `isError` preserved verbatim; never touch Pi's `edit` tool output. Rationale: PRD §4.5 explicitly forbids breaking Pi's edit. Consequence: `hashline_edit` lives in parallel; users opt into it as a separate tool.
6. **Idempotent prompt augmentation.** `<available_resources>` injection detects an existing block before appending. Rationale: PRD §6 prompt-safety. Consequence: implement a stable sentinel comment around the block.
7. **HTTP tools have explicit retry policy per provider.** No silent retry loops. Rationale: PRD §6 HTTP resilience. Consequence: each tool documents its policy in its source header.
8. **Secrets never reach logs or error messages.** Logger and error normalization redact known secret-bearing fields. Rationale: PRD §6 Security/Observability. Consequence: provider error envelopes are normalized through a redaction step before anyone sees them.
9. **No drop-in replacement of Pi's `bytes`.** This is a superset/override delivered via global system-prompt augmentation. Rationale: PRD §2.3 non-goal. Consequence: README must explain this clearly.

---

## 7. Risks, Ambiguities, and Assumptions

**Open questions (PRD §9).**
- Q1 `AgentSession` programmatic API existence — **must resolve in M0**, blocks WS-F.
- Q2 `before_provider_request` header mutability — **must resolve in M0**, blocks WS-E (header path).
- Q3 `pi.setActiveTools` dynamism — **must resolve in M0**, drives WS-A enabled-set strategy.
- Q4 model fallback chain in MVP — answered: **deferred** (PRD §2.2). No further action.
- Q5 bundle `bytes` as skill-first vs global injection — answered: **global injection** for MVP per PRD §4.6 default. Re-evaluate post-launch.

**Carried-forward risks.**
- Pi event signature drift between minor versions → narrow peer range + CI matrix.
- Nested sub-agent token cost → expose disable flag (`disabled_sub_agents`).
- Settings clobber from concurrent edits → atomic write + re-read pattern.
- HTTP provider outage → normalized error result, no retry loops, surface clearly.

**Assumptions taken to keep planning stable.**
- `ExtensionAPI` exposes `pi.registerTool`, `pi.registerCommand`, `pi.on`, `pi.setActiveTools`, `pi.appendEntry`, and event payload shapes per PRD §4.
- `tool_result` event allows mutating `content` and respecting `isError`.
- Pi installs the package such that `skills/**/SKILL.md` are discoverable via `resources_discover`.

---

## 8. Execution Slices / Phases

### Slice 0 — Feasibility (M0, ~0.5 wk)
- Objective: lock all M0 decisions in a record.
- Workstreams: WS-B.
- Dependencies: none.
- Validation: decision record exists, reviewed; lists chosen path + fallback per question.
- After it lands: WS-A and WS-F can start with confidence.

### Slice 1 — Skeleton & config plane (M1, ~1 wk)
- Objective: package compiles, registers no tools, loads + validates config, logs version, computes empty enabled-set.
- Workstreams: WS-A.
- Dependencies: Slice 0.
- Validation: `session_start` integration test (success + malformed config); logger rotates; size budget tracked.
- After it lands: every other workstream has a target to plug into.

### Slice 2 — Bundled + HTTP tools (M2, ~1.5 wk)
- Objective: 5 bundled + 5 HTTP tools registered, configurable, tested.
- Workstreams: WS-C, WS-D (parallel).
- Dependencies: Slice 1.
- Validation: per-tool unit tests; HTTP tools tested against mocked transport; `disabled_tools` honored.
- After it lands: hashline/ast-grep/web tools usable end-to-end.

### Slice 3 — Cross-cutting handlers (M3, ~1 wk)
- Objective: hashline `tool_result`, `<available_resources>` injection, Copilot header, reasoning param mapping.
- Workstreams: WS-E.
- Dependencies: Slice 2 (so the resources block lists real tools).
- Validation: integration tests for each handler with success + error paths; idempotency test for prompt injection.
- After it lands: agent feels like Bytes when chatting.

### Slice 4 — Sub-agent delegation (M4, ~1.5 wk)
- Objective: 4 `delegate_*` tools with runner, allowlist enforcement, timeouts, cancellation, structured failure.
- Workstreams: WS-F.
- Dependencies: Slice 1; M0 strategy.
- Validation: integration tests for runner success/timeout/cancellation/allowlist-violation; recursion guard test.
- After it lands: full persona stack usable.

### Slice 5 — UX & skills (M5, ~1 wk)
- Objective: `/setup-models` wizard, bundled skills, README, optional `/blackbytes-status`.
- Workstreams: WS-G.
- Dependencies: Slice 2 (wizard needs to know what to configure).
- Validation: wizard tests for missing/malformed/concurrent settings; skills load via `resources_discover`.
- After it lands: first-run UX is complete.

### Slice 6 — QA & release (M6, ~1 wk)
- Objective: integration test matrix complete, perf/size budgets verified, npm publish v0.1.0.
- Workstreams: WS-H.
- Dependencies: all prior slices.
- Validation: CI green on Pi latest pinned; package install + load smoke test; CHANGELOG; npm publish.

---

## 9. Validation and Acceptance Framing

**Functional.**
- Each of 14 tools registers when enabled and is absent when disabled.
- Hashline rewrite produces `LINE#ID|content` for `read`, line-count summary for `write`, no-ops on non-text/`isError`.
- `<available_resources>` block appears once per session, lists exactly the enabled-set, and matches PRD §5.1 names.
- Copilot header mutation observed only when provider is Copilot.
- `delegate_*` tools spawn nested sessions with the documented allowlist; allowlist violations are blocked at runtime; `maxDepth = 1` enforced.

**Integration.**
- The five mandatory test surfaces from PRD §6: `before_agent_start`, `before_provider_request`, `tool_result`, nested runner, config loading — each covers success and error paths.
- `/setup-models` end-to-end: missing file, malformed file, concurrent edit, key preservation, secret redaction in logs.

**Security.**
- Logs assertion test: no occurrence of API key strings supplied via fixtures.
- Error envelope assertion test for HTTP tools: no header/query secrets in messages.

**Operational.**
- `session_start` < 200ms, average `tool_result` overhead < 50ms (microbenchmark in CI).
- Package gzipped size assertion in CI < 500KB.

**Failure modes.**
- Pi event handler throws → caught, logged, `ctx.ui.notify("error", ...)`, session continues.
- HTTP timeout → normalized failure result, no retry storm.
- Nested session cancelled → `delegate_*` returns structured cancellation result.

**Regression expectations.**
- Pi's `read`/`write`/`edit` outputs unchanged when `hashline_edit` config is `false`.
- Settings keys outside `blackbytes` block are byte-for-byte preserved by `/setup-models`.

---

## 10. Task Graph Mapping

**Top-level beads (one per workstream + a release umbrella).**
- `feasibility-spike` (WS-B / M0)
- `skeleton-and-config` (WS-A / M1)
- `bundled-tools` (WS-C / M2 part 1)
- `http-tools` (WS-D / M2 part 2)
- `crosscutting-handlers` (WS-E / M3)
- `sub-agents` (WS-F / M4)
- `ux-and-skills` (WS-G / M5)
- `qa-and-release` (WS-H / M6)

**Child decomposition guidance.**
- `feasibility-spike` → one leaf per question (Q1 nested-session, Q2 header mutation, Q3 active-tools dynamism, Q4 allowlist enforcement strategy, Q5 result transport + cancellation contract). Closing the umbrella requires the decision record file.
- `skeleton-and-config` → leaves: package init, entry point, bootstrap event wiring, config schema (Zod), config loader + atomic safety, logger + rotation, enabled-set computation, baseline tests.
- `bundled-tools` → one leaf per tool (5), plus a shared TypeBox-schema helper leaf.
- `http-tools` → leaves: shared HTTP client (timeout + redaction + error normalization), websearch_search, websearch_fetch, context7_resolve_library_id, context7_query_docs, grep_app_search_github.
- `crosscutting-handlers` → leaves: hashline rewrite for `read`, normalize for `write`, `<available_resources>` injection (idempotent), Copilot header, reasoning-effort mapping + `model_select` cache.
- `sub-agents` → leaves: nested runner (using M0 strategy), allowlist enforcement, recursion guard, four persona tools (each with its own prompt file), failure normalization.
- `ux-and-skills` → leaves: `/setup-models` wizard (with safe write), 3 bundled skills, README, optional `/blackbytes-status`.
- `qa-and-release` → leaves: integration tests for the five mandatory surfaces, perf/size CI checks, README/CHANGELOG, npm publish.

**Cross-workstream dependency edges to encode explicitly.**
- All non-feasibility top-level beads depend on `feasibility-spike` (decision record).
- `bundled-tools` and `http-tools` depend on `skeleton-and-config`.
- `crosscutting-handlers.<available-resources>` depends on `bundled-tools` and `http-tools` having registered (so the block has real names).
- `sub-agents.runner` depends on `feasibility-spike` decisions and `skeleton-and-config`.
- `ux-and-skills.setup-models` depends on `http-tools` (needs to know which keys to ask for) and `skeleton-and-config` (settings loader contract).
- `qa-and-release` depends on every other top-level bead.

**Minimum context every leaf must carry.**
- Pi version target (`>= 0.67.x`), Node `>= 20`.
- Canonical tool names from PRD §5.1 — leaves that touch tool registration, prompts, or `<available_resources>` must list the names verbatim.
- The single-enabled-set rule (PRD §5.1) for any leaf touching activation, listing, or filtering.
- For sub-agent leaves: persona allowlist matrix (PRD §4.4), `maxDepth = 1`, cancellation/timeout requirement, runtime-enforcement-not-prompt-only rule.
- For hashline leaves: skip non-text payloads, preserve `isError`, no duplication across turns, do not modify Pi's `edit` tool output.
- For `/setup-models` leaves: JSON-only, atomic write, preserve unrelated keys, dedupe `packages`, never log secrets, confirm before overwrite.
- For HTTP-tool leaves: timeout default, normalized error envelope, secret redaction, explicit retry policy.
- For test leaves: must cover both success and error paths per PRD §6.

**Decisions that must be duplicated into individual tasks.**
- Runtime allowlist enforcement (Decision 2) — duplicate into every `delegate_*` leaf and the runner.
- Single enabled-set (Decision 1) — duplicate into `skeleton-and-config` activation leaf, `<available_resources>` leaf, `resources_discover`, and `/blackbytes-status`.
- Atomic safe-write of settings (Decision 4) — duplicate into `/setup-models` leaf and any other leaf that touches settings.
- Hashline narrow scope (Decision 5) — duplicate into both hashline leaves.
- Idempotent prompt augmentation (Decision 6) — duplicate into the `<available_resources>` leaf.
- Secret redaction (Decision 8) — duplicate into shared HTTP client leaf, logger leaf, and error-normalization leaf.

**Where to keep extra rationale in comments.**
- The runner leaf (sub-agents) — record why M0 picked the path it did and what the fallback contract is.
- The `<available_resources>` leaf — record the sentinel format chosen for idempotency.
- The `/setup-models` leaf — record the merge algorithm for the `blackbytes` block to avoid silently overwriting user customizations.
