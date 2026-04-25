# pi-blackbytes

Pi coding-agent extension that replaces the websearch, context7, and grep.app MCP surfaces with direct HTTP tools, adds bundled local tools (`hashline_edit`, `ast_search`, `ast_replace`, `grep`, `glob`), and exposes delegated sub-agents (`explore`, `oracle`, `librarian`, `general`).

## Commands

### Development

```bash
bun run build             # tsc -> dist/
bun run test              # node --import tsx --test 'src/**/*.test.ts'
bun run lint              # biome check src/
bun run lint:fix          # biome check --fix src/
bun run format            # biome format --write src/
bun run bench:startup     # Startup latency benchmark
bun run bench:tool-result # Tool result processing benchmark
bun run check:size        # Package must be < 500KB gzipped
```

Run in order: `lint -> build -> test`.

### Pi commands

- `/setup-models` — interactive Pi-model-to-sub-agent mapping wizard
- `/blackbytes-status` — print enabled resources and redacted config

## Architecture

```text
src/index.ts -> bootstrap(pi) -> wires 6 event handlers + 2 commands:
  session_start           -> loads config, computes enabled set, registers tools/sub-agents
  before_agent_start      -> renders capability-aware Bytes v2 overlay + <available_resources>
  model_select            -> tracks current model family
  before_provider_request -> maps reasoning params by provider family
  tool_result             -> rewrites read/write output for hashline workflow
  session_shutdown        -> flushes logger

  /setup-models           -> interactive config wizard
  /blackbytes-status      -> current enabled resources + redacted config
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

**User-defined sub-agents** are loaded from YAML files in `$PI_AGENT_DIR/sub-agents/*.{yaml,yml}` via `loadYamlDeclarations()`. Conflicts with builtins or earlier YAML files in the same directory are skipped with a diagnostic (not fatal); `/blackbytes-status` surfaces all skipped files and reasons.

### Tool name conventions

Tool names use `snake_case` everywhere (for example `web_search`, `docs_resolve`, `gh_search`). Public tool names must match across:

- the registration function
- `src/config/resource-metadata.ts`
- prompt and skill documentation
- tests and config examples

### Config

Config lives in `~/.pi/agent/settings.json` (or `$PI_AGENT_DIR/settings.json`) under the top-level `blackbytes` key. Schema: `src/config/schema.ts`.

Core settings:

- `disabled_tools` / `disabled_sub_agents`
- `hashline_edit`
- `copilot_initiator_header`
- `websearch.provider`, `websearch.exa_api_key`, `websearch.tavily_api_key`
- `context7.api_key`
- `system_prompt_log.enabled`, `.path`, `.capture_agent_start`, `.capture_provider_system`, `.include_nested`, `.dedupe` (opt-in JSONL capture of full system prompts; provider capture extracts only system-like fields)
- `sub_agents.<name>.model`
- `sub_agents.<name>.reasoningEffort`
- `sub_agents.<name>.timeoutMs` (per-agent timeout, 1..3600000 ms; YAML uses `timeout_ms`. Builtin defaults: explore=120000, librarian=240000, oracle=300000, general=600000)
- `sub_agents.<name>.fallbackModels` (read-only agents only; string[], max 5, unique, non-empty; YAML uses `fallback_models`. `general` and mutating YAML agents are ineligible)
- `sub_agents.<name>.promptMode` (RESERVED — `"static"` is the only safe value; `"append"` throws at runtime ("not yet supported"); YAML uses `prompt_mode`)
- `sub_agents.<name>.temperature` (RESERVED — accepted by schema for forward-compat but NOT passed to the nested Pi CLI; see `/blackbytes-status`)

The schema is `.passthrough()`, so wizard-managed extra keys in the `blackbytes` object are preserved.

### Prompt injection

`before_agent_start` renders a compact Bytes v2 policy overlay from runtime state instead of appending a second static prompt blob. The overlay contains precedence, session-capability, boundary, workflow, and completion sections; it only mentions enabled capabilities, resolves model-family formatting deterministically from the event model or cached family, and falls back to a minimal safe overlay when runtime state is incomplete. The sentinel-delimited augmentation remains idempotent: re-running the handler replaces the existing block instead of appending duplicates.

### Sub-agents

Sub-agents are defined as typed declarations (`SubAgentDeclaration`) and registered via `registerSubAgent()`. Builtin declarations live in `src/sub-agents/{explore,oracle,librarian,general}.ts`. User-defined agents are loaded from YAML files via `src/sub-agents/loader.ts`. All agents spawn nested `pi -p` sessions through `src/sub-agents/runner.ts`. Delegate allowlists are enforced at runtime, and nested sessions do not receive `delegate_*` tools again.

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
- Dependencies stay minimal: `zod`, `@sinclair/typebox`, `fast-glob`
- `processToolResult` returns a new object; handlers must write `modified.content` back to the mutable event

---