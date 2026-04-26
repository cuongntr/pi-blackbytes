# Changelog

## 0.2.0 (2026-04-26)

### Added

- **Reviewer sub-agent**: new read-only code reviewer (`delegate_reviewer`) that produces severity-classified findings (High/Medium/Low) and a verdict for diffs, branches, and PRs.
- **Runtime overlay for read-only sub-agents**: lightweight (~4 KB) `prependSystemPrompt` overlay via `buildSubAgentRuntimeOverlay()` carrying current date, working directory, and finalized tool allowlist.
- **Enhanced sub-agent tool strategies**: explore, oracle, and librarian agents now include detailed tool-strategy sections mapping question types to the best primitive tools.
- **CI/CD**: GitHub Actions workflow to publish to npm on release creation.

### Changed

- **Package renamed** from `@blackbytes/pi-blackbytes` to `pi-blackbytes` (unscoped).
- **Package metadata**: added `repository`, `homepage`, and `bugs` fields to `package.json`.
- Sub-agent system prompts expanded with tool-strategy guidance and runtime overlay hooks.
- CI workflow installs `ripgrep` for grep integration tests.

### Removed

- Bundled skills (`blackbytes-overview`, `hashline-workflow`, `delegation`) — replaced by enhanced sub-agent prompts and runtime overlays.


### Added

- Optional `blackbytes.system_prompt_log` JSONL capture for full Pi-effective system prompts at `agent_start`, with optional provider-serialized system-field capture at `before_provider_request`.

### Changed

- `/setup-models` now maps Blackbytes sub-agents to models already available in Pi instead of collecting provider credentials or writing provider/package defaults into the Blackbytes config.
- Extension event wrappers now await handlers and preserve return values so return-based Pi hooks such as `before_agent_start` and `tool_result` work correctly.

### Phase 2 closure summary

All five Phase 2 beads are resolved:

| Bead | Feature | Status |
|---|---|---|
| pib-vyj.2.1 | Per-agent timeout (`timeoutMs` / `timeout_ms`) | Landed |
| pib-vyj.2.2 | `promptMode` schema (`static` \| `append`) | Landed (append reserved) |
| pib-vyj.2.3 | Append prompt mode for builtins | **Deferred** (no safe Pi inherited-context API) |
| pib-vyj.2.4 | Conservative model fallback for read-only agents | Landed |
| pib-vyj.2.5 | Streaming / progress support | **Deferred** (no structured Pi progress surface) |

### Deferred to Phase 3

The following items were investigated in Phase 2 and deferred. They should not be re-opened without the stated precondition:

- **Parallel fanout / background task lifecycle** — requires a Pi API for concurrent tool execution or a stable background task surface.
- **Worktree isolation** — requires Pi to expose per-delegate working-directory control.
- **Persistent agent memory** — requires a stable, bounded Pi session-state API.
- **Streaming progress** — becomes supportable when Pi exposes a structured progress surface (typed status events, not raw stdout) with a chunk-level redaction utility available.
- **Append prompt mode** — becomes supportable when Pi exposes a `parentContext` / `inheritedInstructions` field on the tool execute callback, bounded in size and scoped to the parent's static system prompt only.



**Decision: deferred** — no builtin (`oracle`, `general`, `explore`, `librarian`) is opted into `promptMode: "append"`.
All four builtins continue to use the implicit static default. `buildSystemPrompt()` still throws fail-loud on `"append"`.

**Why deferred:** the prompt-builder bead (pib-vyj.2.2) confirmed Pi exposes no safe inherited-context source.
`AgentSession.systemPrompt` exists on the class but is unreachable from the registered tool's `execute` closure
(signature `(toolCallId, params, signal, onUpdate, ctx?)` — no parent-session reference). Without a stable,
bounded API surfacing the parent's static system prompt, enabling append mode would require either reading
arbitrary files (out of scope, unsafe) or scraping transcripts (forbidden by 2.2 source-contract rule).

**Re-evaluation criteria** (when to revisit and enable append for `oracle`, then `general` separately):
1. Pi exposes a documented `parentContext` / `inheritedInstructions` field on the tool execute callback,
   bounded in size, scoped to the parent's static system prompt only (not transcripts, not tool outputs).
2. A chunk-level secret-redaction utility is available (or `redactFailureText` is broadened with bounded
   guarantees suitable for prompt content).
3. For `general`: extra validation that append context cannot conflict with the bounded safety overlay or
   loosen the no-recursive-delegation / mutating-tools boundary.

**No code change.** This entry documents the deferral so future implementers do not silently flip
`promptMode` on a builtin without re-running the source-contract analysis.

### Phase 2 conservative model fallback for read-only agents (pib-vyj.2.4)

Adds optional `fallbackModels` config for read-only sub-agents (explore, oracle, librarian,
YAML-defined read-only agents). When a `provider_or_model_unavailable` failure is returned,
`executeWithFallback` retries with each model in the chain within a shared timeout budget.

