# @blackbytes/pi-blackbytes

Pi coding-agent extension that provides local search tools, direct HTTP replacements for the websearch/context7/grep.app MCP surfaces, hashline-based editing, and delegated sub-agents for exploration, research, consultation, and implementation.

## Installation

```bash
pi install bun:@blackbytes/pi-blackbytes
```

## Quick start

Run the setup wizard after installation:

```bash
/setup-models
```

The wizard configures provider credentials, websearch, optional Context7 access, and Blackbytes-specific settings in `~/.pi/agent/settings.json` (or `$PI_AGENT_DIR/settings.json`).

## Pi commands

| Command | Purpose |
|---|---|
| `/setup-models` | Interactive setup for provider keys, websearch, Context7, and related Blackbytes settings |
| `/blackbytes-status` | Print enabled tools, enabled sub-agents, enabled skills, and the current redacted `blackbytes` config |

## Configuration

Blackbytes reads the top-level `blackbytes` object from the Pi settings file.

```json
{
  "blackbytes": {
    "disabled_tools": [],
    "disabled_sub_agents": [],
    "hashline_edit": true,
    "copilot_initiator_header": true,
    "websearch": {
      "provider": "exa",
      "exa_api_key": "YOUR_EXA_KEY"
    },
    "context7": {
      "api_key": "YOUR_CONTEXT7_KEY"
    },
    "sub_agents": {
      "oracle": {
        "model": "openai/gpt-5.4",
        "reasoningEffort": "high",
        "temperature": 0.2
      },
      "general": {
        "model": "openai/gpt-5.4"
      }
    }
  }
}
```

### Supported keys

| Key | Type | Meaning |
|---|---|---|
| `disabled_tools` | `string[]` | Disables specific public tool names for the entire session |
| `disabled_sub_agents` | `("explore" \| "oracle" \| "librarian" \| "general")[]` | Disables delegate tools by agent name |
| `hashline_edit` | `boolean` | Enables hashline rewriting for Pi `read`/`write` tool results |
| `copilot_initiator_header` | `boolean` | Registers the GitHub Copilot provider header `x-initiator: agent` |
| `websearch.provider` | `"exa" \| "tavily"` | Selects the websearch backend |
| `websearch.exa_api_key` | `string` | Exa credential |
| `websearch.tavily_api_key` | `string` | Tavily credential |
| `context7.api_key` | `string` | Context7 credential |
| `sub_agents.<name>.model` | `string` | Per-agent model override |
| `sub_agents.<name>.reasoningEffort` | `string` | Per-agent reasoning override passed to nested sessions |
| `sub_agents.<name>.temperature` | `number` | Per-agent temperature override |

### Configuration notes

- The settings file is strict JSON. Comments and trailing commas are not supported.
- The enabled tool/sub-agent set is computed once at `session_start` and remains fixed for that session.
- Unknown keys inside `blackbytes` are preserved by the parser, so wizard-managed passthrough values can coexist with the validated Blackbytes settings.
- `disabled_tools` uses public tool names such as `hashline_edit` or `context7_query_docs`.
- `disabled_sub_agents` uses agent names, not tool names: `explore`, `oracle`, `librarian`, `general`.

## Tool surface

### Bundled local tools

| Tool | Purpose |
|---|---|
| `glob` | Fast file pattern matching with safety limits |
| `grep` | Regex content search with include filters and multiple output modes |
| `ast_grep_search` | AST-aware structural search across 25 languages |
| `ast_grep_replace` | AST-aware structural rewrite with dry-run default |
| `hashline_edit` | LINE#ID-anchored file editing with snapshot semantics |

### HTTP-backed tools

| Tool | Purpose |
|---|---|
| `websearch_search` | Web search through Exa or Tavily |
| `websearch_fetch` | Fetch and convert a specific URL |
| `context7_resolve_library_id` | Resolve a library/package to a Context7 ID |
| `context7_query_docs` | Query current library documentation and examples from Context7 |
| `grep_app_search_github` | Search code patterns across public GitHub repositories |

