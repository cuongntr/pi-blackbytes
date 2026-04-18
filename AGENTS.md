# pi-blackbytes

Pi coding-agent extension that replaces MCP servers (websearch, context7, grep.app) with direct HTTP calls, adds local tools (hashline_edit, ast-grep, grep, glob), and provides sub-agent delegation (explore, oracle, librarian, general).

## Commands

```bash
npm run build          # tsc → dist/
npm test               # node --import tsx --test 'src/**/*.test.ts'
npm run lint           # biome check src/
npm run lint:fix       # biome check --fix src/
npm run format         # biome format --write src/
npm run bench:startup  # Startup latency benchmark
npm run bench:tool-result  # Tool result processing benchmark
npm run check:size     # Package must be < 500KB gzipped
```

Run in order: `lint → build → test`. Tests use Node's built-in test runner (`node:test`), not Jest/Vitest.

## Architecture

```
src/index.ts → bootstrap(pi) → wires 8 event handlers:
  session_start     → loads config, registers ALL tools + sub-agents
  before_agent_start → injects <available_resources> into system prompt
  before_provider_request → maps reasoning effort per model family
  model_select      → tracks current model family
  tool_result       → rewrites hashline_edit tool results
  tool_call         → (TODO)
  resources_discover → (TODO)
  session_shutdown   → flushes logger
```

### Registration flow (critical)
All tools and sub-agents MUST be registered in `handleSessionStart()` (`src/handlers/index.ts`). If you add a new tool, you must:
1. Create the register function in `src/tools/<name>/index.ts`
2. Import and call it in `handleSessionStart()`
3. Add the tool name to `DEFAULT_TOOLS` in `src/config/enabled-set.ts`
4. Add it to `MCP_SERVERS` or `BUNDLED_TOOLS` in `src/handlers/before-agent-start.ts` so it appears in `<available_resources>`

### Tool name conventions
Tool names use `snake_case` everywhere (e.g., `websearch_search`, `context7_resolve_library_id`, `grep_app_search_github`). The names in `enabled-set.ts`, `before-agent-start.ts`, and the `registerXxxTool()` functions must all match exactly.

### Config
Config lives in `~/.pi/agent/settings.json` (or `$PI_AGENT_DIR/settings.json`) under a `"blackbytes"` key. Schema: `src/config/schema.ts`. Config controls:
- `disabled_tools` / `disabled_sub_agents` — disable specific tools or agents
- `hashline_edit` — enable/disable hashline rewriting (default: true)
- `copilot_initiator_header` — enable/disable copilot header (default: true)
- `websearch.provider` — `"exa"` or `"tavily"` with corresponding API key
- `sub_agents.<name>.model` — override model per sub-agent

### Sub-agents
Sub-agents spawn `pi -p` subprocesses via `src/sub-agents/runner.ts`. Each delegate tool (explore, oracle, librarian, general) is registered as a regular tool that invokes the runner. The runner passes `reasoningEffort` via `BLACKBYTES_REASONING_EFFORT` env var.

## Code style

- Biome: 2-space indent, double quotes, semicolons, 100-char line width
- `noExplicitAny: off` in biome config — `any` is tolerated but should be avoided
- ESM only (`"type": "module"`), Node16 module resolution
- All imports use `.js` extension (required by Node16 moduleResolution)
- Tests: `src/**/*.test.ts`, colocated next to source. Use `describe`/`it` from `node:test` and `assert` from `node:assert/strict`
- Test helpers in `src/test-utils/`

## Key constraints

- Peer dependency: `@mariozechner/pi-coding-agent@^0.67` — the `ExtensionAPI` type comes from there (`src/types/pi.ts` has a local declaration)
- Package budget: < 500KB gzipped (enforced in CI)
- Node >= 20 required
- Dependencies are minimal: `zod` (config validation), `@sinclair/typebox` (JSON schema for tool params), `fast-glob` (glob tool)
- `processToolResult` in `src/handlers/tool-result.ts` creates a new object — must apply `modified.content` back to the mutable event in the handler

