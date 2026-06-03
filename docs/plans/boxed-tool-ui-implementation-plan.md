# Blackbytes Boxed Tool UI — Implementation Plan

| Field | Value |
|---|---|
| Status | Active |
| Owner | invoker |
| Source Spec / PRD | [`../specs/boxed-tool-ui.md`](../specs/boxed-tool-ui.md) |
| Source Technical Design | [`../specs/boxed-tool-ui.md#6-technical-design`](../specs/boxed-tool-ui.md#6-technical-design) |
| Related ADRs | None present in this repo |
| Phase | Phase 1 MVP |

---

## 1. MVP-Lock

In this phase:

- REQ-001: shared boxed renderer framework.
- REQ-002: boxed UI for all Blackbytes tools.
- REQ-003: config schema/defaults.
- REQ-004: opt-in `bash` built-in wrapper.
- REQ-006: boxed `hashline_edit` diff/result rendering.

Out of this phase:

- Built-in `read/write/edit` wrappers unless implementation proves trivial after the `bash` wrapper seam is done.
- `grep/find/ls` wrappers.
- BoxEditor, fixed user zone, startup UI patch, terminal background sync, chat virtualization.
- Any runtime dependency for diffing/highlighting.
- Any change to tool execution semantics or model-visible tool output.

Exit criteria:

- All Blackbytes tools use boxed call/result renderers when `boxed_tool_calls !== false`.
- `bash` wrapper is registered only when `boxed_builtin_tools === true` and safely skipped if Pi factory access is unavailable.
- `hashline_edit` expanded diff remains available and boxed.
- Tests cover render helpers, shell highlighting, config, wrapper registration, and representative tool migration.
- `bun run lint && bun run build && bun run test` passes.

Scope changes after this plan require a delta-change doc.

## 2. Work Item Hierarchy

### Epic E-1: Shared rendering foundation

#### Task T-1: Build reusable boxed rendering helpers

- **T-001 — Implement boxed render primitives**
  - **What + why**: Create `src/tools/_shared/boxed-render.ts` with reusable box frame, call, result, compact footer, wrapping, and status helpers so every tool shares one visual grammar.
  - **Related files / packages**: `src/tools/_shared/boxed-render.ts`, `src/tools/_shared/__tests__/boxed-render.test.ts`, `@earendil-works/pi-tui` `Text`/component APIs.
  - **Acceptance criteria**: helpers render success/error/pending states; wrap width-aware content; preserve expand/collapsed paths; no runtime dependency added.
  - **Definition of Done**: implementation + unit tests + exported helper types.
  - **References**: [`boxed-tool-ui.md#req-001--shared-boxed-renderer`](../specs/boxed-tool-ui.md#req-001--shared-boxed-renderer).

- **T-002 — Implement shared tool-output utilities**
  - **What + why**: Create `src/tools/_shared/tool-output.ts` for text extraction, line/word counts, line clamping, notice stripping, and tail preview. Keeps output logic out of individual tools.
  - **Related files / packages**: `src/tools/_shared/tool-output.ts`, `src/tools/_shared/__tests__/tool-output.test.ts`.
  - **Acceptance criteria**: handles empty content, text blocks, long lines, trailing Pi truncation notices, tail preview, and expanded-line caps.
  - **Definition of Done**: implementation + unit tests.
  - **References**: [`boxed-tool-ui.md#64-api--public-contract`](../specs/boxed-tool-ui.md#64-api--public-contract), [`boxed-tool-ui.md#67-reliability--performance`](../specs/boxed-tool-ui.md#67-reliability--performance).

- **T-003 — Implement shell command highlighter**
  - **What + why**: Create `src/tools/_shared/shell-highlight.ts` with a dependency-free tokenizer/styler for `bash` call panels.
  - **Related files / packages**: `src/tools/_shared/shell-highlight.ts`, `src/tools/_shared/__tests__/shell-highlight.test.ts`.
  - **Acceptance criteria**: styles commands, flags, paths, shell variables, operators, and comments; gracefully falls back on unterminated quotes.
  - **Definition of Done**: implementation + unit tests with stub theme.
  - **References**: [`boxed-tool-ui.md#req-004--bash-wrapper-ux`](../specs/boxed-tool-ui.md#req-004--bash-wrapper-ux).

#### Task T-2: Add configuration support

- **T-004 — Extend Blackbytes config schema with boxed UI options**
  - **What + why**: Add `blackbytes.ui` options to `src/config/schema.ts` and a small resolver/helper for runtime defaults. Enables safe rollout and rollback.
  - **Related files / packages**: `src/config/schema.ts`, `src/config/__tests__/schema.test.ts`, possibly `src/config/loader.ts` if normalized access belongs there.
  - **Acceptance criteria**: validates documented options; clamps numeric limits; preserves passthrough unknown keys; defaults are true for Blackbytes boxed tools and false for built-in wrappers.
  - **Definition of Done**: schema/helper update + tests.
  - **References**: [`boxed-tool-ui.md#req-003--config-gated-built-in-wrappers`](../specs/boxed-tool-ui.md#req-003--config-gated-built-in-wrappers).

### Epic E-2: Migrate Blackbytes tool renderers

#### Task T-3: Replace generic call/result renderers for HTTP and search tools

- **T-005 — Migrate web/doc/code-search tools to boxed rendering**
  - **What + why**: Update `web_search`, `web_fetch`, `docs_resolve`, `docs_query`, and `gh_search` renderers to use shared boxed call/result helpers while preserving summaries and full text.
  - **Related files / packages**: `src/tools/websearch/search.ts`, `src/tools/websearch/fetch.ts`, `src/tools/context7/resolve.ts`, `src/tools/context7/query.ts`, `src/tools/grep-app/search.ts`, existing tests under each tool folder.
  - **Acceptance criteria**: collapsed result shows boxed summary + expand hint; expanded result shows capped full text; partial states render pending box.
  - **Definition of Done**: renderer updates + representative tests updated/added.
  - **References**: [`boxed-tool-ui.md#req-002--apply-boxed-ui-to-blackbytes-tools`](../specs/boxed-tool-ui.md#req-002--apply-boxed-ui-to-blackbytes-tools).

#### Task T-4: Replace local tool renderers

- **T-006 — Migrate ast/glob/look_at renderers to boxed rendering**
  - **What + why**: Update `ast_search`, `ast_replace`, `glob`, and `look_at` to use shared boxed call/result helpers.
  - **Related files / packages**: `src/tools/ast-grep/search.ts`, `src/tools/ast-grep/replace.ts`, `src/tools/glob/index.ts`, `src/tools/look-at/register.ts`, related tests.
  - **Acceptance criteria**: call boxes preserve key arguments; result boxes preserve current summaries/full output; no execution logic changes.
  - **Definition of Done**: renderer updates + tests.
  - **References**: [`boxed-tool-ui.md#req-002--apply-boxed-ui-to-blackbytes-tools`](../specs/boxed-tool-ui.md#req-002--apply-boxed-ui-to-blackbytes-tools).

- **T-007 — Convert hashline_edit result/call rendering to boxed style**
  - **What + why**: Adapt existing `hashline_edit` custom diff renderer to boxed panels while preserving structured `diffData`, `[E_*]` errors, and anchor workflow.
  - **Related files / packages**: `src/tools/hashline-edit/index.ts`, `src/tools/hashline-edit/result-renderer.ts`, `src/tools/hashline-edit/__tests__/result-renderer.test.ts`.
  - **Acceptance criteria**: collapsed view boxed summary only; expanded view boxed diff with `▌-`/`▌+`; errors visibly red; no mutation logic changes.
  - **Definition of Done**: renderer update + tests adapted from existing result-renderer tests.
  - **References**: [`boxed-tool-ui.md#req-006--diff-ux-upgrade-for-hashline_edit`](../specs/boxed-tool-ui.md#req-006--diff-ux-upgrade-for-hashline_edit), [`hashline-edit-hardening.md`](../specs/hashline-edit-hardening.md).

### Epic E-3: Built-in bash wrapper

#### Task T-5: Discover stable Pi built-in wrapper seam

- **T-008 — Spike Pi built-in `bash` factory access and registration behavior**
  - **What + why**: Determine the safest supported way to delegate execution to Pi's existing `bash` tool while replacing only renderers. This resolves spec Q-002 for Phase 1.
  - **Related files / packages**: current Pi package imports used by `pi-droid-styling` (`createBashTool`), local Pi extension docs if needed, `src/tools/builtin-wrappers/`.
  - **Acceptance criteria**: documented decision in code comments or test names; if factory is unavailable, wrapper implementation fails closed and Phase 1 can still ship without crashing.
  - **Definition of Done**: small wrapper seam or explicit skip helper + tests proving safe skip.
  - **References**: [`boxed-tool-ui.md#69-open-questions`](../specs/boxed-tool-ui.md#9-open-questions).

#### Task T-6: Implement opt-in bash wrapper

- **T-009 — Add `bash` boxed built-in wrapper**
  - **What + why**: Add `src/tools/builtin-wrappers/bash.ts` that delegates execution to Pi's `bash` implementation and supplies boxed call/result renderers.
  - **Related files / packages**: `src/tools/builtin-wrappers/bash.ts`, `src/tools/builtin-wrappers/index.ts`, `src/handlers/index.ts`, `src/test-utils/pi-mock.ts` if registration tests need support.
  - **Acceptance criteria**: registered only when `boxed_builtin_tools=true`; renderCall highlights command; collapsed result tail-previews output; expanded result caps output; footer includes elapsed/timeout/word count where available.
  - **Definition of Done**: implementation + wrapper registration tests + renderer tests.
  - **References**: [`boxed-tool-ui.md#req-004--bash-wrapper-ux`](../specs/boxed-tool-ui.md#req-004--bash-wrapper-ux).

### Epic E-4: Integration, docs, and verification

#### Task T-7: Wire registration and disable paths

- **T-010 — Integrate boxed UI registration in session_start**
  - **What + why**: Update registration flow so Blackbytes tools use boxed renderers when enabled and built-in wrappers register only under config gate.
  - **Related files / packages**: `src/handlers/index.ts`, `src/tools/_shared/register-tool.ts`, relevant integration tests.
  - **Acceptance criteria**: `boxed_tool_calls=false` falls back to legacy renderers for Blackbytes tools if implemented as dual path; `boxed_builtin_tools=false` leaves built-ins untouched; disabled tools still obey enabled-set behavior.
  - **Definition of Done**: integration tests for enabled/disabled paths.
  - **References**: [`AGENTS.md#registration-flow-critical`](../../AGENTS.md#registration-flow-critical), [`boxed-tool-ui.md#65-integration--events`](../specs/boxed-tool-ui.md#65-integration--events).

- **T-011 — Update docs and status surfaces**
  - **What + why**: Document config options in `AGENTS.md` and, if appropriate, `/blackbytes-status` redacted config output so users can verify rollback settings.
  - **Related files / packages**: `AGENTS.md`, `src/commands/blackbytes-status.ts`, tests if status output changes.
  - **Acceptance criteria**: config docs list defaults and rollback snippet; status command does not expose secrets; no outdated mention of render layer remains.
  - **Definition of Done**: docs update + tests if status command changes.
  - **References**: [`boxed-tool-ui.md#64-api--public-contract`](../specs/boxed-tool-ui.md#64-api--public-contract).

#### Task T-8: Final verification

- **T-012 — Run full verification and size check**
  - **What + why**: Ensure the feature is safe to ship and package budget remains healthy.
  - **Related files / packages**: all changed files; package scripts.
  - **Acceptance criteria**: `bun run lint`, `bun run build`, `bun run test` pass; run `bun run check:size` if helper additions look size-risky.
  - **Definition of Done**: verification output captured in final report; failures fixed or documented honestly.
  - **References**: [`AGENTS.md#development`](../../AGENTS.md#development).

## 3. Dependencies

| Edge | Reason |
|---|---|
| T-002 depends on T-001 | Output utilities feed boxed result bodies and footers. |
| T-003 depends on T-001 | Shell highlighting is consumed by boxed `bash` call rendering. |
| T-004 depends on T-001 | Config defaults must know which renderer modes exist. |
| T-005 depends on T-001, T-002, T-004 | Tool migration needs render primitives, output helpers, and config path. |
| T-006 depends on T-001, T-002, T-004 | Same as T-005 for local tools. |
| T-007 depends on T-001, T-002 | Hashline diff renderer needs boxed result primitives and output clamp helpers. |
| T-008 depends on T-004 | Built-in seam uses config-gated registration. |
| T-009 depends on T-001, T-002, T-003, T-004, T-008 | Bash wrapper needs all shared helpers and the factory seam decision. |
| T-010 depends on T-005, T-006, T-007, T-009 | Integration wires all renderer migrations and wrapper registration. |
| T-011 depends on T-004, T-010 | Docs/status should match final config and registration behavior. |
| T-012 depends on T-010, T-011 | Final verification after integration and docs. |

No cycles. Bottlenecks: T-001 and T-004 block most work; T-008 blocks only built-in `bash`.

## 4. Test Strategy

- Unit tests for shared helpers using `node:test` and `node:assert/strict`.
- Stub theme token tests following the existing sub-agent/hashline renderer test pattern.
- Integration-style registration tests using `src/test-utils/pi-mock.ts`.
- Existing tool tests updated only where renderer expectations change.
- Verification commands in project order: `bun run lint && bun run build && bun run test`.
- Optional: `bun run check:size` after implementation because helper code touches package budget, though no dependency is added.

## 5. Migration / Rollback

Migration:

- No database or file migration.
- Config keys are optional; defaults apply at runtime.

Backward compatibility:

- Blackbytes tool execution and schemas preserved.
- Built-in wrapper registration is opt-in (`boxed_builtin_tools=false` by default).
- Existing `read` anchor-clean renderer behavior is not changed in Phase 1.

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

If a built-in wrapper fails during registration, skip it and leave Pi core behavior active.

## 6. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | Built-in wrapper seam may differ across Pi versions | T-008 spike; fail closed; keep opt-in | open |
| R-002 | Too much vertical space from boxes | Use compact one-line call boxes where possible; cap collapsed previews | open |
| R-003 | Renderer migration touches many files | Shared helpers first; migrate by families; tests catch regressions | open |
| R-004 | `boxed_tool_calls=false` legacy fallback could add complexity | If too costly, limit fallback to built-ins only and document visual change; decide during T-010 | open |
| Q-001 | Are `read/write/edit` wrappers included in Phase 1? | No, unless trivial after T-009; otherwise Phase 2/delta | answered |

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-06-03 | Bytes | Created Draft implementation plan after scope confirmation |
