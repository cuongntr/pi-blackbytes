# pi-blackbytes

Pi coding-agent extension that replaces Pi's MCP-plugin dependency on the websearch, context7, and grep.app surfaces with locally-managed HTTP clients (note: `web_search` / `web_fetch` / `docs_resolve` / `docs_query` are pure REST; `gh_search` is HTTP-transported but still MCP at the protocol layer — see README for the distinction), adds bundled local tools (`hashline_edit` with anchored ops + `replace_text` substring mode + `insert_after` / `insert_before` / `replace_range` aliases + optional `postEditVerify`, atomic write, canonical-path queue, and `[E_*]` error taxonomy; plus `ast_search`, `ast_replace`, `glob`, `look_at`), and exposes delegated sub-agents (`explore`, `oracle`, `librarian`, `general`, `reviewer`).

## Commands

### Development

```bash
bun run check             # lint + typecheck + build + test + package size
bun run build             # bun build src/index.ts -> dist/index.js (+ tsc --emitDeclarationOnly)
bun run test              # node scripts/run-tests.mjs
bun run lint              # biome check src/
bun run lint:fix          # biome check --fix src/
bun run format            # biome format --write src/
bun run typecheck         # tsc --noEmit
bun run bench:startup     # Startup latency benchmark
bun run bench:tool-result # Tool result processing benchmark
bun run check:size        # Package must be < 500KB gzipped
```

Full verification uses `bun run check`. For targeted iteration, run `lint -> typecheck -> build -> test`.

### Pi commands

- `/setup-models` — interactive per-agent model and thinking level configuration wizard with grouped provider picker, batch shortcuts, and summary confirmation
- `/blackbytes-status` — interactive section-based status viewer with compact overview and drill-down into individual sections

## Architecture

```text
src/index.ts -> bootstrap(pi) -> wires 7 event handlers + 2 commands:
  session_start           -> loads config, computes enabled set, registers tools/sub-agents, sets up branding widget
  before_agent_start      -> renders capability-aware Bytes v2 overlay + <available_resources>
  agent_start             -> captures Pi-effective system prompt to JSONL when system_prompt_log.enabled
  model_select            -> tracks current model family
  before_provider_request -> optional provider-serialized system prompt capture
  tool_result             -> rewrites read/write output for hashline workflow
  session_shutdown        -> flushes logger

  /setup-models           -> interactive per-agent model+thinking wizard with summary
  /blackbytes-status      -> interactive section picker for enabled resources + redacted config
```

### Registration flow (critical)

All tools and sub-agents are registered in `handleSessionStart()` (`src/handlers/index.ts`).

**Adding or renaming a tool:**

1. Create or update the register function in `src/tools/<name>/...`
2. Import and call it from `handleSessionStart()`
3. Add the public name to `src/config/resource-metadata.ts`
4. Ensure any enable/disable behavior still flows through `src/config/enabled-set.ts`

**Adding a builtin sub-agent:**

1. Define a declaration with `defineSubAgent()` in `src/sub-agents/<name>.ts`
2. Export the declaration and add it to `BUILTIN_DECLARATIONS` in `src/handlers/index.ts`
3. Add a `<NAME>_METADATA` entry to `src/sub-agents/builtin-metadata.ts` and include it in `BUILTIN_SUB_AGENT_METADATA`; the declaration spreads it and `SUB_AGENTS` is derived automatically.
4. Add the icon to `SUB_AGENT_ICONS` in `src/sub-agents/icons.ts`
5. Add `routing` metadata to the declaration (category, cost, useWhen, avoidWhen, keyTrigger)
6. Update the hardcoded agent-name lists in the affected test files (see `src/config/__tests__/enabled-set.test.ts` for the pattern)

**User-defined sub-agents** are loaded from YAML files in `$PI_AGENT_DIR/sub-agents/*.{yaml,yml}` via `loadYamlDeclarations()`. Conflicts with builtins or earlier YAML files in the same directory are skipped with a diagnostic (not fatal); `/blackbytes-status` surfaces all skipped files and reasons.

### Tool name conventions

Tool names use `snake_case` everywhere (for example `web_search`, `docs_resolve`, `gh_search`). Public tool names must match across:

- the registration function
- `src/config/resource-metadata.ts`
- prompt documentation
- tests and config examples

### Config

Config lives in `~/.pi/agent/settings.json` (or `$PI_AGENT_DIR/settings.json`) under the top-level `blackbytes` key. Schema: `src/config/schema.ts`.

Core settings:

- `disabled_tools` / `disabled_sub_agents`
- `hashline_edit` (boolean shorthand or object: `{ enabled?: boolean, strict_patch?: boolean }`)
  - `hashline_edit.strict_patch` (default `true`) — reject `lines` payloads that include accidental `LINE#ID|` prefixes with `[E_INVALID_PATCH]`. Set to `false` to restore the legacy silent-strip behaviour.