---
<!-- bv-agent-instructions-v2 -->

---

## Beads Workflow Integration

This project uses [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`) for issue tracking and [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) (`bv`) for graph-aware triage. Issues are stored in `.beads/` and tracked in git.

### Using bv as an AI sidecar

bv is a graph-aware triage engine for Beads projects (.beads/beads.jsonl). Instead of parsing JSONL or hallucinating graph traversal, use robot flags for deterministic, dependency-aware outputs with precomputed metrics (PageRank, betweenness, critical path, cycles, HITS, eigenvector, k-core).

**Scope boundary:** bv handles *what to work on* (triage, priority, planning). `br` handles creating, modifying, and closing beads.

**CRITICAL: Use ONLY --robot-* flags. Bare bv launches an interactive TUI that blocks your session.**

#### The Workflow: Start With Triage

**`bv --robot-triage` is your single entry point.** It returns everything you need in one call:
- `quick_ref`: at-a-glance counts + top 3 picks
- `recommendations`: ranked actionable items with scores, reasons, unblock info
- `quick_wins`: low-effort high-impact items
- `blockers_to_clear`: items that unblock the most downstream work
- `project_health`: status/type/priority distributions, graph metrics
- `commands`: copy-paste shell commands for next steps

```bash
bv --robot-triage        # THE MEGA-COMMAND: start here
bv --robot-next          # Minimal: just the single top pick + claim command

# Token-optimized output (TOON) for lower LLM context usage:
bv --robot-triage --format toon
```

#### Other bv Commands

| Command | Returns |
|---------|---------|
| `--robot-plan` | Parallel execution tracks with unblocks lists |
| `--robot-priority` | Priority misalignment detection with confidence |
| `--robot-insights` | Full metrics: PageRank, betweenness, HITS, eigenvector, critical path, cycles, k-core |
| `--robot-alerts` | Stale issues, blocking cascades, priority mismatches |
| `--robot-suggest` | Hygiene: duplicates, missing deps, label suggestions, cycle breaks |
| `--robot-diff --diff-since <ref>` | Changes since ref: new/closed/modified issues |
| `--robot-graph [--graph-format=json\|dot\|mermaid]` | Dependency graph export |

#### Scoping & Filtering

```bash
bv --robot-plan --label backend              # Scope to label's subgraph
bv --robot-insights --as-of HEAD~30          # Historical point-in-time
bv --recipe actionable --robot-plan          # Pre-filter: ready to work (no blockers)
bv --recipe high-impact --robot-triage       # Pre-filter: top PageRank scores
```

### br Commands for Issue Management

```bash
br ready              # Show issues ready to work (no blockers)
br list --status=open # All open issues
br show <id>          # Full issue details with dependencies
br create --title="..." --type=task --priority=2
br update <id> --status=in_progress
br close <id> --reason="Completed"
br close <id1> <id2>  # Close multiple issues at once
br sync --flush-only  # Export DB to JSONL
```

### Workflow Pattern

1. **Triage**: Run `bv --robot-triage` to find the highest-impact actionable work
2. **Claim**: Use `br update <id> --status=in_progress`
3. **Work**: Implement the task
4. **Complete**: Use `br close <id>`
5. **Sync**: Always run `br sync --flush-only` at session end

### Key Concepts

- **Dependencies**: Issues can block other issues. `br ready` shows only unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers 0-4, not words)
- **Types**: task, bug, feature, epic, chore, docs, question
- **Blocking**: `br dep add <issue> <depends-on>` to add dependencies

### Session Protocol

```bash
git status              # Check what changed
git add <files>         # Stage code changes
br sync --flush-only    # Export beads changes to JSONL
git commit -m "..."     # Commit everything
git push                # Push to remote
```

<!-- end-bv-agent-instructions -->
