# pi-blackbytes

Pi coding-agent extension that provides local search tools, direct HTTP replacements for the websearch/context7/grep.app MCP surfaces, hashline-based editing, and delegated sub-agents for exploration, research, consultation, implementation, and code review.

## Installation

```bash
pi install bun:pi-blackbytes
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
| `/setup-models` | Interactive per-agent model and thinking level configuration wizard with grouped provider picker, batch shortcuts, and summary confirmation |
| `/blackbytes-status` | Interactive section-based status viewer with compact overview and drill-down into individual sections |
| `/toggle-verbose` | Toggle compact vs expanded tool-result rendering during the current session |

## Setup wizard

The `/setup-models` wizard maps Pi-available models to Blackbytes sub-agents and writes the result to `blackbytes.sub_agents.<name>.model` (and optionally `.reasoningEffort`) in `~/.pi/agent/settings.json`.

### Mapping modes

The wizard opens with three top-level modes:

| Mode | Behaviour |
|---|---|
| **Per-agent** | Configure model and thinking level for each sub-agent in sequence |
| **One-for-all** | Select a single model for all agents, then set reasoning mode |
| **Clear all** | Remove all per-agent model and reasoning overrides |

### Per-agent mode

For each agent the wizard presents two consecutive picks — model, then thinking level — before advancing to the next agent. After the first agent is configured, two batch shortcuts appear at the top of subsequent selections:

- **⬆ Apply `<model>` to all remaining agents** — propagates the current model forward without prompting again
- **⬆ Apply `<level>` to all remaining agents** — propagates the current thinking level forward
- **⏭ Skip thinking for all remaining agents** — stops thinking configuration for all agents still to come

### One-for-all mode

A single model is selected first, then the wizard asks how reasoning should be applied:

- **Same for all** — one reasoning level applied to every agent
- **Per agent** — step through each agent individually to set a reasoning level
- **Skip** — no reasoning overrides are written

### Grouped provider picker

When Pi's model registry contains more than 10 models, the model selection becomes a two-step flow:

1. **Provider list** — each entry shows the provider name and model count (e.g., `anthropic (8 models)`). Selecting a provider drills into that group.
2. **Model list within provider** — shows only models from the selected provider. Pressing **Cancel** at this step returns to the provider list rather than exiting the wizard.

When 10 or fewer models are available the two-step flow is skipped and all models appear in a single flat list.

### Smart model ordering

Models chosen earlier in the same wizard session move to the top of the model list in subsequent agent selections, reducing scrolling when the same model is applied to multiple agents.

### Summary confirmation

After all agents are configured a formatted summary table is displayed:

```
Agent       Model                       Thinking
─────────── ─────────────────────────── ────────
oracle      anthropic/claude-opus-4     high
general     openai/gpt-5.4              —
explore     (inherit host model)        —
```

The wizard prompts for confirmation before writing anything to `settings.json`. Cancelling at this step discards all selections.

## `/blackbytes-status` viewer

Running `/blackbytes-status` opens an interactive section picker rather than printing the full output immediately.

### Overview header

A compact summary line is always shown first regardless of which section is selected:

```
Tools: **14** enabled | Agents: **5** enabled | Skills: **2** enabled
```

### Section picker

The picker presents 9 named sections plus a **Show All** option:

| # | Section |
|---|---|
| 1 | Enabled Tools |
| 2 | Enabled Sub-Agents |
| 3 | Enabled Skills |
| 4 | Sub-Agent Snapshot |
| 5 | YAML Diagnostics |
| 6 | System Prompt Log |
| 7 | Compact Tool Output |
| 8 | Reserved / Unsupported Settings |
| 9 | Full Config (JSON) |
| — | Show All |

Selecting a numbered section prints the overview header followed by that section only. Selecting **Show All** or pressing **Cancel** prints the full output, preserving backward-compatible behaviour.

## Prompt templates

Blackbytes bundles package-level Pi prompt templates that are available as slash commands after installation:

| Template | Purpose |
|---|---|
| `/review-fresh-eyes` | Re-read recently changed code with fresh eyes, look for obvious bugs or confusion, and fix anything uncovered. |
| `/update-docs` | Update README and other documentation so they describe the current project state. |
| `/suggest-innovation` | Propose the single most valuable, innovative addition for the project. |
| `/commit-and-push` | Commit changed files in logical groups with detailed commit messages and push, while skipping ephemeral files. |

## Configuration

Blackbytes reads the top-level `blackbytes` object from the Pi settings file.

```json
{
  "blackbytes": {
    "disabled_tools": [],
    "disabled_sub_agents": [],
    "hashline_edit": true,
    "copilot_initiator_header": true,
    "compact_tools": {
      "enabled": true,
      "default_expanded": false
    },
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
        "timeoutMs": 1200000,
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
| `compact_tools.enabled` | `boolean` | Registers compact renderers for Pi built-in `read`, `bash`, `edit`, `write`, `find`, and `ls` results. Defaults to `true`. |
| `compact_tools.default_expanded` | `boolean` | Initial tool-result expansion state when compact renderers are enabled. `false` means compact by default. |
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
| `sub_agents.<name>.timeoutMs` | `integer` (1..3600000) | Per-agent execution timeout in milliseconds. Builtin defaults: explore=600000, librarian=900000, oracle=1200000, general=1800000, reviewer=900000. YAML equivalent: `timeout_ms`. |
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
- Compact tool output preserves Pi's full built-in renderers when expanded (`Ctrl+O`) and can be toggled during a session with `/toggle-verbose`.
- `temperature` is accepted by the schema for forward-compatibility but is NOT applied. See `/blackbytes-status` → "Reserved / Unsupported Settings" for details.

## Tool surface

### Tool result rendering

Every Blackbytes tool provides structured, scannable result rendering with three states:

| State | What the user sees |
|---|---|
| **Running** | A muted status message indicating progress (e.g., `Searching...`, `Fetching...`, `Scanning...`) |
| **Collapsed** (default) | A one-line summary with a `✓` (success) or `✗` (error) icon, followed by a brief summary and a `ctrl+o to expand` hint |
| **Expanded** (`Ctrl+O`) | Full tool output in `toolOutput` color |

**Compact Pi built-in rendering**: When `compact_tools.enabled` is true, Blackbytes wraps Pi's built-in `read`, `bash`, `edit`, `write`, `find`, and `ls` tools so collapsed results render as one-line summaries with `✓`/`✗` icons, paths, and metadata. Expanded results still use Pi's original renderers. Blackbytes does not replace its own bundled `grep` implementation with Pi's built-in `grep`; the bundled `grep` already renders compact summaries and keeps its Blackbytes-specific parameters.

### Bundled local tools

| Tool | Icon | Purpose |
|---|---|---|
| `glob` | 📂 | Fast file pattern matching with safety limits |
| `grep` | 🔍 | Regex content search with include filters, optional context lines, and multiple output modes (`content`, `files_with_matches`, `count`). Uses `ripgrep` when available and falls back to a Node.js implementation. |
| `ast_search` | 🌳 | AST-aware structural search across 25 languages |
| `ast_replace` | ✏️ | AST-aware structural rewrite with dry-run default |
| `hashline_edit` | ✎ | LINE#ID-anchored file editing with snapshot semantics |

### HTTP-backed tools

| Tool | Icon | Purpose |
|---|---|---|
| `web_search` | 🌐 | Web search through Exa by default, or Tavily when configured |
| `web_fetch` | 📥 | Extract a URL through Exa/Tavily with direct HTTP fallback |
| `docs_resolve` | 📚 | Resolve a library/package to a Context7 ID |
| `docs_query` | 📖 | Query current library documentation and examples from Context7 |
| `gh_search` | 🔎 | Search code patterns across public GitHub repositories |

### Delegate tools

| Tool | Icon | Purpose |
|---|---|---|
| `delegate_explore` | 🔭 | Read-only codebase discovery for "where is X?" work |
| `delegate_oracle` | 🧠 | Read-only high-reasoning consultation for difficult debugging or design questions |
| `delegate_librarian` | 📚 | Read-only docs, web, and cross-repository research |
| `delegate_general` | ⚡ | Full-access execution for well-scoped multi-file implementation work |
| `delegate_reviewer` | 📋 | Read-only code reviewer for diffs, patches, and PRs; produces severity-classified findings (High/Medium/Low) and a Verdict |

### YAML sub-agents

User-defined sub-agents can be placed in `$PI_AGENT_DIR/sub-agents/*.{yaml,yml}` (defaulting to `~/.pi/agent/sub-agents/`). Each file must define `name`, `description`, and `system_prompt`. Tool access is optional via either `allowed_tools` or `denied_tools` (mutually exclusive); when neither is provided the agent receives the default read/search/docs tool set.

Additional optional YAML fields: `model`, `reasoning_effort`, `timeout_ms`, `mutability`, `prompt_mode`, `fallback_models`.

```yaml
# ~/.pi/agent/sub-agents/deep-reviewer.yaml
name: deep-reviewer
description: Deep code review specialist
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


## Sub-agent progress display

Delegate tools emit bounded, redacted `onUpdate` status events while the nested session runs. The TUI renders a live-updating display with two modes:

### Collapsed view (default)

A single-line header showing real-time execution status:

```
✓ completed · 12.5s · 8 calls · 2,048 chars · gpt-4o · $0.0312 · ctrl+o to expand
```

Header elements (left to right):
- **Status icon + text**: `✓ completed` (green), `✗ failed` (red), `⚠ timed_out` / `⚠ cancelled` (yellow), `running` (accent, no icon)
- **Elapsed time**: live-ticking wall-clock counter
- **Tool call count**: total number of tool invocations by the sub-agent
- **Current tool** (running only): `🔧 read src/config/schema.ts` — the active tool name with a truncated argument summary
- **Output chars**: total captured assistant output size
- **Model**: the model used for the current or final attempt
- **Cost**: accumulated token cost across all turns
- **Expand hint**: `ctrl+o to expand`

### Expanded view (`Ctrl+O`)

When expanded, the header is followed by a **tool activity timeline** showing the last 30 tool invocations:

```
  [+5 earlier calls]
  ✓ read src/config/schema.ts (0.2s)
  ✓ ast_search 'registerTool' (1.2s)
  ✓ bash grep -r "subagent" (0.8s)
  ✓ read src/sub-agents/runner.ts (0.1s)
  ▸ bash bun run build (running…)
```

Each entry shows a `✓` (completed, green) or `▸` (running, accent) icon, the tool name, an optional argument summary (path, command, query, etc.), and the execution duration. Tool arguments are extracted from well-known parameter names (`path`, `command`, `query`, `pattern`, `url`, etc.) and truncated to 50 characters.

Below the timeline, the expanded view shows the assistant's output preview (while running) or the final result text (when complete).

### Design constraints

Raw nested-Pi stdout is not forwarded to the parent TUI. It contains the full nested conversation — reasoning tokens, tool calls, tool results, and final output — and dumping it would be noisy and may expose sensitive values from nested tool output.

The final delegate result remains a concise text block returned after the nested session completes. Progress updates are UI-only: they do **not** append intermediate nested output to the final tool result or to the parent model context.

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
bun run check          # lint + typecheck + build + full test suite + package size
bun run lint
bun run typecheck
bun run build
bun run test
bun run check:size

bun run lint:fix
bun run format
bun run bench:startup
bun run bench:tool-result
```

Recommended verification order:

1. `bun run check`
2. For targeted iteration: `bun run lint` → `bun run typecheck` → `bun run build` → `bun run test`

## Architecture summary

The extension bootstraps from `src/index.ts` and wires the core session handlers in `src/bootstrap.ts`:

- `session_start` loads config, computes the enabled set, registers tools, registers delegate agents, and sets up the `✦ Bytes ✦` branding widget
- `before_agent_start` renders the capability-aware Bytes v2 overlay, injects `<available_resources>`, and uses a minimal safe fallback if the enabled set is unavailable
- `agent_start` captures Pi's final effective system prompt to the configured JSONL log when `system_prompt_log.enabled` is true
- `model_select` caches the current model family for later requests
- `before_provider_request` optionally captures provider-serialized system prompts when `system_prompt_log.capture_provider_system` is enabled
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
