# @blackbytes/pi-blackbytes

Pi coding-agent extension providing local search, web research, documentation lookup, and multi-agent delegation tools.

## Installation

```
pi install bun:@blackbytes/pi-blackbytes
```

## Quick Start

After installation, run the setup wizard to configure providers and API keys:

```
/setup-models
```

Or manually edit `~/.pi/agent/settings.json` to add your configuration (see [Configuration Reference](#configuration-reference) below).

## Configuration Reference

Add a `blackbytes` block to `~/.pi/agent/settings.json`:

```json
{
  "blackbytes": {
    "disabled_tools": [],
    "disabled_sub_agents": [],
    "hashline_edit": true,
    "copilot_initiator_header": true,
    "websearch": { "provider": "exa", "api_key": "YOUR_EXA_KEY" },
    "context7": { "api_key": "YOUR_CONTEXT7_KEY" },
    "sub_agents": { "model": "YOUR_MODEL_ID", "reasoningEffort": "medium" }
  }
}
```

**Notes:**
- The settings file must be valid JSON (no comments, no trailing commas — JSONC is not supported).
- The enabled tool set is computed once at session start and remains fixed for the duration of the session.
- `disabled_tools` accepts canonical tool names (see [Tools](#tools) below).
- `disabled_sub_agents` accepts agent names: `explore`, `oracle`, `librarian`, `general`.
- `websearch.provider` accepts `"exa"` or `"tavily"`.

## Tools

### Local Search and Edit

| Tool | Description |
|------|-------------|
| `glob` | File pattern matching with 100-file cap and 60-second timeout |
| `grep` | Content search with regex using ripgrep with Node.js fallback |
| `ast_grep_search` | AST-aware code pattern search across 25 languages |
| `ast_grep_replace` | AST-aware code rewrite with dry-run as default |
| `hashline_edit` | Precise LINE#ID anchored file editing (see [hashline_edit](#hashline_edit)) |

### Web and Documentation

| Tool | Description |
|------|-------------|
| `websearch_search` | Web search via Exa or Tavily |
| `websearch_fetch` | Fetch and convert URL content to markdown or text |
| `context7_resolve_library_id` | Resolve a library name to its Context7 ID |
| `context7_query_docs` | Query library documentation via Context7 |
| `grep_app_search_github` | Search code patterns across public GitHub repositories |

### Delegation

| Tool | Description |
|------|-------------|
| `delegate_explore` | Read-only codebase search (grep, glob, read, ast_grep_search) |
| `delegate_oracle` | High-reasoning read-only consultation for hard problems |
| `delegate_librarian` | Documentation and cross-repository research |
| `delegate_general` | Full-access implementation executor |

## hashline_edit

`hashline_edit` is a complementary editing tool, not a replacement for Pi's native edit. It uses LINE#ID anchors (e.g., `11#XJ`) derived from a file read to identify exact edit targets, making it resilient to surrounding context changes.

**Workflow:**

1. Read the target file to obtain LINE#ID tags.
2. Identify the lines to change using their `{line_number}#{hash_id}` tags.
3. Submit a single edit call with all related operations batched.
4. Re-read the file before issuing another edit call on the same file.

**Key properties:**
- All edits in one call reference the original file state (snapshot semantics). Do not adjust line numbers for prior edits in the same call — the system applies them bottom-up automatically.
- Supports `replace`, `append`, and `prepend` operations.
- Range replacements use `pos` and `end` to define an inclusive block.
- Passing `lines: null` deletes the targeted lines.

Load the `hashline-workflow` skill for the full workflow guide.

## Delegation

Use delegation to offload work to a specialized sub-agent:

- **`delegate_explore`** — Searching a codebase for patterns, symbols, or files. Read-only. Fast and low cost.
- **`delegate_oracle`** — Hard architectural decisions, complex debugging, high-stakes reasoning. Read-only and expensive; use sparingly.
- **`delegate_librarian`** — Looking up library internals, fetching remote documentation, or finding usage examples across open-source repositories.
- **`delegate_general`** — Heavy implementation work: writing, editing, and verifying changes across multiple files. Receives all tools except the `delegate_*` tools to prevent recursion.

Load the `delegation` skill for detailed guidance on when to use each agent.

## Bundled Skills

| Skill | Description |
|-------|-------------|
| `blackbytes-overview` | Orientation to the extension, its tools, and configuration |
| `hashline-workflow` | Step-by-step LINE#ID editing workflow |
| `delegation` | Decision guide for choosing the right delegate agent |

Skills are loaded via Pi's skill system and inject detailed instructions into the agent context.

## /setup-models Command

`/setup-models` is an interactive wizard that walks through provider selection and API key entry for websearch and Context7. It writes configuration atomically and preserves any existing settings in the file.

Run it any time to update keys or switch providers without editing JSON by hand.

## Troubleshooting

**Websearch or Context7 tools are not working.**
Check that `websearch.api_key` and `context7.api_key` are set in your `settings.json`. Without valid keys, those tools will fail or be unavailable.

**A tool is missing from the agent.**
Check `disabled_tools` in your config. Remove the tool name from the array to re-enable it. Reload the session after saving.

**AST search or replace tools fail.**
`ast_grep_search` and `ast_grep_replace` require `ast-grep` (`sg`) to be installed and on your PATH. Install it from [ast-grep.github.io](https://ast-grep.github.io) or via your package manager.

**grep is slow.**
`grep` prefers `rg` (ripgrep) for performance. If `rg` is not found, it falls back to a Node.js implementation which is slower on large codebases. Install ripgrep from [github.com/BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep).