- `ui.bash_wrapper_enabled` (default `true`) — lightweight wrapper for Pi builtin tools such as `bash`, active when the host Pi version exposes a compatible factory (it silently no-ops otherwise). Set `false` to leave Pi's built-in `bash` untouched.
- `ui.bash_max_preview_lines` / `ui.bash_max_expanded_lines` / `ui.bash_dim_output` — bash wrapper output preview limits and colour mode.
- `ui.read_tool_display` (`"compact"` default, or `"preview"`) — collapsed built-in `read` output renders as one line by default while preserving full content for the model/hashline anchors.
- `websearch.provider`, `websearch.exa_api_key`, `websearch.tavily_api_key`
- `context7.api_key`
- `system_prompt_log.enabled`, `.path`, `.capture_agent_start`, `.capture_provider_system`, `.include_nested`, `.dedupe` (opt-in JSONL capture of full system prompts; provider capture extracts only system-like fields)
- `sub_agents.<name>.model`
- `sub_agents.<name>.reasoningEffort`
- `sub_agents.<name>.timeoutMs` (per-agent timeout, 1..3600000 ms; YAML uses `timeout_ms`. Builtin defaults: explore=600000, librarian=900000, oracle=1200000, reviewer=900000, general=1800000)
- `sub_agents.<name>.fallbackModels` (read-only agents only; string[], max 5, unique, non-empty; YAML uses `fallback_models`. `general` and mutating YAML agents are ineligible)
- `sub_agents.<name>.executionMode` (`"sequential"` / `"parallel"`; YAML uses `execution_mode`)
- `sub_agents.<name>.promptMode` (RESERVED — `"static"` is the only safe value; `"append"` throws at runtime ("not yet supported"); YAML uses `prompt_mode`)
- `sub_agents.<name>.artifactCapture` (boolean, default `false`; opt-in persistence of large redacted sub-agent outputs to `$PI_AGENT_DIR/blackbytes/artifacts/sub-agents/<YYYY-MM-DD>/<agent>-<HHmmssSSS>.md`. Capped at 512 KiB per artifact (`MAX_ARTIFACT_BYTES`); outputs under 1 KiB after redaction are skipped; YAML uses `artifact_capture`)
- `sub_agents.<name>.temperature` (RESERVED — accepted by schema for forward-compat but NOT passed to the nested Pi CLI; see `/blackbytes-status`)

Tool rendering: all Blackbytes tools and sub-agents render through a single lightweight, borderless renderer (Claude-style `⏺` call line + `⎿` result indent). There is no on/off toggle. To leave Pi's built-in `bash` untouched, set `blackbytes.ui.bash_wrapper_enabled=false` (it defaults to `true`).

The schema is `.passthrough()`, so wizard-managed extra keys in the `blackbytes` object are preserved.

### Prompt injection

The `before_agent_start` handler renders a capability-aware Bytes v2 policy overlay from runtime state. The overlay contains 15 sections (identity, precedence, autonomy, investigation, session capabilities, skills, hard boundaries, work defaults, tool-use protocol, verification contract, executing-actions-with-care, conditional workflows, markdown format, file references, and completion contract); it only mentions enabled capabilities, builds a concise positive delegation routing matrix from registered sub-agent routing metadata (`SubAgentRoutingMetadata`), resolves model-family formatting deterministically from the event model or cached family, and falls back to a minimal safe overlay when runtime state is incomplete. The sentinel-delimited augmentation remains idempotent: re-running the handler replaces the existing block instead of appending duplicates.

### Sub-agents

Sub-agents are defined as typed declarations (`SubAgentDeclaration`) and registered via `registerSubAgent()`. Builtin declarations live in `src/sub-agents/{explore,oracle,librarian,general,reviewer}.ts`. User-defined agents are loaded from YAML files via `src/sub-agents/loader.ts`. All agents spawn nested `pi -p` sessions through `src/sub-agents/runner.ts`, which forces `--no-session`, `--no-context-files`, and (when reasoning is configured) `--thinking <effort>` on the nested CLI. Delegate allowlists are enforced at runtime, and nested sessions do not receive `delegate_*` tools again.

