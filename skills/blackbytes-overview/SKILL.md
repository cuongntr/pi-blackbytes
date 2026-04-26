# Blackbytes Overview

Blackbytes extends Pi with a local-first engineering toolset, HTTP-backed research tools, a hashline editing workflow, and four delegated sub-agents for specialized work.

---

## Built-in commands

| Command | Purpose |
|---|---|
| `/setup-models` | Map Blackbytes sub-agents to models already available in Pi (`blackbytes.sub_agents.<name>.model`) |
| `/blackbytes-status` | Show enabled tools, enabled sub-agents, enabled skills, and the current redacted config |

---

## Tool Reference

### Bundled local tools

These tools operate on the local repository.

| Tool | Purpose |
|---|---|
| `glob` | File pattern matching by glob |
| `grep` | Regex content search with file filters and multiple output modes |
| `ast_search` | AST-aware structural search using meta-variables |
| `ast_replace` | AST-aware rewrite tool with dry-run default |
| `hashline_edit` | Precise LINE#ID-anchored file editing with snapshot semantics |

### HTTP-backed tools

These tools retrieve information from external services.

| Tool | Purpose |
|---|---|
| `web_search` | Search the web through Exa or Tavily |
| `web_fetch` | Fetch bounded content from a specific URL |
| `docs_resolve` | Resolve a library or package to a Context7 ID |
| `docs_query` | Query up-to-date library documentation and code examples |
| `gh_search` | Search public GitHub code for concrete usage patterns |

### Delegate tools

These tools start specialized sub-agents.

| Tool | Purpose |
|---|---|
| `delegate_explore` | Read-only codebase discovery agent |
| `delegate_oracle` | Read-only high-reasoning consultation agent |
| `delegate_librarian` | Read-only documentation and cross-repo research agent |
| `delegate_general` | Full-access implementation executor |

---

## Operating model

- `session_start` computes a single enabled set for tools and sub-agents.
- `before_agent_start` injects the Bytes prompt augmentation and the current `<available_resources>` block.
- `tool_result` rewrites Pi `read` and `write` results for the hashline workflow when `hashline_edit` is enabled.
- `model_select` and `before_provider_request` map reasoning settings by model family.
- Delegate sessions run with runtime-enforced allowlists and cannot invoke `delegate_*` recursively.

---

## Configuration highlights

Blackbytes reads the top-level `blackbytes` object in `~/.pi/agent/settings.json` (or `$PI_AGENT_DIR/settings.json`).

Important keys:

- `disabled_tools`
- `disabled_sub_agents`
- `hashline_edit`
- `copilot_initiator_header`
- `websearch.provider`
- `websearch.exa_api_key`
- `websearch.tavily_api_key`
- `context7.api_key`
- `system_prompt_log.*` (opt-in system prompt capture)
- `sub_agents.<name>.model`
- `sub_agents.<name>.reasoningEffort`
- `sub_agents.<name>.temperature`

---

## When to use delegation

- Use `delegate_explore` to find where code lives.
- Use `delegate_oracle` for hard debugging and architecture tradeoffs.
- Use `delegate_librarian` when the answer lives outside the local repository.
- Use `delegate_general` when the task is large, well-defined, and execution-heavy.

Load the `delegation` skill for the detailed decision guide.
