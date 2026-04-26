# @blackbytes/pi-blackbytes

Pi coding-agent extension that provides local search tools, direct HTTP replacements for the websearch/context7/grep.app MCP surfaces, hashline-based editing, and delegated sub-agents for exploration, research, consultation, implementation, and code review.

## Installation

```bash
pi install bun:@blackbytes/pi-blackbytes
```

## Quick start

Run the setup wizard after installation:

```bash
/setup-models
```

The wizard maps Blackbytes sub-agents to models that Pi already has available in its model registry. Provider credentials and model availability remain Pi-level concerns (for example `/model`, `/login`, or `~/.pi/agent/models.json`); Blackbytes only stores per-sub-agent overrides in `~/.pi/agent/settings.json` (or `$PI_AGENT_DIR/settings.json`).

## Pi commands

| Command | Purpose |
|---|---|
| `/setup-models` | Interactive mapping from Pi-available models to Blackbytes sub-agents (`blackbytes.sub_agents.<name>.model`) |
| `/blackbytes-status` | Print enabled tools, enabled sub-agents, enabled skills, Sub-Agent Snapshot (model/reasoning/allowed tools per agent), YAML diagnostics, and the current redacted `blackbytes` config |

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
    "system_prompt_log": {
      "enabled": false,
      "path": "~/.pi/logs/pi-blackbytes-system-prompts.jsonl",
      "capture_agent_start": true,
      "capture_provider_system": false,
      "include_nested": false,
      "dedupe": true
    },
    "sub_agents": {
      "oracle": {
        "model": "openai/gpt-5.4",
        "reasoningEffort": "high",
        "timeoutMs": 300000,
        "fallbackModels": ["anthropic/claude-opus-4"],
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
| `disabled_sub_agents` | `("explore" \| "oracle" \| "librarian" \| "general" \| "reviewer")[]` | Disables delegate tools by agent name |
| `hashline_edit` | `boolean` | Enables hashline rewriting for Pi `read`/`write` tool results |
| `copilot_initiator_header` | `boolean` | Registers the GitHub Copilot provider header `X-Initiator: agent` |
| `websearch.provider` | `"exa" \| "tavily"` | Selects the web backend. Defaults to `exa` when omitted. |
| `websearch.exa_api_key` | `string` | Exa credential. Overrides `EXA_API_KEY` when set. |
| `websearch.tavily_api_key` | `string` | Tavily credential. Overrides `TAVILY_API_KEY` when set. |
| `context7.api_key` | `string` | Context7 credential |
| `system_prompt_log.enabled` | `boolean` | Opt-in full system-prompt capture to a JSONL file. Defaults to `false` because prompts may contain project context or secrets. |
| `system_prompt_log.path` | `string` | Optional log file path. Defaults to `~/.pi/logs/pi-blackbytes-system-prompts.jsonl`; relative paths resolve against the current working directory. |
| `system_prompt_log.capture_agent_start` | `boolean` | Capture Pi's final effective system prompt at `agent_start` (after `before_agent_start` chaining). Defaults to `true`. |
| `system_prompt_log.capture_provider_system` | `boolean` | Also capture provider-serialized system/developer/systemInstruction fields at `before_provider_request`. Defaults to `false`; user messages are not logged by the extractor. |
| `system_prompt_log.include_nested` | `boolean` | Include nested sub-agent Pi sessions (`PI_NESTED_DEPTH > 0`). Defaults to `false`. |
| `system_prompt_log.dedupe` | `boolean` | Avoid repeated identical prompt entries per session/source/provider shape. Defaults to `true`. |
| `sub_agents.<name>.model` | `string` | Per-agent model override, preferably the canonical Pi model reference `provider/model-id` selected by `/setup-models`. Omit/clear to inherit the host Pi model. |
| `sub_agents.<name>.reasoningEffort` | `string` | Per-agent reasoning override passed to nested sessions |
| `sub_agents.<name>.timeoutMs` | `integer` (1..3600000) | Per-agent execution timeout in milliseconds. Builtin defaults: explore=120000, librarian=240000, oracle=300000, general=600000, reviewer=240000. YAML equivalent: `timeout_ms`. |
| `sub_agents.<name>.fallbackModels` | `string[]` (max 5) | Ordered list of fallback models tried on `provider_or_model_unavailable` failures. Read-only agents only (`general` and mutating YAML agents are ineligible). YAML equivalent: `fallback_models`. |
| `sub_agents.<name>.promptMode` | `"static" \| "append"` | **RESERVED / PARTIALLY IMPLEMENTED** - `"static"` (default) is the only safe value. `"append"` is accepted by the schema but throws at runtime ("not yet supported"). YAML equivalent: `prompt_mode`. |
| `sub_agents.<name>.temperature` | `number` | **RESERVED / UNSUPPORTED** - accepted by schema for forward-compatibility but NOT passed to the nested Pi CLI (Pi does not accept `--temperature`). Visible under "Reserved / Unsupported Settings" in `/blackbytes-status`. |

### Configuration notes

- The settings file is strict JSON. Comments and trailing commas are not supported.
- Per-agent config (model, reasoningEffort, reserved fields) is resolved once at `session_start` into an immutable snapshot. Changes to `settings.json` after startup take effect on the next session only.
- Unknown keys inside `blackbytes` are preserved by the parser, so wizard-managed passthrough values can coexist with the validated Blackbytes settings.
- `disabled_tools` uses public tool names such as `hashline_edit` or `docs_query`. Disabled tools are enforced through every nested delegate path - builtin agents, and both the default and allowlist/denylist forms of YAML agents.
- `disabled_sub_agents` uses agent names, not tool names: `explore`, `oracle`, `librarian`, `general`, `reviewer`.
- `system_prompt_log` is intentionally opt-in. The `agent_start` capture is the canonical Pi-effective prompt; provider capture is only for verifying serialization and extracts system-like fields instead of dumping the full provider payload.
- `temperature` is accepted by the schema for forward-compatibility but is NOT applied. See `/blackbytes-status` → "Reserved / Unsupported Settings" for details.

## Tool surface

### Bundled local tools

| Tool | Purpose |
|---|---|
| `glob` | Fast file pattern matching with safety limits |
| `grep` | Regex content search with include filters, optional context lines, and multiple output modes (`content`, `files_with_matches`, `count`). Uses `ripgrep` when available and falls back to a Node.js implementation. |
| `ast_search` | AST-aware structural search across 25 languages |
| `ast_replace` | AST-aware structural rewrite with dry-run default |
| `hashline_edit` | LINE#ID-anchored file editing with snapshot semantics |

### HTTP-backed tools

| Tool | Purpose |
|---|---|
| `web_search` | Web search through Exa by default, or Tavily when configured |
| `web_fetch` | Extract a URL through Exa/Tavily with direct HTTP fallback |
| `docs_resolve` | Resolve a library/package to a Context7 ID |
| `docs_query` | Query current library documentation and examples from Context7 |
| `gh_search` | Search code patterns across public GitHub repositories |

### Delegate tools

| Tool | Purpose |
|---|---|
| `delegate_explore` | Read-only codebase discovery for "where is X?" work |
| `delegate_oracle` | Read-only high-reasoning consultation for difficult debugging or design questions |
| `delegate_librarian` | Read-only docs, web, and cross-repository research |
| `delegate_general` | Full-access execution for well-scoped multi-file implementation work |
| `delegate_reviewer` | Read-only code reviewer for diffs, patches, and PRs; produces severity-classified findings (High/Medium/Low) and a Verdict |

### YAML sub-agents

User-defined sub-agents can be placed in `$PI_AGENT_DIR/sub-agents/*.{yaml,yml}` (defaulting to `~/.pi/agent/sub-agents/`). Each file must define `name`, `description`, and `system_prompt`. Tool access is optional via either `allowed_tools` or `denied_tools` (mutually exclusive); when neither is provided the agent receives the default read/search/docs tool set.

Additional optional YAML fields:

```yaml
# ~/.pi/agent/sub-agents/deep-reviewer.yaml
name: deep-reviewer
description: Deep code review specialist
tool_description: Launch a deep code review agent...
allowed_tools:
  - read
  - grep
  - glob
system_prompt: |
  You are a senior code reviewer.
timeout_ms: 180000          # per-agent timeout in ms (1..3600000)
fallback_models:            # read-only agents only; at most 5 entries
  - anthropic/claude-opus-4
  - google/gemini-2.5-pro
prompt_mode: static         # 'static' only; 'append' throws at runtime
```

Key behaviors:

- The default starting tool set for YAML agents is read/search/docs tools only. Listing any mutating tool (`bash`, `edit`, `write`, `hashline_edit`, `ast_replace`) in `allowed_tools` automatically promotes the agent to full-access mutability.
- An optional `mutability` field can be set explicitly (`read-only` or `full-access`).
- Conflicts with a builtin name or an earlier YAML file in the same directory are skipped with a diagnostic instead of causing a fatal error. All non-conflicting agents in the same directory still load.
- Diagnostics (skipped files and reasons) appear in `/blackbytes-status` under **### YAML Sub-Agents**.
- `disabled_tools` is enforced on YAML agents the same as on builtins.

### Sub-agent system prompts

Each builtin sub-agent receives a two-layer system prompt: a runtime overlay prepended by the host, followed by the agent's static persona prompt.

**Read-only sub-agent runtime overlay (~4 KB)** — applied to Explore, Oracle, Librarian, and Reviewer via `prependSystemPrompt`. Contains:

- Current date (ISO YYYY-MM-DD and current year), so date-sensitive queries always use the correct year
- Working directory for the nested session
- Final tool allowlist for that invocation (alphabetically sorted, secrets redacted)

The overlay is capped at ~4 KB, built by `src/sub-agents/runtime-overlay.ts`, and never injects delegation hints — nested sessions cannot spawn further sub-agents.

**General agent safety overlay (~8 KB)** — applied to General instead of the read-only overlay. Contains:

- Current working directory
- Finalized allowed tool list for that invocation
- Enabled and disabled resource summary
- Hard rules: no recursive delegation, no destructive git commands, no committing secrets, no introducing new dependencies, stay in task scope
- Constraints derived from `AGENTS.md` (truncated, with secrets redacted)


## Progress / streaming

Live streaming of nested sub-agent output into the parent session is **not supported**.

### What was investigated (pib-vyj.2.5)

Pi's `ToolDefinition.execute` callback receives an `onUpdate: AgentToolUpdateCallback<TDetails>` parameter. The bash tool uses this to stream partial command output into the TUI in real time. Calling `onUpdate` does **not** append content to the final tool result that the LLM sees - it is a pure UI streaming surface. `runNestedPi` already accepts an internal `onUpdate?: (chunk: string) => void` option and forwards each stdout chunk to it.

### Why streaming is not wired

Despite the Pi surface being technically safe (no LLM context leakage from intermediate calls), we chose **not** to wire nested-Pi stdout through `onUpdate` for three reasons:

1. **Overwhelming raw output** - nested-Pi stdout is the full agent conversation: reasoning tokens, tool calls, tool results, and final output. Streaming this to the parent TUI would be unreadable.
2. **No secret redaction on the streaming path** - `redactFailureText` is applied only to failure detail strings. Raw stdout chunks may contain API keys or other sensitive values emitted by nested tool calls.
3. **Scope constraint** - the design contract explicitly prohibits dumping nested stdout into the parent context, even via the UI.

### When streaming would become supportable

- Pi surfaces a **structured progress API** (typed status events, not raw stdout) from within a `ToolDefinition.execute` callback; **or**
- The nested Pi CLI emits structured progress events (e.g. `--json-progress`) that can be filtered to a concise, safe summary; **and**
- A chunk-level redaction utility is available to sanitize sensitive values before they reach the TUI.

Until then, the delegate tool result remains a single concise text block returned after the nested session completes.

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

## Delegation model

- **Explore** locates files, symbols, and call sites in the local repository.
- **Oracle** handles hard architectural reasoning and elevated debugging.
- **Librarian** researches external APIs, official docs, and public code examples.
- **General** executes large, well-defined implementation tasks with the session's enabled tool set.
- **Reviewer** reviews changed code—diffs, patches, and PR descriptions—and produces severity-classified findings (High/Medium/Low) with a Verdict. The caller must supply the diff or file list; the Reviewer cannot run git itself.

Nested delegation is limited to one level. Delegate sessions do not receive the `delegate_*` tools again, so recursion is blocked at runtime rather than by prompt text alone.

### Model fallback

Read-only agents (`explore`, `oracle`, `librarian`, `reviewer`, and YAML agents that do not include mutating tools) support an optional `fallbackModels` chain. When the primary model returns a `provider_or_model_unavailable` failure, Blackbytes retries each model in the chain in order, all within a single shared timeout budget (minimum 1 s per attempt). No other failure kinds trigger a retry (`timed_out`, `cancelled`, `failed`, `spawn_error`, etc. are surfaced immediately). The attempted-models chain is appended to the user-visible failure message.

`general` is never fallback-eligible because its full-access mutability means partial retries could leave the workspace in an inconsistent state. YAML agents that include any mutating tool in `allowed_tools` are also ineligible.

Configure via JSON `fallbackModels` (array of strings, max 5, unique, non-empty) or YAML `fallback_models`. `/blackbytes-status` displays the fallback chain with `→` separators; agents configured with `fallbackModels` but ineligible show an `(ineligible)` suffix.

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

- `session_start` loads config, computes the enabled set, registers tools, registers delegate agents, and sets up the `✦ Bytes ✦` branding widget
- `before_agent_start` renders the capability-aware Bytes v2 overlay, injects `<available_resources>`, and uses a minimal safe fallback if the enabled set is unavailable
- `agent_start` captures Pi's final effective system prompt to the configured JSONL log when `system_prompt_log.enabled` is true
- `model_select` caches the current model family for later requests
- `before_provider_request` maps reasoning settings to provider-native fields and optionally captures provider-serialized system fields
- `tool_result` rewrites `read`/`write` results for the hashline workflow
- `session_shutdown` flushes the buffered logger

Bytes prompt variants live under `src/system-prompt/bytes/` (`default.ts`, `gpt.ts`, `gemini.ts`) and are dispatched by model family resolved from the active model id. Nested delegate sessions are spawned by `src/sub-agents/runner.ts` with `--no-session`, `--no-context-files`, and (when reasoning is configured) `--thinking <effort>`.

## Branding

A gradient `✦ Bytes ✦` badge renders right-aligned above the chat input editor in interactive mode. The badge uses fixed 24-bit RGB colors (violet → indigo → sky → cyan gradient, bold) and is independent of the active theme. It is not shown in print mode (`-p`) or JSON mode.

## Troubleshooting

### Websearch tools are unavailable

Check `blackbytes.websearch.provider` and the matching credential field:

- Exa → `blackbytes.websearch.exa_api_key`
- Tavily → `blackbytes.websearch.tavily_api_key`

### Context7 tools are unavailable

Set `blackbytes.context7.api_key`.

### A delegate or tool is missing

Check `disabled_tools` and `disabled_sub_agents`, then start a new session so the enabled set is recomputed.

### `ast_search` / `ast_replace` fail immediately

Install `ast-grep` (`sg`) and ensure it is on `PATH`.

### `grep` is slower than expected

Install `ripgrep` (`rg`). Blackbytes uses it when available and falls back to a Node.js implementation otherwise.