**New / changed files:**
- `src/sub-agents/fallback.ts` — `executeWithFallback` + `formatAttempts` (pure, injectable).
- `src/config/schema.ts` — `fallbackModels` per-agent field (max 5 non-empty strings, no dupes).
- `src/sub-agents/loader.ts` — `fallback_models` in YAML schema; folded into `staticOverrides`.
- `src/sub-agents/declaration.ts` — `fallbackModels` added to `ModelOverrides`.
- `src/sub-agents/snapshot.ts` — `fallbackModels` + `fallbackEligible` fields on `AgentSnapshot`.
- `src/sub-agents/register.ts` — replaces single `runNestedPi` call with `executeWithFallback`.
- `src/commands/blackbytes-status.ts` — shows fallback chain and eligibility in snapshot section.
- `src/sub-agents/__tests__/fallback.test.ts` — new test file.

### Phase 2 progress/streaming spike (pib-vyj.2.5)

**Decision: unsupported** — live streaming of nested sub-agent output into the parent session is intentionally not wired.

**Investigation findings** (all citations from `node_modules/@mariozechner/pi-coding-agent`):

- `AgentToolUpdateCallback<T>` (`pi-agent-core/dist/types.d.ts:255`):
  `(partialResult: AgentToolResult<T>) => void` — a structured callback that sends partial
  `{ content, details }` objects to the host runtime during tool execution.
- `ToolDefinition.execute` signature (`core/extensions/types.d.ts:307`): receives
  `onUpdate: AgentToolUpdateCallback<TDetails> | undefined` as a 4th parameter.
- Bash tool (`core/tools/bash.js:201–244`): proves `onUpdate` is a **pure UI streaming surface**.
  Intermediate `onUpdate` calls display partial output in the TUI; the final `execute()` return
  value is what enters the LLM context. Calling `onUpdate` does **not** append to the final
  tool result.
- `RunNestedPiOptions.onUpdate` (`src/sub-agents/types.ts`): `(chunk: string) => void`. Already
  wired internally — `runner.ts` calls `onUpdate?.(text)` on each stdout chunk (`runner.ts:238–239`).
- `register.ts:45–46`: the `execute` callback receives `_onUpdate?: unknown` (unused, `_` prefix,
  typed `unknown`). Never forwarded to `runNestedPi`.

**Why streaming remains unsupported:**

1. Nested-Pi stdout is the full agent conversation (reasoning, tool calls, results) — too verbose
   to surface in the parent TUI without filtering.
2. No chunk-level secret redaction exists on the streaming path (`redactFailureText` only
   covers failure detail strings).
3. Wiring raw stdout through `onUpdate` would dump the nested conversation into the parent
   visual context, violating the "do not dump nested stdout into parent context" design constraint.

**What would make streaming supportable:** a structured progress surface from Pi (typed status events
rather than raw stdout), or a nested-session `--json-progress` mode producing concise, filterable
events, combined with a chunk-level redaction utility.

**Code changes:** JSDoc added to `RunNestedPiOptions.onUpdate` in `src/sub-agents/types.ts`
explaining the internal-only contract. README gained a "Progress / streaming" section documenting
the decision. No behavioral change; `bun run lint && bun run build && bun run test` all pass.

### Phase 2 prompt-mode schema (pib-vyj.2.2)

- **`promptMode` field on `SubAgentDeclaration`** (`src/sub-agents/declaration.ts`): optional `"static" | "append"` discriminator. Default is `"static"`. Field is frozen with the declaration via `defineSubAgent()`.
- **YAML `prompt_mode` field** (`src/sub-agents/loader.ts`): Zod enum validates `"static"` and `"append"`; any other value is rejected as a schema error and produces a diagnostic through the existing YAML pipeline (file skipped, reason surfaced in `/blackbytes-status`). Omitting the field defaults to `undefined` (static by default).
- **`buildSystemPrompt()` function** (`src/sub-agents/prompt-builder.ts`): centralised system-prompt assembler. In `"static"` mode (default) returns `basePrompt` byte-for-byte unchanged — no trimming, no transformation. In `"append"` mode throws a clear `Error` immediately ("not yet supported") so the delegate tool call fails loudly. **Append mode is deferred to pib-vyj.2.3**: Pi's `ExtensionAPI` execute callback exposes only `(toolCallId, params, signal, onUpdate, ctx?)` — there is no stable, bounded API that returns the parent session's static system prompt from within a registered tool. `AgentSession.systemPrompt` exists on the class but is unreachable from the execute closure without unsafe global state. Until Pi surfaces a supported `parentContext` field, append mode stays deferred.
- **`register.ts` wired to `buildSystemPrompt()`**: replaced inline `systemPrompt` variable with `baseSystemPrompt` → `buildSystemPrompt({ basePrompt, declaration })` → `builtPrompt`. Static mode output is byte-for-byte identical to previous behaviour.
- **No builtin sets `promptMode`**: all four builtins (`explore`, `oracle`, `librarian`, `general`) continue to operate with the implicit static default.
- **Tests** (`src/sub-agents/__tests__/prompt-builder.test.ts`, additions to `loader.test.ts`): snapshot tests confirm each builtin's system prompt is unchanged through the builder; append-mode tests verify the error message content and road-map citation; YAML schema tests confirm valid/invalid `prompt_mode` values are accepted/rejected; register.ts integration tests pass unmodified (zero behaviour change in static mode).