Declarations carry optional `systemPromptByFamily` (per-model-family prompt overrides) and `routing` (`SubAgentRoutingMetadata`) fields. All five builtins (explore, oracle, librarian, general, reviewer) define GPT-optimized prompt variants selected via `resolveSystemPromptBody()` in `src/sub-agents/prompt-builder.ts` when the configured nested model classifies as GPT family. The GPT variants follow OpenAI's GPT-5.x prompting guidance (outcome-first, top-level `#` headings with `<xml>` semantic blocks for tool/output/stop contracts, explicit anti-filler openers, fewer redundant negative rules). Routing metadata drives the Bytes overlay routing matrix (via `buildOverlayRoutingMatrix()`) and the `/blackbytes-status` Sub-Agent Routing section (via `buildRoutingSummary()`), both in `src/sub-agents/routing.ts`. All five builtin prompts include compact final-output contracts: General requires a Follow-up line in its TASK COMPLETE block; Explore, Oracle, and Librarian include Confidence/Caveats assessments; Reviewer preserves its existing severity findings + verdict contract. Prompt contract regression tests guard these headings against accidental removal.

Each delegation is logged to an in-memory, session-scoped delegation log (`src/sub-agents/delegation-log.ts`) tracking agent, duration, success, tool call count, output size, cost, failure classification (`failureKind`), fallback attempt summaries, and redacted error hints. The log is capped at 100 entries with oldest-first eviction. Runner failures are classified into 10 categories (`DelegateFailureKind`): `failed`, `timed_out`, `cancelled`, `spawn_error`, `recursion_refused`, `cli_usage_error`, `invalid_tool_allowlist`, `provider_or_model_unavailable`, `malformed_jsonl` (JSONL lines starting with `{` that fail parse with no valid `agent_end`), and `killed` (externally signaled child process). The log resets via `resetDelegationLog()` (called from `resetSessionRuntimeState()`). `/blackbytes-status` surfaces per-agent delegation metrics under the "Delegation ROI" section and failure diagnostics under "Sub-Agent Diagnostics".

A pure diagnostics summary builder (`src/sub-agents/diagnostics-summary.ts`) aggregates per-agent configuration, recent failures grouped by kind, YAML loader warnings, and delegation success rate into a testable data structure. A lazy nested Pi availability check (`src/sub-agents/pi-availability.ts`) reports whether the `pi` CLI can be spawned, using a cached probe with a 2-second timeout. A best-effort `getArtifactStats()` helper in `src/sub-agents/artifacts.ts` reports the artifact directory path, total captured count, and most recent artifact (or `unavailable` for missing/unreadable directories) for the Sub-Agent Diagnostics section. All three feed the Sub-Agent Diagnostics section in `/blackbytes-status`.

Read-only sub-agents (explore, oracle, librarian, reviewer) each declare a `prependSystemPrompt` hook that builds a lightweight (~4 KB) runtime overlay via `src/sub-agents/runtime-overlay.ts`. The overlay carries current date, working directory, and final tool allowlist, and is bounded with `redactSecrets` to strip sensitive values. The General sub-agent uses the larger (~8 KB) safety overlay from `src/sub-agents/general-safety-overlay.ts` instead, which additionally includes AGENTS.md-derived constraints.

**Worker sub-agents must stay unaware of token/context limits.** Do not inject token-budget, context-window-size, or "running low on space" awareness into any sub-agent prompt or overlay. Resource pressure is managed structurally — isolation (worker context never enters the parent) plus a tail-preserving cap on returned output (`boundReturnContent` / `MAX_RETURN_CHARS` in `src/sub-agents/runner.ts`) — not by telling the worker to ration itself. Signalling scarcity to an LLM degrades thoroughness (it rushes and skips exploration), so this is a deliberate design choice, not an oversight.

#### Chain executor (REQ-005, internal-only in Phase 2)

`src/sub-agents/chain.ts` exposes a narrow sequential executor that runs 1–5 existing sub-agents in order, threading each step's output to the next under a `## Previous step output (from <agent>)` heading (or `## Previous step output (from <agent>, FAILED: <kind>)` when a step failed under `continueOnFailure: true`). It reuses `runNestedPi()` for each step and does not introduce a new spawn path, fallback-model orchestration, public `delegate_chain` tool, YAML chain DSL, fanout, background polling, or inter-agent chat. Limitations to keep in mind:

- **Internal only** — chains are constructed in code via `executeChain()`; there is no host-registered tool for callers to invoke in Phase 2 (decision deferred to Phase 3, Q-001).
- **Total + per-step timeouts** — `totalTimeoutMs` is a hard cap. Each step's effective timeout is `allocateTimeoutBudget(remaining, remainingSteps)` (floor-allocated, ≥1ms); `step.timeoutMs` overrides the slice and is itself capped at the remaining budget. Mid-chain budget exhaustion is surfaced as a controlled `timed_out` step result (`stoppedEarly: true`, `stoppedAtStep: i`).
- **Stop-on-failure by default** — `continueOnFailure: true` keeps the chain moving past a failure and threads the error content (with the `FAILED:` annotation) into the next step's prompt so it can adapt.
- **No recursive `delegate_*` leakage** — each step still spawns a nested Pi session with the same allowlist enforcement; `runNestedPi()`'s `PI_NESTED_DEPTH` guard prevents a step from spawning another chain.
- **Validation is synchronous** — step count (0/>5), agent names (unknown/disabled), `totalTimeoutMs` (≤0), and any per-step `step.timeoutMs` (≤0 or non-finite) are rejected up front so callers fail loudly before any nested run starts.

