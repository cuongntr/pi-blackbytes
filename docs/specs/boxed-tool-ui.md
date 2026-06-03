# Blackbytes Boxed Tool UI — Product + Technical Spec

> **Status**: Accepted
> **Date**: 2026-06-03
> **Owner**: invoker
> **Variant**: brownfield (extends existing Pi extension rendering surfaces)
> **Source / Motivation**: review of [`sting8k/pi-droid-styling`](https://github.com/sting8k/pi-droid-styling), especially boxed toolcall/result rendering for built-in `bash` output
> **Related docs**: [`hashline-edit-hardening.md`](./hashline-edit-hardening.md), [`subagent-ui-polish.md`](./subagent-ui-polish.md)

---

## 1. Context

`pi-blackbytes` already improves extension-tool and sub-agent rendering, but tool calls still use a mix of simple one-line renderers and specialized result panels. The user explicitly likes `pi-droid-styling`'s boxed toolcall/output UX, especially for `bash` output, and wants the same visual language applied broadly.

This feature adds a native Blackbytes boxed rendering layer used by all Blackbytes tools by default, plus an opt-in boxed `bash` wrapper and the always-on clean `read` renderer for built-in Pi tools.

This is a UI/rendering feature only. Tool execution semantics, tool schemas, returned model-visible content, hashline anchor behavior, and sub-agent execution are not changed.

## 2. Goals and Success Metrics

- **Consistent tool UI**: every Blackbytes tool call/result uses the same boxed visual grammar.
- **Better bash scanability**: opt-in built-in `bash` wrapper shows command, tail output, expand behavior, and footer metadata in a compact box.
- **Safe rollout**: built-in wrappers are disabled by default and can be rolled back by config without uninstalling the extension.
- **Low maintenance risk**: avoid broad TUI/editor/startup monkey patches; use `registerTool`/renderer surfaces where possible.
- **Performance preserved**: renderers avoid full-output processing in collapsed view; long lines and expanded output are capped.

Measurable acceptance:

- Blackbytes extension tools render boxed call/result panels in tests.
- The built-in `bash` wrapper does not register unless `boxed_builtin_tools` is enabled; the built-in `read` renderer remains active and strips anchors from display.
- `bash` collapsed result processes only tail-preview-sized output, not full split of large output.
- `bun run lint && bun run build && bun run test` passes.
- Package remains under the existing `<500KB` gzipped budget.

## 3. Personas / Users

- **Primary**: Pi user running long coding sessions who needs to quickly scan tool activity and outputs.
- **Secondary**: Pi-blackbytes maintainer who needs render behavior to stay testable, config-gated, and low-risk across Pi `0.74.x–0.x`.

## 4. Requirements

### REQ-001 — Shared boxed renderer

Priority: P0

Acceptance criteria:

- Provides reusable helpers for boxed call panels, boxed result panels, compact footer, wrapping, truncation, and status styling.
- Supports success/error/pending/partial states.
- Uses Pi theme semantic tokens; no hardcoded 24-bit theme dependency for tool boxes.
- Has unit tests for width wrapping, footer formatting, collapsed/expanded behavior, and ANSI-safe truncation.

### REQ-002 — Apply boxed UI to Blackbytes tools

Priority: P0

Acceptance criteria:

- Applies to: `hashline_edit`, `ast_search`, `ast_replace`, `glob`, `look_at`, `web_search`, `web_fetch`, `docs_resolve`, `docs_query`, `gh_search`.
- Existing execution behavior and details payloads remain compatible.
- `hashline_edit` keeps `[E_*]` error taxonomy and structured `diffData` support.
- Expanded result behavior remains available via Pi's existing expand key.

### REQ-003 — Config-gated built-in wrappers

Priority: P0

Acceptance criteria:

- Adds config under `blackbytes.ui`:
  - `boxed_tool_calls?: boolean` default `true`
  - `boxed_builtin_tools?: boolean` default `false`
  - `boxed_max_preview_lines?: number` default `5`
  - `boxed_max_expanded_lines?: number` default `200`
  - `boxed_dim_output?: boolean` default `false`
- The built-in `bash` wrapper is registered only when `boxed_builtin_tools` is true.
- If disabled, Pi built-in tool behavior is untouched except the existing hashline read-renderer behavior.
- Schema remains passthrough for unknown keys.

### REQ-004 — Bash wrapper UX

Priority: P0

Acceptance criteria:

- Boxed call panel shows multi-line command with `$` / `>` prompt markers.
- Shell command highlighter handles commands, flags, paths, shell variables, operators, and comments without requiring a new dependency.
- Collapsed result shows tail preview with line cap and long-line clamp.
- Expanded result shows capped output with explicit elision hint when output exceeds limit.
- Strips Pi truncation notice lines like `[Showing last ... Full output: ...]` from preview body while preserving useful summary/footer data.
- Footer shows elapsed time when available, timeout, and approximate word count.

### REQ-005 — Built-in read renderer

Priority: P1

Acceptance criteria:

- `read` renderer preserves hashline clean-read compatibility.
- `read` collapsed result summarizes file/path/line count; expanded result can show output with syntax highlighting only if Pi's existing helper is available and safe.
- If Pi does not expose a stable create-tool factory for a built-in wrapper, that wrapper is skipped with no fatal error.

### REQ-006 — Diff UX upgrade for `hashline_edit`

Priority: P1

Acceptance criteria:

- Existing inline diff renderer is converted to boxed result style.
- Collapsed view remains compact and does not dump diff lines.
- Expanded view shows additions/removals with visible `▌-` / `▌+` markers and theme colors.
- Optional additions/removals counts may be added if it does not require heavy diff logic.

## 5. Out of Scope

- BoxEditor or custom input editor replacement.
- Fixed user zone / status-editor-footer cluster layout.
- Startup UI/header patching.
- Terminal background synchronization.
- Chat virtualization.
- `console.log` suppression.
- Full theme-extras scanner.
- New runtime dependencies for diffing/highlighting.
- Changes to tool execution semantics or model-visible content beyond existing renderer-only surfaces.

## 6. Technical Design

### 6.1 Boundaries

This design owns:

- Shared boxed render helpers for tool call/result components.
- Migration of Blackbytes tool renderers to boxed style.
- Optional boxed `bash` wrapper and built-in `read` renderer compatibility.
- Config schema and tests for the UI options.

This design does not own:

- Pi core TUI layout or editor components.
- Sub-agent executor/progress internals.
- Hashline edit mutation logic.
- Tool-result rewriting logic except where existing renderer compatibility requires it.

### 6.2 Architecture

```text
src/config/schema.ts
  └─ blackbytes.ui boxed options

src/tools/_shared/boxed-render.ts
  ├─ renderBoxedToolCall()
  ├─ renderCompactBoxedToolCall()
  ├─ renderBoxedToolResult()
  ├─ renderBoxedFooter()
  └─ box width/wrap helpers

src/tools/_shared/tool-output.ts
  ├─ getTextOutput()
  ├─ countLines()/countWords()
  ├─ tailPreview()
  ├─ clampLine()/stripTrailingNotice()
  └─ output cap helpers

src/tools/_shared/shell-highlight.ts
  └─ highlightShellLine() dependency-free tokenizer/styler

src/tools/<blackbytes tool>/...
  └─ renderCall/renderResult call boxed helpers

src/tools/builtin-wrappers/bash.ts
  └─ opt-in register function, guarded by config + available Pi factory
src/tools/hashline-edit/read-renderer.ts
  └─ clean read renderer that strips anchors from visible output

src/handlers/index.ts
  └─ session_start registers wrappers after config/enabled-set is loaded
```

Rendering stays inside Pi extension tool-definition surfaces (`renderCall`, `renderResult`) rather than patching global TUI layout. The boxed `bash` wrapper registers only behind `boxed_builtin_tools: true`; the built-in `read` renderer remains always active.

### 6.3 Data Model / Schema

No database or persistent data model changes.

Config schema change in `src/config/schema.ts`:

```ts
ui: z.object({
  boxed_tool_calls: z.boolean().optional(),
  boxed_builtin_tools: z.boolean().optional(),
  boxed_max_preview_lines: z.number().int().min(0).max(1000).optional(),
  boxed_max_expanded_lines: z.number().int().min(0).max(5000).optional(),
  boxed_dim_output: z.boolean().optional(),
}).optional()
```

Runtime defaults are applied by a helper, not by mutating the user's settings file:

```ts
const DEFAULT_BOXED_UI = {
  boxed_tool_calls: true,
  boxed_builtin_tools: false,
  boxed_max_preview_lines: 5,
  boxed_max_expanded_lines: 200,
  boxed_dim_output: false,
};
```

### 6.4 API / Public Contract

No HTTP/API contract.

Configuration contract:

```json
{
  "blackbytes": {
    "ui": {
      "boxed_tool_calls": true,
      "boxed_builtin_tools": false,
      "boxed_max_preview_lines": 5,
      "boxed_max_expanded_lines": 200,
      "boxed_dim_output": false
    }
  }
}
```

Existing `disabled_tools` still controls Blackbytes extension tools. Built-in wrapper enablement is controlled separately by `boxed_builtin_tools` because built-ins are not Blackbytes resources in `resource-metadata.ts`.

### 6.5 Integration & Events

- `session_start`: load config, register existing Blackbytes tools using boxed renderers when `boxed_tool_calls !== false`.
- `session_start`: register the built-in `bash` wrapper only when `boxed_builtin_tools === true`.
- Existing `tool_result` handler remains unchanged for hashline read/write output processing.

### 6.6 Security

No auth/security model change.

Renderer safety requirements:

- Do not log or persist tool output.
- Do not expose more content in collapsed view than current result content already contains.
- Avoid evaluating shell text; shell highlighting is lexical only.
- Redaction is not added here; renderer consumes already-produced tool content.

### 6.7 Reliability / Performance

- Collapsed `bash` preview scans backwards for the last N lines instead of splitting full output.
- Long lines are clamped before wrapping.
- Expanded output respects `boxed_max_expanded_lines`; `0` means no expanded body except summary/footer.
- Renderer helpers cache only per-component render calculations when safe; no global output cache.
- Built-in wrappers fail closed: if a Pi factory is unavailable or throws during registration, skip that wrapper and leave core behavior intact.

### 6.8 Backward Compatibility

Preserved:

- Tool names and parameter schemas for all Blackbytes tools.
- Tool execution result text/details consumed by models.
- Hashline anchor format, strict patch behavior, error codes, and `postEditVerify` behavior.
- Existing config keys.

Potentially changed:

- Visual rendering of Blackbytes tool calls/results when `boxed_tool_calls` is default true.
- Visual rendering of selected built-ins only when `boxed_builtin_tools` is explicitly true.

Rollback:

```json
{
  "blackbytes": {
    "ui": {
      "boxed_tool_calls": false,
      "boxed_builtin_tools": false
    }
  }
}
```

### 6.9 Sequence Flows

#### Flow A — Blackbytes tool render

```text
Agent invokes web_search
  → registered tool executes existing HTTP client
  → result details include summary/fullText as today
  → renderCall uses boxed call helper
  → renderResult:
      collapsed: boxed summary + footer + expand hint
      expanded: boxed full text with cap/elision
```

#### Flow B — Built-in bash wrapper render

```text
Session starts with boxed_builtin_tools=true
  → registerBashWrapper() creates/loads Pi bash tool factory
  → wrapper delegates execute() to Pi bash implementation
  → renderCall shows highlighted command in box
  → renderResult:
      partial: pending box
      collapsed: tail preview + footer
      expanded: capped full output + footer
```

#### Flow C — Bash wrapper unavailable

```text
Session starts with boxed_builtin_tools=true
  → registerBashWrapper() attempts to locate stable Pi bash factory
  → factory unavailable / incompatible
  → wrapper skipped
  → Pi core bash tool remains active
  → no fatal session failure
```

### 6.10 Testing Strategy

Use Node test runner via existing command `bun run test`.

Tests:

- `src/tools/_shared/__tests__/boxed-render.test.ts`
  - box width/wrap behavior
  - collapsed vs expanded result
  - footer formatting
  - error/pending state color-token assertions using stub theme
- `src/tools/_shared/__tests__/tool-output.test.ts`
  - tail preview without full split for large strings where practical
  - truncation notice stripping
  - count lines/words
- `src/tools/_shared/__tests__/shell-highlight.test.ts`
  - command/flags/vars/operators/comments token styling
  - unterminated quotes fallback behavior
- Config tests in `src/config/__tests__/schema.test.ts` / loader tests.
- Built-in wrapper tests:
  - disabled by default
  - enabled registers the bash wrapper when a factory is provided
  - unavailable factory skips safely
- Existing tool renderer tests updated for boxed output.

Verification order per project: `bun run lint && bun run build && bun run test`.

## 7. Phase 1 MVP Scope

In Phase 1 MVP:

- REQ-001 shared boxed renderer.
- REQ-002 all Blackbytes tools use boxed rendering.
- REQ-003 config schema/defaults.
- REQ-004 `bash` built-in wrapper.
- REQ-006 `hashline_edit` boxed diff/result.

Deferred to Phase 2:

- No additional built-in wrappers beyond the boxed `bash` wrapper; the clean `read` renderer stays in place.
- Optional `grep/find/ls` wrappers.
- More advanced diff meter or syntax highlighting.

Exit criteria:

- Blackbytes tools visually unified in automated renderer tests.
- `bash` wrapper opt-in tests pass.
- Full verification command passes.

## 8. Risks & Mitigations

| ID | Risk | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | Built-in re-registration conflicts with Pi core or another extension | Keep built-ins opt-in; skip unavailable factories; document rollback config | open |
| R-002 | Boxed render consumes too much vertical space | Use compact one-line boxed call where possible; collapsed results show tail/summary only | open |
| R-003 | Renderer tests become brittle due theme ANSI output | Use stub theme token assertions, not golden ANSI snapshots | open |
| R-004 | Package size grows beyond 500KB | No new runtime dependencies; pure helpers; run `bun run check:size` if size looks risky | open |
| R-005 | Existing hashline read-renderer behavior regresses | Add focused compatibility tests; do not alter tool_result rewrite | open |

## 9. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | Should `boxed_tool_calls` default true for all existing users, or ship one release with false default? | invoker | answered: default true for Blackbytes tools |
| Q-002 | Which built-in factories are stable across Pi `>=0.74.0 <1`? | implementer | open, resolved during implementation spike |
| Q-003 | Should `grep/find/ls` be Phase 1 or Phase 2? | invoker | answered: Phase 2 unless trivial |

## 10. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-06-03 | Bytes | Created Draft after user confirmed scope |