### Phase 1 subagent hardening

- **Canonical delegable tool registry + finalizer** (`src/sub-agents/delegable-tools.ts`): explicit tool classes (`EXTENSION_TOOL_NAMES`, `PI_BUILTIN_TOOLS`, `READ_SEARCH_DOCS_TOOLS`, `MUTATING_EXEC_TOOLS`). `finalizeNestedTools` pipeline: dedupe → reject delegate\_\*/unknown (strict throws / lenient drops) → apply global `disabled_tools` denylist → enforce per-agent mutability → sort. Strict mode for builtins, lenient for YAML.
- **Tool resolvers fixed for builtins + YAML**: explore/oracle/librarian are read-only/research-only with strict mode; general has full-access (Pi built-ins + extension tools) with strict mode and a prepended bounded safety overlay. YAML default starting set is `READ_SEARCH_DOCS` only. YAML `allowed_tools` listing any mutating tool auto-promotes mutability to `full-access`. Optional YAML `mutability:` field. Globally-disabled tools never reach nested Pi.
- **General safety overlay** (`src/sub-agents/general-safety-overlay.ts`): bounded ~8 KB markdown overlay listing cwd, finalized tools, enabled/disabled resources, hard rules, and AGENTS.md-derived constraints (truncated, with secret redaction).
- **Temperature RESERVED**: Pi CLI does not accept `--temperature`. Schema accepts the field for forward-compat; runner never emits it. `/blackbytes-status` surfaces it under "Reserved / Unsupported Settings".
- **Per-agent config snapshot** (`src/sub-agents/snapshot.ts`): resolved once at `session_start`. Precedence: declaration staticOverrides < YAML < JSON. `AgentSnapshot` includes `name`, `source` (`'builtin'|'yaml'`), `sourcePath?`, `model?`, `reasoningEffort?`, `reserved`, `extra`, `allowedToolsSummary`. Disk changes after `session_start` do not affect the active session.
- **Idempotent session start** (`src/shared/session-state.ts`): `resetSessionRuntimeState()` clears EnabledSet, agent snapshot, sub-agent registry, model-family cache, and YAML diagnostics as the very first step in `handleSessionStart`.
- **YAML diagnostics + safe status output** (`src/sub-agents/diagnostics.ts`): YAML loader returns `{declarations, diagnostics}`. Conflicts (vs builtin or earlier YAML) are skipped with a diagnostic instead of throwing; non-conflicting agents in the same directory still load. `/blackbytes-status` renders new sections: **Sub-Agent Snapshot** (allowed tools summary, source, model/reasoning, reserved, extra) and **YAML Sub-Agents** (loaded files + skipped files with reasons).
- **Failure formatting / cancellation / bounded output**: runner exposes `formatDelegateFailure`, `classifyFailure`, `redactFailureText` with failure kinds: `failed`, `timed_out`, `cancelled`, `spawn_error`, `recursion_refused`, `cli_usage_error`, `invalid_tool_allowlist`, `provider_or_model_unavailable`.

## 0.1.0 (2026-04-18)

### Release surface

- Bundled local tools: `glob`, `grep`, `ast_grep_search`, `ast_grep_replace`, `hashline_edit`
- HTTP-backed tools: `websearch_search`, `websearch_fetch`, `context7_resolve_library_id`, `context7_query_docs`, `grep_app_search_github`
- Delegate tools: `delegate_explore`, `delegate_oracle`, `delegate_librarian`, `delegate_general`
- Pi commands: `/setup-models`, `/blackbytes-status`
- Bundled skills: `blackbytes-overview`, `hashline-workflow`, `delegation`

### Runtime behavior

- The enabled tool/sub-agent set is computed once at `session_start` and reused across registration and prompt augmentation.
- `before_agent_start` injects the Bytes prompt block and the current `<available_resources>` view.
- `tool_result` rewrites Pi `read` and `write` output for the hashline workflow.
- `before_provider_request` maps reasoning settings by model family and registers the GitHub Copilot initiator header when enabled.
- Delegate sessions run with runtime-enforced tool allowlists and a one-level recursion guard.

### Configuration

- Strict JSON configuration under `settings.json › blackbytes`
- Tool and sub-agent disabling via `disabled_tools` and `disabled_sub_agents`
- Websearch provider selection via `websearch.provider` with `exa_api_key` or `tavily_api_key`
- Optional Context7 API key under `context7.api_key`
- Per-agent overrides under `sub_agents.<name>`

### Constraints

- Node `>=20`
- Peer dependency: `@mariozechner/pi-coding-agent@^0.67`
- Package budget: `< 500KB` gzipped