### Delegate tools

| Tool | Purpose |
|---|---|
| `delegate_explore` | Read-only codebase discovery for “where is X?” work |
| `delegate_oracle` | Read-only high-reasoning consultation for difficult debugging or design questions |
| `delegate_librarian` | Read-only docs, web, and cross-repository research |
| `delegate_general` | Full-access execution for well-scoped multi-file implementation work |

Blackbytes injects a compact, capability-aware prompt overlay plus an `<available_resources>` block into the primary agent prompt. The overlay is rendered from the session's enabled tools/sub-agents, uses model-family-specific formatting adapters, and falls back to a minimal safe policy layer when runtime state is incomplete.

## `hashline_edit`

`hashline_edit` works alongside Pi's native `edit` tool. It is optimized for precise, low-ambiguity edits by anchoring each mutation to a tagged line reference from `read` output.

### Workflow

1. Read the file first and copy the `LINE#ID` anchors.
2. Build one `hashline_edit` call per file with all related edits batched together.
3. Use `replace`, `append`, or `prepend` against the copied anchors.
4. Re-read the file before issuing a second `hashline_edit` call on that same file.

### Properties

- All edits in a single call refer to the original file snapshot.
- The tool supports single-line replacement, range replacement, deletion, prepend, append, and BOF/EOF insertion.
- `lines: null` deletes the targeted line or range.
- When a mismatch occurs, the tool returns updated anchors for recovery.

Load the bundled `hashline-workflow` skill for the detailed operating guide.

## Delegation model

- **Explore** locates files, symbols, and call sites in the local repository.
- **Oracle** handles hard architectural reasoning and elevated debugging.
- **Librarian** researches external APIs, official docs, and public code examples.
- **General** executes large, well-defined implementation tasks with the session's enabled tool set.

Nested delegation is limited to one level. Delegate sessions do not receive the `delegate_*` tools again, so recursion is blocked at runtime rather than by prompt text alone.

## Bundled skills

| Skill | Purpose |
|---|---|
| `blackbytes-overview` | Orientation to Blackbytes tools, agents, and operating model |
| `hashline-workflow` | Detailed LINE#ID editing workflow |
| `delegation` | Guide for choosing the right delegate agent |

## Development

```bash
bun run lint
bun run build
bun run test

bun run lint:fix
bun run format
bun run bench:startup
bun run bench:tool-result
bun run check:size
```

Recommended verification order:

1. `bun run lint`
2. `bun run build`
3. `bun run test`

## Architecture summary

The extension bootstraps from `src/index.ts` and wires the core session handlers in `src/bootstrap.ts`:

- `session_start` loads config, computes the enabled set, registers tools, and registers delegate agents
- `before_agent_start` renders the capability-aware Bytes v2 overlay, injects `<available_resources>`, and uses a minimal safe fallback if the enabled set is unavailable
- `model_select` caches the current model family for later requests
- `before_provider_request` maps reasoning settings to provider-native fields
- `tool_result` rewrites `read`/`write` results for the hashline workflow
- `session_shutdown` flushes the buffered logger

## Troubleshooting

### Websearch tools are unavailable

Check `blackbytes.websearch.provider` and the matching credential field:

- Exa → `blackbytes.websearch.exa_api_key`
- Tavily → `blackbytes.websearch.tavily_api_key`

### Context7 tools are unavailable

Set `blackbytes.context7.api_key`.

### A delegate or tool is missing

Check `disabled_tools` and `disabled_sub_agents`, then start a new session so the enabled set is recomputed.

### `ast_grep_*` fails immediately

Install `ast-grep` (`sg`) and ensure it is on `PATH`.

### `grep` is slower than expected

Install `ripgrep` (`rg`). Blackbytes uses it when available and falls back to a Node.js implementation otherwise.
