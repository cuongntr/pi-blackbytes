# pi-blackbytes

Pi coding-agent extension that provides local search tools, locally-managed HTTP clients for the websearch / context7 / grep.app surfaces (replacing Pi's MCP-plugin dependency for these services), hashline-based editing, and delegated sub-agents for exploration, research, consultation, implementation, and code review.

> **Note on the wire protocol.** `web_search` / `web_fetch` (Exa, Tavily) and `docs_resolve` / `docs_query` (Context7) are pure REST clients — no MCP involved. `gh_search` is also locally-managed (no Pi MCP plugin needed) but the upstream `mcp.grep.app` service still speaks MCP-over-HTTP, so the extension ships a small in-process MCP HTTP client just for that one tool. The user-facing benefit (extension owns auth, config, error handling, render) is the same for all three groups; the wire-level distinction matters only if you are debugging requests.

## Overview

Blackbytes extends Pi with:

- **Bytes v2 system prompt overlay** — capability-aware, per-model-family prompt with 15 sections covering identity, precedence, autonomy, investigation rules, session capabilities, skill-loading guidance, engineering boundaries, work defaults, tool-use protocol, verification contracts, careful-action gates, workflow guidance, markdown format, file references, and completion contracts. The Conditional Workflows section includes a metadata-driven delegation routing matrix built from typed `SubAgentRoutingMetadata` on each sub-agent declaration, with skill/workflow-aware General delegation triggers. Four provider variants: `claude` (semantic XML tags), `gpt` (Markdown + Parallel Execution Policy footer), `gemini` (numbered headings + worked examples), and `kimi` (terse instruction-dense Markdown).
- **Strict Librarian gating** — `delegate_librarian` requires ALL of (a) external information, (b) multiple independent sources or current-year authority, (c) direct tools individually insufficient — plus an explicit anti-pattern denylist.
- **Four builtin sub-agents** — Explore (with Tour Mode for flow walk-throughs), Oracle (including difficult code, plan, and architecture review), Librarian, and General (implementation, self-review, and verification), each with typed declarations, routing metadata, runtime overlays, model fallback chains (read-only agents), per-model-family prompt variants, and per-agent configuration.
- **Typed routing metadata** — each sub-agent declaration carries a `SubAgentRoutingMetadata` object with `category`, `cost`, `useWhen`, `avoidWhen`, and optional `keyTrigger` fields. This metadata drives the Bytes overlay routing matrix and the `/blackbytes-status` Sub-Agent Routing section, replacing hardcoded routing prose.
- **Delegation ROI tracking** — in-memory session-scoped delegation log with per-agent metrics (call count, success rate, average duration, cost). Visible via `/blackbytes-status`.
- **Redacted artifact capture** — opt-in per-agent persistence of large redacted sub-agent outputs to `$PI_AGENT_DIR/blackbytes/artifacts/sub-agents/<YYYY-MM-DD>/<agent>-<HHmmssSSS>.md` (512 KiB cap, 7-day retention). Surfaces the artifact directory, total count, and most recent artifact under `/blackbytes-status` Sub-Agent Diagnostics. Enable with `sub_agents.<name>.artifactCapture: true`.
- **Sequential chain executor (internal-only)** — `src/sub-agents/chain.ts` runs 1–5 existing sub-agents in order, threading each step's output into the next under a `## Previous step output` heading. Reuses `runNestedPi()`, enforces a total timeout budget, and stops on first failure by default. **No public `delegate_chain` tool in Phase 2** — chains are constructed in code.
- **`look_at` tool** — multimodal image inspector that loads a primary image plus up to 3 references (PNG/JPG/GIF/WebP/BMP/SVG, 10 MB each) and embeds them as `ImageContent` blocks alongside the analysis objective.
- **Fluent `file://` links** — sub-agent output uses `[relpath#L-L](file:///abs/path#L-L)` links throughout.

### pi-blackbytes vs raw Pi

| Capability | Raw Pi | pi-blackbytes |
|---|---|---|
| System prompt | Pi default | Bytes v2 overlay (capability-aware, per-family) |
| Codebase exploration | `read`/`grep`/`glob` | + `delegate_explore` (parallel, scoped, fluent links, Tour Mode) |
| Reasoning consultation | (manual) | `delegate_oracle` (Effort estimate, self-contained reply) |
| External research | (manual) | `delegate_librarian` (strict gate, multi-source) |
| Difficult/high-risk code review | (manual) | `delegate_oracle` (read-only severity findings and verdict; caller supplies diff and verification results) |
| Heavy implementation | (manual) | `delegate_general` (verification gates, AGENTS.md aware) |
| Image inspection | (none) | `look_at` (PNG/JPG/GIF/WebP/BMP/SVG, multi-image compare) |
| Edit workflow | `edit`/`write` | + `hashline_edit` (anchor-based) |
| Web/docs lookup | (manual) | `web_search` / `web_fetch` / `docs_resolve` / `docs_query` / `gh_search` |
| Delegation observability | (none) | Delegation ROI log (per-agent metrics, visible in `/blackbytes-status`) |

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
Tools: **10** enabled | Agents: **4** enabled | Skills: **2** enabled
```

### Section picker

The picker presents 11 named sections plus a **Show All** option:

| # | Section | Description |
|---|---|---|
| 1 | Enabled Tools | Lists all registered tool names with their enabled/disabled state |
| 2 | Enabled Sub-Agents | Lists builtin and YAML sub-agents with their enabled/disabled state |
| 3 | Sub-Agent Routing | Typed routing metadata for each enabled sub-agent: category, cost, use-when/avoid-when hints, and key trigger |
| 4 | Enabled Skills | Lists discovered Pi skills |
| 5 | Delegation ROI | Session-scoped delegation metrics: per-agent call count, success rate, average duration, and accumulated cost |
| 6 | Sub-Agent Diagnostics | Per-agent status, recent failures by kind, nested Pi availability, YAML warnings |
| 7 | Sub-Agent Snapshot | Resolved per-agent config snapshot (model, reasoning, timeout, fallback chain) |
| 8 | YAML Diagnostics | Skipped YAML sub-agent files and reasons |
| 9 | System Prompt Log | Current system prompt logging configuration |
| 10 | Reserved / Unsupported Settings | Settings accepted by schema but not yet functional (e.g. `temperature`) |
| 11 | Full Config (JSON) | Raw `blackbytes` config object with secrets redacted |
| — | Show All | Prints all sections in order |

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
    "hashline_edit": { "strict_patch": true },
    "websearch": {
      "provider": "exa",
      "exa_api_key": "YOUR_EXA_KEY"
    },
    "context7": {
      "api_key": "YOUR_CONTEXT7_KEY"
    },
    "ui": {
      "bash_wrapper_enabled": true,
      "bash_max_preview_lines": 5,
      "bash_max_expanded_lines": 200,
      "bash_dim_output": false,
      "read_tool_display": "compact"
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
        "executionMode": "sequential",
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
| `hashline_edit` | `boolean` \| `{ enabled?: boolean, strict_patch?: boolean }` | Enables hashline rewriting for Pi `read`/`write` tool results. Object form exposes `strict_patch` (default `true`) — `lines` payloads containing accidental `LINE#ID\|` prefixes are rejected with `[E_INVALID_PATCH]`. Set `strict_patch: false` to restore the legacy silent-strip behaviour. |
| `websearch.provider` | `"exa" \| "tavily"` | Selects the web backend. Defaults to `exa` when omitted. |
| `websearch.exa_api_key` | `string` | Exa credential. Overrides `EXA_API_KEY` when set. |
| `websearch.tavily_api_key` | `string` | Tavily credential. Overrides `TAVILY_API_KEY` when set. |
| `context7.api_key` | `string` | Context7 credential |
| `ui` | `{ bash_wrapper_enabled?: boolean; bash_max_preview_lines?: number; bash_max_expanded_lines?: number; bash_dim_output?: boolean; read_tool_display?: "compact" \| "preview" }` | Controls the built-in `bash` wrapper and built-in `read` display. Defaults: `bash_wrapper_enabled=true`, `bash_max_preview_lines=5`, `bash_max_expanded_lines=200`, `bash_dim_output=false`, `read_tool_display="compact"`. |
| `system_prompt_log.enabled` | `boolean` | Opt-in full system-prompt capture to a JSONL file. Defaults to `false` because prompts may contain project context or secrets. |
| `system_prompt_log.path` | `string` | Optional log file path. Defaults to `~/.pi/logs/pi-blackbytes-system-prompts.jsonl`; relative paths resolve against the current working directory. |
| `system_prompt_log.capture_agent_start` | `boolean` | Capture Pi's final effective system prompt at `agent_start` (after `before_agent_start` chaining). Defaults to `true`. |
| `system_prompt_log.capture_provider_system` | `boolean` | Also capture provider-serialized system/developer/systemInstruction fields at `before_provider_request`. Defaults to `false`; user messages are not logged by the extractor. |
| `system_prompt_log.include_nested` | `boolean` | Include nested sub-agent Pi sessions (`PI_NESTED_DEPTH > 0`). Defaults to `false`. |
| `system_prompt_log.dedupe` | `boolean` | Avoid repeated identical prompt entries per session/source/provider shape. Defaults to `true`. |
| `sub_agents.<name>.model` | `string` | Per-agent model override, preferably the canonical Pi model reference `provider/model-id` selected by `/setup-models`. Omit/clear to inherit the host Pi model. |
| `sub_agents.<name>.reasoningEffort` | `string` | Per-agent reasoning override passed to nested sessions |
| `sub_agents.<name>.timeoutMs` | `integer` (1..3600000) | Per-agent execution timeout in milliseconds. Builtin defaults: explore=600000, librarian=900000, oracle=1200000, general=1800000. YAML equivalent: `timeout_ms`. |
| `sub_agents.<name>.fallbackModels` | `string[]` (max 5) | Ordered list of fallback models tried on `provider_or_model_unavailable` failures. Read-only agents only (`general` and mutating YAML agents are ineligible). YAML equivalent: `fallback_models`. |
| `sub_agents.<name>.executionMode` | `"sequential" \| "parallel"` | Per-agent tool execution mode override. `"sequential"` serializes tool calls within a batch; omitted uses Pi's default parallel behavior. YAML equivalent: `execution_mode`. |
| `sub_agents.<name>.promptMode` | `"static" \| "append"` | **RESERVED / PARTIALLY IMPLEMENTED** - `"static"` (default) is the only safe value. `"append"` is accepted by the schema but throws at runtime ("not yet supported"). YAML equivalent: `prompt_mode`. |
| `sub_agents.<name>.temperature` | `number` | **RESERVED / UNSUPPORTED** - accepted by schema for forward-compatibility but NOT passed to the nested Pi CLI (Pi does not accept `--temperature`). Visible under "Reserved / Unsupported Settings" in `/blackbytes-status`. |

### Configuration notes

- The settings file is strict JSON. Comments and trailing commas are not supported.
- Per-agent config (model, reasoningEffort, reserved fields) is resolved once at `session_start` into an immutable snapshot. Changes to `settings.json` after startup take effect on the next session only.
- Unknown keys inside `blackbytes` are preserved by the parser, so wizard-managed passthrough values can coexist with the validated Blackbytes settings.
- `disabled_tools` uses public tool names such as `hashline_edit` or `docs_query`. Disabled tools are enforced through every nested delegate path - builtin agents, and both the default and allowlist/denylist forms of YAML agents.
- `disabled_sub_agents` uses agent names, not tool names: `explore`, `oracle`, `librarian`, `general`.
- `system_prompt_log` is intentionally opt-in. The `agent_start` capture is the canonical Pi-effective prompt; provider capture is only for verifying serialization and extracts system-like fields instead of dumping the full provider payload.
- `temperature` is accepted by the schema for forward-compatibility but is NOT applied. See `/blackbytes-status` → "Reserved / Unsupported Settings" for details.
- All Blackbytes tools and sub-agents render through a single lightweight, borderless renderer; there is no on/off toggle. `ui.bash_wrapper_enabled` defaults to `true`, so the built-in `bash` tool also renders through the lightweight wrapper (set it to `false` to leave Pi's built-in `bash` untouched), while the built-in `read` renderer keeps displayed content anchor-free and preserves `LINE#ID|` anchors in conversation history.
- `ui.read_tool_display` defaults to `"compact"`, so collapsed `read` results render as one line with path/range and line-count summary; set it to `"preview"` to restore Pi's content preview (still with anchors hidden from the TUI).
- `ui.bash_max_preview_lines` and `ui.bash_max_expanded_lines` bound the collapsed and expanded `bash` output previews; `ui.bash_dim_output` keeps preview text in muted `toolOutput` colour instead of regular text.
- `sub_agents.<name>.executionMode` serializes or parallelizes tool calls within a batch. Use `sequential` when ordering matters; omit it to keep Pi's default parallel execution.

## Tool surface

### Tool result rendering

Every Blackbytes tool provides structured, scannable result rendering with three states:

| State | What the user sees |
|---|---|
| **Running** | A muted status message indicating progress (e.g., `Searching...`, `Fetching...`, `Scanning...`) |
| **Collapsed** (default) | A one-line summary with a `✓` (success) or `✗` (error) icon, followed by a brief summary and a `ctrl+o to expand` hint |
| **Expanded** (`Ctrl+O`) | Full tool output in `toolOutput` color |


### Bundled local tools

| Tool | Icon | Purpose |
|---|---|---|
| `glob` | 📂 | Fast file pattern matching with safety limits |
| `ast_search` | 🌳 | AST-aware structural search across 25 languages |
| `ast_replace` | ✏️ | AST-aware structural rewrite with dry-run default |
| `hashline_edit` | ✎ | LINE#ID-anchored file editing with snapshot semantics |
| `look_at` | 👁️ | Multimodal image inspector (PNG/JPG/GIF/WebP/BMP/SVG, up to 3 reference images) |

### Built-in Pi tools

When `blackbytes.ui.bash_wrapper_enabled` is true, Pi's built-in `bash` tool renders through a lightweight wrapper with shell highlighting, tail previews, capped expanded output, and footer metadata. The built-in `read` tool always uses the clean anchor-stripping renderer so `LINE#ID|` markers stay out of visible output while remaining in conversation history; collapsed `read` results are compact by default and render as a single line.

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
| `delegate_explore` | 🔭 | Read-only codebase discovery and flow walk-throughs ("Where is X?", "How does Y work?") |
| `delegate_oracle` | 🧠 | Read-only high-reasoning consultation for difficult debugging or design questions |
| `delegate_librarian` | 📚 | Read-only docs, web, and cross-repository research |
| `delegate_general` | ⚡ | Full-access execution for well-scoped multi-file implementation work |

### YAML sub-agents

User-defined sub-agents can be placed in `$PI_AGENT_DIR/sub-agents/*.{yaml,yml}` (defaulting to `~/.pi/agent/sub-agents/`). Each file must define `name`, `description`, and `system_prompt`. Tool access is optional via either `allowed_tools` or `denied_tools` (mutually exclusive); when neither is provided the agent receives the default read/search/docs tool set.

Additional optional YAML fields: `model`, `reasoning_effort`, `timeout_ms`, `mutability`, `prompt_mode`, `fallback_models`, `execution_mode`, `routing`.

```yaml
# ~/.pi/agent/sub-agents/custom-auditor.yaml
name: custom-auditor
description: Deep code review specialist
allowed_tools:
  - read
  - grep
  - glob
system_prompt: |
  You are a user-defined specialist auditor.
timeout_ms: 180000          # per-agent timeout in ms (1..3600000)
fallback_models:            # read-only agents only; at most 5 entries
  - anthropic/claude-opus-4
  - google/gemini-2.5-pro
prompt_mode: static         # 'static' only; 'append' throws at runtime
execution_mode: sequential  # optional; sequential | parallel
routing:                    # optional typed routing metadata
  category: review           # exploration | reasoning | research | implementation | review
  cost: medium               # low | medium | high
  use_when:
    - "After significant implementation"
    - "Pre-merge code quality check"
  avoid_when:
    - "Trivial changes"
  key_trigger: "Deep code review"   # optional one-line summary
```

Key behaviors:

- The default starting tool set for YAML agents is read/search/docs tools only. Listing any mutating tool (`bash`, `edit`, `write`, `hashline_edit`, `ast_replace`) in `allowed_tools` automatically promotes the agent to full-access mutability.
- An optional `mutability` field can be set explicitly (`read-only` or `full-access`).
- Conflicts with a builtin name or an earlier YAML file in the same directory are skipped with a diagnostic instead of causing a fatal error. All non-conflicting agents in the same directory still load.
- Diagnostics (skipped files and reasons) appear in `/blackbytes-status` under **### YAML Sub-Agents**.
- `disabled_tools` is enforced on YAML agents the same as on builtins.
- The optional `routing` field provides typed routing metadata for the `/blackbytes-status` Sub-Agent Routing section and the Bytes overlay. YAML agents without `routing` display a placeholder (`—`) in status output. Invalid routing values cause the file to be skipped with a diagnostic.
- Routing field validation: `category` must be one of `exploration`, `reasoning`, `research`, `implementation`, `review`; `cost` must be `low`, `medium`, or `high`; `use_when` and `avoid_when` accept at most 6 entries of ≤ 60 characters each; the schema uses `.strict()` mode so unknown routing keys are rejected.

### Sub-agent prompt system

Each builtin sub-agent receives a multi-layer system prompt:

1. A **runtime overlay** prepended by the host (read-only agents: ~4 KB; General: ~8 KB safety overlay).
2. The **resolved persona prompt body**, selected at execution time from either the default `systemPrompt` or a model-family-specific variant from `systemPromptByFamily`.

Prompt body resolution uses `resolveSystemPromptBody()` in `src/sub-agents/prompt-builder.ts`. When a nested model is explicitly configured via `sub_agents.<name>.model`, the model is classified into a `ModelFamily` (`claude`, `gpt`, `gemini`, `kimi`, `other`). If a matching family entry exists in `systemPromptByFamily`, that variant is used; otherwise the default `systemPrompt` applies. The parent session's cached model family is never consulted — only the explicitly configured nested model drives variant selection.

All four builtin sub-agents (Explore, Oracle, Librarian, General) carry GPT-optimized prompt variants (`systemPromptByFamily.gpt`) used only when the nested model is a GPT-family model. Each variant preserves the default persona's mutability, tool allowlist, evidence, output, and verification contracts. Oracle conditionally produces severity findings and a Verdict for difficult bounded reviews; General owns implementation, self-review, fixes, and verification.

**Read-only sub-agent runtime overlay (~4 KB)** — applied to Explore, Oracle, and Librarian via `prependSystemPrompt`. Contains:

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

General's persona prompt defers to the safety overlay for the authoritative tool list rather than maintaining a static tool-name list in the prompt text.

### Oracle prompt guardrails

The Oracle default prompt includes two domain-specific guardrail sections:

- **Long-Context Handling** — when input exceeds ~50 tool-result blocks or spans many files, Oracle anchors every factual claim to a specific file path and line range, labels inferred vs. verified items, and flags contradictions between code sections.
- **High-Risk Self-Check** — before finalising any answer on architecture, security, or performance, Oracle re-scans reasoning for unstated assumptions, verifies the recommendation does not introduce new failure modes, and discloses any unread files it relied upon.

### Routing metadata

Each builtin sub-agent declaration carries a `routing` field of type `SubAgentRoutingMetadata`:

```ts
export interface SubAgentRoutingMetadata {
  readonly category: "exploration" | "reasoning" | "research" | "implementation" | "review";
  readonly cost: "low" | "medium" | "high";
  readonly useWhen: readonly string[];     // max 6 items, each ≤ 60 chars
  readonly avoidWhen: readonly string[];   // max 6 items, each ≤ 60 chars
  readonly keyTrigger?: string;            // optional one-line summary
}
```

Builtin routing metadata:

| Agent | Category | Cost | Key Trigger |
|---|---|---|---|
| explore | exploration | medium | Deep contextual grep across multiple files |
| oracle | reasoning | high | Deep reasoning or difficult high-risk code review |
| librarian | research | high | Multi-source external research requiring triangulation |
| general | implementation | high | Heavy multi-file implementation with verifiable outcome |

The Bytes overlay Conditional Workflows section uses `buildOverlayRoutingMatrix()` to render a concise one-line routing entry per enabled agent from this metadata. `/blackbytes-status` uses `buildRoutingSummary()` to display the full routing table including category, cost, use-when, and avoid-when details. Both helpers live in `src/sub-agents/routing.ts`, consume runtime `SubAgentMeta[]` (not builtin declarations directly), sort alphabetically for deterministic output, and produce placeholder entries for YAML agents without routing.


## Sub-agent progress display

Delegate tools emit bounded, redacted `onUpdate` status events while the nested session runs. The TUI renders a live-updating display with two modes:

### Collapsed view (default)

A single-line header showing real-time execution status:

```
✓ 🔭 explore · 12.5s · 8 calls · 2,048 chars · $0.031 · ctrl+o to expand
```

While a delegation is running:

```
⠹ 🔭 explore · 9.0s · 4 calls · 🔧 read …/sub-agents/render.ts
```

On failure:

```
✗ 🔭 explore · 1.4s · 2 calls · budget exhausted · ctrl+o to expand
```

Header elements (left to right):

- **Status indicator**: a braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) animating at 10 fps while running, `✓` (success), `✗` (failure), or `⚠` (cancelled / timed out) once complete. The status word (`completed`, `failed`, etc.) is omitted because the glyph carries the meaning.
- **Agent identity**: the agent icon (🔭 explore, 🧠 oracle, 📚 librarian, ⚡ general; `▸` for YAML-defined agents) followed by the bold agent name colored to match the status (red for failed, accent for running, success for completed).
- **Elapsed time**: live-ticking wall-clock counter with progressive precision — `<1ms`, `47ms`, `3.2s`, `2m 7s`, or `1h 12m`.
- **Tool call count**: total number of tool invocations by the sub-agent.
- **Current tool** (running only): `🔧 read …/sub-agents/render.ts` — the active tool name with a truncated argument summary. The wrench icon is accent-colored, the tool name uses the `toolTitle` token, and the argument hint is muted. Between calls (after one tool completes but before the next starts), the last finished tool is kept visible as `◷ <name>` in muted color so the row never goes silent.
- **Output chars**: total captured assistant output size.
- **Cost** (when > 0): smart-formatted USD — `<$0.001`, `$0.004`, `$0.420`, `$1.23`, `$42.05`, or `$1235`.
- **Error hint** (failed only): the first line of the failure message, stripped of any leading `Error:` prefix and clamped to 60 characters, rendered in red so the cause is visible without expanding.
- **Expand hint**: `ctrl+o to expand`.

The model name is intentionally absent from the collapsed header — it appears in the expanded footer instead to keep the header scannable.

### Expanded view (`Ctrl+O`)

When expanded, the header is followed by a **tool activity timeline** showing the last 30 tool invocations:

```
  [+5 earlier calls]
  ✓ read src/config/schema.ts (234ms)
  ✓ ast_search 'registerTool' (1.2s)
  ✓ bash grep -r "subagent" (847ms)
  ✓ read …/sub-agents/runner.ts (47ms)
  ▸ bash bun run build (running…)
```

Each entry shows a `✓` (completed, green) or `▸` (running, accent) icon, the tool name colored with the `toolTitle` token, an optional muted argument summary (path, command, query, etc.), and the execution duration. Sub-second tools display millisecond precision instead of `0.0s`. Tool arguments are extracted from well-known parameter names (`path`, `filePath`, `command`, `query`, `pattern`, `url`, etc.) and truncated to 50 characters. Path-like arguments (`path`, `filePath`) are truncated from the **left** to preserve the filename and as many trailing parent segments as fit: `/Users/invoker/Work/personal/pi-blackbytes/src/sub-agents/render.ts` becomes `…/sub-agents/render.ts` rather than losing the filename to a tail-cut.

Below the timeline, the expanded view shows the assistant's output preview (while running) or the final result text (when complete), followed by a **muted footer aggregate**:

```
gemini-3-flash-preview · Tools: 12× read · 4× ast_search · 1× bash · $0.004
```

The footer carries the model name, a flattened tool-mix summary sorted by call count descending (ties broken alphabetically), and the smart-formatted cost. Any of the three is omitted when the corresponding data is unavailable; the entire footer is suppressed when nothing remains to display.

### Design constraints

Raw nested-Pi stdout is not forwarded to the parent TUI. It contains the full nested conversation — reasoning tokens, tool calls, tool results, and final output — and dumping it would be noisy and may expose sensitive values from nested tool output.

The final delegate result remains a concise text block returned after the nested session completes. Progress updates are UI-only: they do **not** append intermediate nested output to the final tool result or to the parent model context.

Successful delegate output is bounded by `boundReturnContent()` in `src/sub-agents/runner.ts` (`MAX_RETURN_CHARS`, 24,576 chars) before it re-enters the parent context. The cap is tail-preserving and middle-eliding: it keeps the head and tail and inserts a `[... truncated ...]` marker in between, so a worker's trailing completion summary survives even when an outlier output (for example a worker dumping a whole file) would otherwise bloat the orchestrator's context. The threshold is large enough that normal structured summaries pass through untouched. Worker sub-agents are deliberately kept unaware of any token or context limit — resource pressure is handled structurally (isolation plus this output cap), never by signalling scarcity to the nested agent, since doing so degrades thoroughness.

The `general` worker closes its output with a fixed completion block delimited by `=== TASK COMPLETE ===` (Outcome / Changed Files / Verification / Failures), placed last so the tail-preserving cap retains it.

## `hashline_edit`

`hashline_edit` works alongside Pi's native `edit` tool. It is optimized for precise, low-ambiguity edits by anchoring each mutation to a tagged line reference from `read` output, with a substring fallback (`replace_text`) for the cases where anchors are not needed.

### Workflow

1. Read the file first and copy the `LINE#ID` anchors.
2. Build one `hashline_edit` call per file with all related edits batched together.
3. Use `replace`, `append`, `prepend`, or `replace_text` against the copied anchors. The aliases `insert_after`, `insert_before`, and `replace_range` carry the same semantics with clearer intent.
4. The success response includes an `--- Updated anchors ---` block (with ±3 lines of context) and a `--- Diff preview ---` block, so a follow-up edit nearby usually does not need a re-read round-trip.
5. Re-read the file before issuing a second `hashline_edit` call when the structural change is large or when the previous response did not surface the anchors you need.

### Operations

| Op | Anchors | Semantics |
|---|---|---|
| `replace` | `pos`; optional `end` for ranges | Replace the targeted line (or `[pos..end]` inclusive range) with `lines`. `lines: null` deletes. |
| `append` | optional `pos` | Insert `lines` after `pos`. With no `pos`, appends at EOF. |
| `prepend` | optional `pos` | Insert `lines` before `pos`. With no `pos`, prepends at BOF. |
| `insert_after` | required `pos` | Alias for `append` with required `pos`. Missing `pos` rejects with `[E_BAD_REF]`. |
| `insert_before` | required `pos` | Alias for `prepend` with required `pos`. Missing `pos` rejects with `[E_BAD_REF]`. |
| `replace_range` | required `pos` + `end` | Alias for `replace` with required `pos` + `end`. Missing either rejects with `[E_BAD_REF]`. |
| `replace_text` | none (`oldText` + `newText`) | Exact-unique substring edit. `oldText` must occur exactly once (LF only, multi-line allowed); zero matches → `[E_NO_MATCH]`, multiple → `[E_MULTI_MATCH]` with the first three matching line numbers. Runs before anchored edits; overlap with an anchored range is rejected pre-mutation with `[E_OVERLAP]`. |

### Properties

- All edits in a single call refer to the original file snapshot.
- `lines: null` deletes the targeted line or range.
- Strict-patch rejection (default): `lines` payloads containing accidental `LINE#ID|` prefixes are rejected with `[E_INVALID_PATCH]` instead of silently stripped. The escape hatch is `"hashline_edit": { "strict_patch": false }`.
- Atomic write with alias preservation: fresh-inode targets are written via temp+rename in the same directory; hard-linked files (`nlink > 1`) are written in place with `O_TRUNC` to preserve the alias chain; symlinks are followed to their canonical target so the link itself remains a symlink; the existing mode bits are restored on the new inode using an `fchmod` that bypasses the process umask. Non-regular-file targets are refused with `[E_WRITE_FAILED]`.
- Canonical-path mutation queue: concurrent edits that arrive via different symlink paths to the same inode serialise on the same key.
- Optional `postEditVerify: true` per call: re-reads the file after the atomic write and compares byte-for-byte against the intended content. On mismatch, rolls back to the pre-edit bytes and returns `[E_VERIFY_FAILED]` with a compact line/column + windowed-byte divergence context. If rollback itself fails, the error message notes that the file may be partially corrupted.
- `delete: true` removes the file (requires `edits: []`).
- `rename: <new path>` writes to the new path and unlinks the old one.
- When an anchor mismatch occurs, the tool returns the updated anchors around the affected lines for recovery.

### Error codes

Every error is formatted as `[CODE] message` (optionally followed by a context block). The taxonomy:

| Code | Meaning |
|---|---|
| `E_BAD_REF` | Anchor did not parse, or an alias was missing a required anchor. |
| `E_HASH_MISMATCH` | Anchor parsed but its CID does not match the file's current content. |
| `E_OUT_OF_RANGE` | Anchor's line number is outside the file. |
| `E_INVALID_PATCH` | Payload shape is refused (e.g. a `LINE#ID\|` prefix inside `lines` under strict mode). |
| `E_OVERLAP` | Two or more edits target overlapping regions, or a `replace_text` span overlaps an anchored range. |
| `E_NO_MATCH` | `replace_text.oldText` produced zero matches. |
| `E_MULTI_MATCH` | `replace_text.oldText` produced more than one match. |
| `E_WRITE_FAILED` | Filesystem write failed (`EACCES` / `EPERM` / `ENOSPC` / `EROFS` / non-regular-file refusal / unexpected). |
| `E_NOT_FOUND` | Target file does not exist on the read path. |
| `E_VERIFY_FAILED` | `postEditVerify` re-read did not match the intended bytes (the file is rolled back unless rollback itself fails). |

### Result rendering

Collapsed view shows `✓ <summary> · ctrl+o to expand` for success and `✗ <summary> · ctrl+o to expand` for errors. Expanded view renders the structured `diffData` returned alongside the response with `▌- ` (error colour) and `▌+ ` (success colour) gutter markers per changed range, width-clamped per line, so the diff is visible in both colour terminals and plain-text transcripts.

## Delegation model

- **Explore** locates files, symbols, and call sites in the local repository. In Tour Mode, it traces execution flows and returns numbered `[file#L-L](file://…)` steps with `what · why` annotations — use it when you need to understand *how* a flow works, not just where files live. Accepts an optional `context` parameter to scope the search.
- **Oracle** handles hard architectural reasoning, elevated debugging, and difficult code, plan, or architecture review. For bounded code review it produces severity-classified findings and a Verdict; the caller supplies the diff and verification results because Oracle cannot run git or tests. It includes long-context handling and high-risk self-check guardrails and remains read-only.
- **Librarian** researches external APIs, official docs, and public code examples.
- **General** executes large, well-defined implementation tasks with the session's enabled tool set and owns implementation, final-diff self-review, in-scope fixes, and repository-defined verification in one invocation. Workflow/skill-defined atomic units remain separate `delegate_general` calls.

Nested delegation is limited to one level. Delegate sessions do not receive the `delegate_*` tools again, so recursion is blocked at runtime rather than by prompt text alone.

### Model fallback

Read-only agents (`explore`, `oracle`, `librarian`, and YAML agents that do not include mutating tools) support an optional `fallbackModels` chain. When the primary model returns a `provider_or_model_unavailable` failure, Blackbytes retries each model in the chain in order, all within a single shared timeout budget (minimum 1 s per attempt). No other failure kinds trigger a retry (`timed_out`, `cancelled`, `failed`, `spawn_error`, etc. are surfaced immediately). The attempted-models chain is appended to the user-visible failure message.

`general` is never fallback-eligible because its full-access mutability means partial retries could leave the workspace in an inconsistent state. YAML agents that include any mutating tool in `allowed_tools` are also ineligible.

Configure via JSON `fallbackModels` (array of strings, max 5, unique, non-empty) or YAML `fallback_models`. `/blackbytes-status` displays the fallback chain with `→` separators; agents configured with `fallbackModels` but ineligible show an `(ineligible)` suffix.

### Delegation ROI

Each delegation is logged to an in-memory, session-scoped log tracking:

- Agent name
- Start time and duration
- Success/failure status
- Tool call count and output size
- Estimated cost (when available from usage tracking)

The log resets on each session restart. View the current session's delegation metrics via `/blackbytes-status` → **Delegation ROI**, which shows per-agent aggregates: call count, success rate, average duration, and accumulated cost.

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

Bytes prompt variants live under `src/system-prompt/bytes/` (`default.ts`, `gpt.ts`, `gemini.ts`, `kimi.ts`) and are dispatched by model family resolved from the active model id. Nested delegate sessions are spawned by `src/sub-agents/runner.ts` with `--no-session`, `--no-context-files`, and (when reasoning is configured) `--thinking <effort>`.

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
