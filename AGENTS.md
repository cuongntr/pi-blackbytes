# pi-blackbytes

Pi coding-agent extension that replaces the websearch, context7, and grep.app MCP surfaces with direct HTTP tools, adds bundled local tools (`hashline_edit`, `ast_search`, `ast_replace`, `grep`, `glob`), and exposes delegated sub-agents (`explore`, `oracle`, `librarian`, `general`, `reviewer`).

## Commands

### Development

```bash
bun run build             # bun build src/index.ts -> dist/index.js (+ tsc --emitDeclarationOnly)
bun run test              # bash -c 'node --import tsx --test src/**/*.test.ts'
bun run lint              # biome check src/
bun run lint:fix          # biome check --fix src/
bun run format            # biome format --write src/
bun run typecheck         # tsc --noEmit
bun run bench:startup     # Startup latency benchmark
bun run bench:tool-result # Tool result processing benchmark
bun run check:size        # Package must be < 500KB gzipped
```

Run in order: `lint -> build -> test`.

### Pi commands

- `/setup-models` — interactive per-agent model and thinking level configuration wizard with grouped provider picker, batch shortcuts, and summary confirmation
- `/blackbytes-status` — interactive section-based status viewer with compact overview and drill-down into individual sections
- `/toggle-verbose` — toggle compact vs expanded tool-result rendering

## Architecture

```text
src/index.ts -> bootstrap(pi) -> wires 7 event handlers + 3 commands:
  session_start           -> loads config, computes enabled set, registers compact built-in renderers, tools/sub-agents, sets up branding widget
  before_agent_start      -> renders capability-aware Bytes v2 overlay + <available_resources>
  agent_start             -> captures Pi-effective system prompt to JSONL when system_prompt_log.enabled
  model_select            -> tracks current model family
  before_provider_request -> optional provider-serialized system prompt capture
  tool_result             -> rewrites read/write output for hashline workflow
  session_shutdown        -> flushes logger

  /setup-models           -> interactive per-agent model+thinking wizard with summary
  /blackbytes-status      -> interactive section picker for enabled resources + redacted config
  /toggle-verbose         -> toggles compact/expanded tool output
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
3. Add metadata to `SUB_AGENTS` in `src/config/resource-metadata.ts`
4. Add the icon to `SUB_AGENT_ICONS` in `src/sub-agents/register.ts`
5. Update the hardcoded agent-name lists in the six affected test files (see `src/config/__tests__/enabled-set.test.ts` for the pattern)

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
- `hashline_edit`
- `copilot_initiator_header`
- `compact_tools.enabled`, `compact_tools.default_expanded` (compact render wrappers for Pi built-in read/bash/edit/write/find/ls; `/toggle-verbose` toggles expansion)
- `websearch.provider`, `websearch.exa_api_key`, `websearch.tavily_api_key`
- `context7.api_key`
- `system_prompt_log.enabled`, `.path`, `.capture_agent_start`, `.capture_provider_system`, `.include_nested`, `.dedupe` (opt-in JSONL capture of full system prompts; provider capture extracts only system-like fields)
- `sub_agents.<name>.model`
- `sub_agents.<name>.reasoningEffort`
- `sub_agents.<name>.timeoutMs` (per-agent timeout, 1..3600000 ms; YAML uses `timeout_ms`. Builtin defaults: explore=600000, librarian=900000, oracle=1200000, reviewer=900000, general=1800000)
- `sub_agents.<name>.fallbackModels` (read-only agents only; string[], max 5, unique, non-empty; YAML uses `fallback_models`. `general` and mutating YAML agents are ineligible)
- `sub_agents.<name>.promptMode` (RESERVED — `"static"` is the only safe value; `"append"` throws at runtime ("not yet supported"); YAML uses `prompt_mode`)
- `sub_agents.<name>.temperature` (RESERVED — accepted by schema for forward-compat but NOT passed to the nested Pi CLI; see `/blackbytes-status`)

The schema is `.passthrough()`, so wizard-managed extra keys in the `blackbytes` object are preserved.

### Prompt injection

`before_agent_start` renders a compact Bytes v2 policy overlay from runtime state instead of appending a second static prompt blob. The overlay contains precedence, session-capability, boundary, workflow, and completion sections; it only mentions enabled capabilities, resolves model-family formatting deterministically from the event model or cached family, and falls back to a minimal safe overlay when runtime state is incomplete. The sentinel-delimited augmentation remains idempotent: re-running the handler replaces the existing block instead of appending duplicates.

### Sub-agents

Sub-agents are defined as typed declarations (`SubAgentDeclaration`) and registered via `registerSubAgent()`. Builtin declarations live in `src/sub-agents/{explore,oracle,librarian,general,reviewer}.ts`. User-defined agents are loaded from YAML files via `src/sub-agents/loader.ts`. All agents spawn nested `pi -p` sessions through `src/sub-agents/runner.ts`, which forces `--no-session`, `--no-context-files`, and (when reasoning is configured) `--thinking <effort>` on the nested CLI. Delegate allowlists are enforced at runtime, and nested sessions do not receive `delegate_*` tools again.

Read-only sub-agents (explore, oracle, librarian, reviewer) each declare a `prependSystemPrompt` hook that builds a lightweight (~4 KB) runtime overlay via `src/sub-agents/runtime-overlay.ts`. The overlay carries current date, working directory, and final tool allowlist, and is bounded with `redactSecrets` to strip sensitive values. The General sub-agent uses the larger (~8 KB) safety overlay from `src/sub-agents/general-safety-overlay.ts` instead, which additionally includes AGENTS.md-derived constraints.

### Tool rendering

Tool result rendering is split into three layers:

1. **Compact builtins** (`src/tools/compact-tools/`): wraps Pi's `read`, `bash`, `edit`, `write`, `find`, `ls` with one-line `✓`/`✗` summaries and partial states (`Reading...`, `Running...`).
2. **Extension tools** (`src/tools/_shared/stats-render.ts`): `buildStatsRenderResult()` factory provides `✓`/`✗` status icons, partial-state messages (`Searching...`, `Fetching...`, etc.), and collapsed summaries for all bundled and HTTP-backed tools.
3. **Sub-agents** (`src/sub-agents/render.ts`): `SubAgentResultComponent` renders a live-updating header with status icon (`✓`/`✗`/`⚠`), elapsed time, tool call count, current tool with argument summary, output chars, model, and cost. Expanded view shows a tool activity timeline (last 30 calls with `✓`/`▸` icons, names, arg summaries, durations). Progress is driven by `createProgressReporter()` in `register.ts`, which tracks tool execution via `tool_execution_start`/`tool_execution_end` events and captures argument summaries from `toolcall_end` events.

Tool icons are unique per tool to avoid visual ambiguity when scanning call lines. The icon map for sub-agents lives in `SUB_AGENT_ICONS` in `src/sub-agents/register.ts`.

## Code style

- Biome: 2-space indent, double quotes, semicolons, 100-char line width
- ESM only (`"type": "module"`), Node16 module resolution
- All relative imports use `.js` extensions
- Tests live in `src/**/*.test.ts`
- Use `describe`/`it` from `node:test` and assertions from `node:assert/strict`
- Test helpers live in `src/test-utils/`

## Key constraints

- Peer dependency: `@mariozechner/pi-coding-agent@^0.67`
- Node `>=20`
- Package budget: `< 500KB` gzipped
- Dependencies stay minimal: `zod`, `@sinclair/typebox`, `fast-glob`, `yaml`
- `processToolResult` returns a new object; handlers must write `modified.content` back to the mutable event

---