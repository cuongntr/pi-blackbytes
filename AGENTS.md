# pi-blackbytes

Pi coding-agent extension that replaces the websearch, context7, and grep.app MCP surfaces with direct HTTP tools, adds bundled local tools (`hashline_edit`, `ast_grep_search`, `ast_grep_replace`, `grep`, `glob`), and exposes delegated sub-agents (`explore`, `oracle`, `librarian`, `general`).

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

- `/setup-models` — interactive settings wizard
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

All tools and sub-agents are registered in `handleSessionStart()` (`src/handlers/index.ts`). If you add or rename a tool:

1. Create or update the register function in `src/tools/<name>/...` or `src/sub-agents/<name>.ts`
2. Import and call it from `handleSessionStart()`
3. Add the public name to `src/config/resource-metadata.ts`
4. Ensure any enable/disable behavior still flows through `src/config/enabled-set.ts`

### Tool name conventions

Tool names use `snake_case` everywhere (for example `websearch_search`, `context7_resolve_library_id`, `grep_app_search_github`). Public tool names must match across:

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
- `sub_agents.<name>.model`
- `sub_agents.<name>.reasoningEffort`
- `sub_agents.<name>.temperature`

The schema is `.passthrough()`, so wizard-managed extra keys in the `blackbytes` object are preserved.

### Prompt injection

`before_agent_start` renders a compact Bytes v2 policy overlay from runtime state instead of appending a second static prompt blob. The overlay contains precedence, session-capability, boundary, workflow, and completion sections; it only mentions enabled capabilities, resolves model-family formatting deterministically from the event model or cached family, and falls back to a minimal safe overlay when runtime state is incomplete. The sentinel-delimited augmentation remains idempotent: re-running the handler replaces the existing block instead of appending duplicates.
### Sub-agents

Sub-agents spawn nested `pi -p` sessions through `src/sub-agents/runner.ts`. Delegate allowlists are enforced at runtime, and nested sessions do not receive `delegate_*` tools again.

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
<!-- bv-agent-instructions-v2 -->

---

## Beads Workflow Integration

This project uses [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`) for issue tracking and [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) (`bv`) for graph-aware triage. Issues are stored in `.beads/` and tracked in git.

### Using bv as an AI sidecar

bv is a graph-aware triage engine for Beads projects (`.beads/issues.jsonl`). Use robot flags only; bare `bv` launches an interactive TUI.

```bash
bv --robot-triage
bv --robot-next
bv --robot-triage --format toon
```

### Common bv commands

| Command | Returns |
|---|---|
| `--robot-plan` | Parallel execution tracks with unblock information |
| `--robot-priority` | Priority misalignment detection |
| `--robot-insights` | Graph metrics and critical-path analysis |
| `--robot-alerts` | Stale issues, blockers, priority mismatches |
| `--robot-suggest` | Hygiene suggestions and duplicate detection |
| `--robot-diff --diff-since <ref>` | Changes since a git ref |
| `--robot-graph` | Dependency graph export |

### Common br commands

```bash
br ready
br list --status=open
br show <id>
br create --title="..." --type=task --priority=2
br update <id> --status=in_progress
br close <id> --reason="Completed"
br sync --flush-only
```

### Workflow pattern

1. Run `bv --robot-triage`
2. Claim work with `br update <id> --status=in_progress`
3. Implement the task
4. Close it with `br close <id>`
5. Run `br sync --flush-only`

### Key concepts

- Dependencies block downstream work.
- Priority levels use numbers: P0-P4.
- Common issue types: `task`, `bug`, `feature`, `epic`, `chore`, `docs`, `question`.

### Session protocol

```bash
git status
git add <files>
br sync --flush-only
git commit -m "..."
git push
```

<!-- end-bv-agent-instructions -->