#### Artifact capture (REQ-004)

`src/sub-agents/artifacts.ts` is the persistence layer for sub-agent outputs that exceed the return cap (`MAX_RETURN_CHARS = 24_576` in `runner.ts`). It is **opt-in per agent** via `sub_agents.<name>.artifactCapture` and conservative by default (`false`). When enabled and a nested result overflows the cap, `runNestedPi()` calls `captureArtifact()` after redaction and before `boundReturnContent()` truncates the middle; the captured artifact's path is exposed on `DelegateResult.artifactPath` and threaded into the delegation log via `DelegationEntry.artifactPath`. Artifacts are redacted via `redactSecrets()` before write, capped at `MAX_ARTIFACT_BYTES` (512 KiB), skipped when under `MIN_ARTIFACT_CHARS` (1 KiB) after redaction, and cleaned up by `cleanupArtifacts()` after `RETENTION_DAYS` (7 days) using mtime. `/blackbytes-status` reports the artifact directory path, total count, and most recent artifact under the Sub-Agent Diagnostics section.

### Tool rendering

Tool result rendering is split into two layers:

1. **Extension tools** (`src/tools/_shared/stats-render.ts`): `buildStatsRenderResult()` factory provides `✓`/`✗` status icons, partial-state messages (`Searching...`, `Fetching...`, etc.), and collapsed summaries for all bundled and HTTP-backed tools.
2. **Sub-agents** (`src/sub-agents/render.ts`): `SubAgentResultComponent` renders a live-updating header with a status indicator (braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` while running, `✓`/`✗`/`⚠` once complete; the status word itself is dropped), the agent icon and bold name colored by status, elapsed time with progressive precision (`<1ms` → `ms` → `s` → `m s` → `h m`), tool call count, active tool with split coloring (accent icon, `toolTitle` name, muted args) or the last finished tool as `◷ <name>` muted between calls, output chars, smart-formatted cost (`<$0.001` / `$0.004` / `$0.420` / `$1.23` / `$1235`), and a one-line red error hint on failure. Expanded view shows the tool activity timeline (last 30 calls with `✓`/`▸` icons, `toolTitle`-colored names, muted arg summaries, and durations sharing the same progressive precision formatter as the header) followed by the assistant output and a muted footer aggregate `<model> · Tools: 12× read · 4× bash · $0.004` (sorted by count descending, ties broken alphabetically). The spinner is driven by a per-row `setInterval` at `SPINNER_TICK_MS` (100 ms) that calls `context.invalidate()`; the frame is computed from `Date.now()` so parallel delegations stay in sync without a shared counter. Progress is driven by `createProgressReporter()` in `src/sub-agents/progress-reporter.ts`, which tracks tool execution via `tool_execution_start`/`tool_execution_end` events and captures argument summaries from `toolcall_end` events. Path-like argument keys (`path`, `filePath`) are summarised by `truncatePath()` (`src/sub-agents/format.ts`), which collapses the middle to preserve the filename and as many trailing parents as fit; non-path keys fall back to a 50-character tail-cut with ellipsis.

Display-format helpers (`SPINNER_FRAMES`, `getSpinnerFrame`, `formatDuration`, `formatCost`, `truncatePath`) live in `src/sub-agents/format.ts` as pure functions — no theme dependency, no I/O — and are tested independently. The agent icon map (`SUB_AGENT_ICONS`) and the `getAgentIcon(name)` fallback helper (`▸` for unknown agents) live in `src/sub-agents/icons.ts` and are imported by both the call-line renderer (`register.ts`) and the result renderer (`render.ts`) so there is one source of truth.

Tool icons are unique per tool to avoid visual ambiguity when scanning call lines.

## Code style

- Biome: 2-space indent, double quotes, semicolons, 100-char line width
- ESM only (`"type": "module"`), Node16 module resolution
- All relative imports use `.js` extensions
- Tests live in `src/**/*.test.ts`
- Use `describe`/`it` from `node:test` and assertions from `node:assert/strict`
- Test helpers live in `src/test-utils/`

## Key constraints

- Peer dependencies: `@earendil-works/pi-coding-agent@>=0.74.0 <1`, `@earendil-works/pi-tui@>=0.74.0 <1`, `typebox@*`
- Node `>=20`
- Package budget: `< 500KB` gzipped
- Dependencies stay minimal: `zod`, `fast-glob`, `yaml`
- `processToolResult` returns a new object; handlers must write `modified.content` back to the mutable event

---