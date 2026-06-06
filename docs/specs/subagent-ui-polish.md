# Sub-Agent UI Polish — Quick Plan

> **Status**: ✅ Done (T1+T2+T3 shipped 2026-05-26)
> **Date**: 2026-05-26
> **Owner**: invoker
> **Related**: `delegation-monitor-panel.md` (orthogonal — side panel, not blocked by this)
>
> **Outcome**: 211 LOC source + 451 LOC test across 7 files. 645/645 tests pass (+47 new, 0 regression). Bundle 257.62 KB (well under 500 KB budget). Public API + config + YAML schema unchanged. Manual UI verification pending on user side.

---

## Scope

Cải thiện **inline result panel** của sub-agent (cái render trực tiếp trong chat flow qua `renderResult`) về 4 khía cạnh: agent identity, running feedback, duration precision, failed-state visibility.

## Out of scope

- Side panel / overlay toggle (xem `delegation-monitor-panel.md`).
- Backend refactor: executor split, lifecycle emitter, reactive store, registry layer (xem `sub-agent-management-migration.md` — đã review, reject phần lớn).
- Config schema thay đổi (không thêm `render_strategy`, không thêm `silent` mode).
- Reactive `/blackbytes-status` update.
- YAML loader refactor.

## Estimate

2-3 ngày, ~170 LOC, **render-only**. Không đụng executor / progress logic / public API / config schema.

---

## Approach

### Nguyên tắc

1. **Render-only**: tất cả thay đổi nằm trong `src/sub-agents/render.ts` + helper format thuần trong `progress-reporter.ts` (hoặc file mới `src/sub-agents/format.ts` nếu helper dùng chung nhiều chỗ).
2. **Reuse**:
   - `SUB_AGENT_ICONS` đã có ở [`register.ts:29-35`](file:///Users/invoker/Work/personal/pi-blackbytes/src/sub-agents/register.ts#L29-L35) — export ra để render.ts dùng chung (hoặc move sang file riêng `icons.ts`).
   - Follow convention của [`stats-render.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/_shared/stats-render.ts) (icon-only, không lặp status text).
3. **Per-row `setInterval` + `context.invalidate()`** — pattern hiện tại đúng theo Pi tui docs. Không có primitive spinner riêng cho `renderResult` slot. Module-level shared timer **rejected** (thêm bookkeeping, không lợi ích khi chỉ 1-3 timer parallel). Chỉ cần tăng tick từ 1000ms → 100ms và compute frame từ timestamp (no counter).
4. **Backward-compat**: `SubAgentRenderDetails` interface giữ nguyên field. `buildSubAgentRenderResult()` signature không đổi. YAML / config / public API zero break.

### Refs

- Code: [`render.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/sub-agents/render.ts), [`progress-reporter.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/sub-agents/progress-reporter.ts), [`register.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/sub-agents/register.ts) (icons + call-render).
- Convention: [`stats-render.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/_shared/stats-render.ts) cho icon-only header pattern.
- Pi tui doc: `docs/tui.md` (đã đọc — kết luận: per-row setInterval là cách duy nhất cho tool slot animation).
- Pi extensions doc: `docs/extensions.md` (sử dụng `keyHint()` thay `keyText()+manual compose` ở T3).

---

## Tasks

### T1 — Header redesign (~80 LOC) — HIGHEST priority — ✅ DONE

**Changes** trong `render.ts`:

- Thêm `agentIcon` vào đầu header bits, đọc từ `SUB_AGENT_ICONS[details.agent]` (fallback `▸`).
- Thêm spinner braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` cho `status === "running"`. Giữ per-row `setInterval` ở [`render.ts:223`](file:///Users/invoker/Work/personal/pi-blackbytes/src/sub-agents/render.ts#L223), tăng từ 1000ms → 100ms. Frame compute: `frames[Math.floor(Date.now()/100) % frames.length]` (no counter state).
- Bỏ status text khi đã có icon (`✓ explore` thay `✓ completed`). Failed vẫn giữ tail error (xem T3).
- Smart duration format multi-tier:
  - `< 1ms` → `<1ms`
  - `< 1s` → `47ms`, `200ms`
  - `< 60s` → `3.2s`
  - `< 1h` → `2m 7s`
  - else → `1h 12m`
- Move `model` name từ header xuống expanded body (giảm noise header).
- Keep last tool dim khi giữa 2 calls (currentTool undefined giữa `tool_execution_end` và next `tool_execution_start`): show `◷ <lastTool>` muted thay vì drop.

**Mock**:
```
⠹ 🔭 explore · 9.0s · 4 calls · ◷ read src/index.ts · 264 chars
✓ 🔭 explore · 13.9s · 4 calls · 2.4k chars
```

### T2 — Tool timeline precision + readability (~40 LOC) — ✅ DONE

**Changes** trong `render.ts` (timeline render) + `progress-reporter.ts` (arg summary):

- Apply smart duration formatter từ T1 vào tool history → fix `(0.0s)` epidemic.
- Smart path truncation trong `summarizeToolArgs`:
  - Path: nếu > MAX, ưu tiên `…/parent/basename.ts` thay vì cắt cuối.
  - Bash command: cắt sau `&&` đầu tiên nếu vượt MAX.
- Add `toolTitle` color cho tool name trong timeline (hiện chỉ bold).

**Mock**:
```
  ✓ glob src/**/*.ts (12ms)
  ✓ read src/index.ts (8ms)
  ✓ read …/sub-agents/register.ts (47ms)
```

### T3 — Failed visibility + expanded footer (~50 LOC) — ✅ DONE

**Changes** trong `render.ts`:

- Khi `status === "failed"` collapsed: auto-show 1-line error summary trong header tail (truncated 60 chars). Source: `getResultText(result)` first line, hoặc `failureKind` từ details.
- Khi expanded: thêm footer aggregate cuối tool timeline:
  - `Tools: 50× read · 30× bash · 20× ast_search`
  - `Model: <name> · Cost: <smart-format>`
- Smart cost format:
  - `< $0.01` → `<$0.01`
  - `< $1` → `$0.05`
  - `< $100` → `$1.23`
  - else → `$123` (no decimal)

**Mock**:
```
✗ 🔭 explore · 1.4s · 0 calls · timeout after 600s
─ Tools: 4× read · 1× glob
─ Model: gemini-3-flash-preview · Cost: <$0.01
```

---

## Verify

### Manual

Chạy từ Pi session:
1. `explore` với câu hỏi cần ≥4 tool calls → verify running spinner + agent icon + last-tool dim.
2. `oracle` long-running (timeout dài) → verify duration scale `2m 7s` đúng.
3. Force fail (vd disable tool agent cần) → verify error inline ở collapsed header.
4. Expand bằng Ctrl+O → verify aggregate footer + cost format.

Screenshot before/after ở 1 width chuẩn (terminal ngồi làm việc thường ngày) — không cần multi-width per user confirm.

### Auto

- Update `src/sub-agents/__tests__/render.test.ts` nếu có (hoặc tạo mới). Snapshot test 4 state: running / completed / failed / cancelled.
- Update test trong `progress-reporter.test.ts` cho `summarizeToolArgs` mới (path basename, bash split).
- Run `bun run check`.

### Regression check

- `register.test.ts` (931 LOC) không nên break — chỉ render layer thay đổi, executor logic không đụng.
- Visual parity: aggregate footer + model relocate không làm mất info, chỉ chuyển chỗ.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Spinner 100ms × N delegations gây CPU spike | Low-Medium | Test thực tế lúc T1. Fallback: tăng tick lên 150ms (~7fps, vẫn smooth braille) hoặc batched invalidate |
| Snapshot test brittle vì format thay đổi | High | Test theo từng bit (status icon + agent + duration) riêng thay vì golden string |
| Theme variation (user theme khác default) làm `toolTitle` color trông sai | Low | Dùng theme tokens có sẵn, không hardcode hex |
| Smart path basename hiểu sai non-path strings | Low | Detect `/` hoặc `\` trước khi áp dụng basename logic |

---

## Done check

- [x] T1, T2, T3 đều ship.
- [x] `bun run check` xanh.
- [ ] Manual verify 4 case ở trên (pending user-side UI inspection).
- [ ] Screenshot before/after attach vào PR.
- [ ] Plan này update status từ "Approved" → "Done", thêm link PR.

---

## Implementation notes (post-mortem)

### Architecture choices that survived contact with code

- **Per-row `setInterval` (not shared timer)** — confirmed correct per `docs/tui.md`. No Pi primitive for tool-slot animation; module-level singleton would add registry bookkeeping with zero benefit for typical 1-3 parallel delegations.
- **Fuse status icon + agent name into 1 header bit** — avoids unwanted `·` separator between spinner and agent label.
- **Agent name colored by `statusColor`** — reinforces status hierarchy (failed name = red, running = accent).
- **Per-slot test stub theme `«token:text»`** — lets bit-by-bit assertions check color choices without depending on ANSI escapes or real Pi Theme.

### Architecture choices that got rolled back

- **`keyHint()` cleanup (T3 plan)** — REVERTED. `keyHint()` requires theme initialization and throws in tests + during host boot. Kept the original `keyText() || "ctrl+o"` manual compose with a comment explaining the constraint. Micro-readability win was not worth the runtime crash risk.
- **Standalone `model: xxx` line at top of expanded body (T1 transitional)** — REMOVED in T3 in favor of consolidated footer `model · Tools: ... · cost`.

### Bugs caught by test gate during implementation

- `truncatePath(p, 0)` returned full string because `slice(-0) === slice(0)`. Added `if (max <= 0) return ""` guard.
- T1 assertion expected single `«error:»` bit on failed status; actual was 2 because agent name also inherits status color. Fixed assertion to match correct visual behavior rather than refactor render to match test.

### Files changed

| File | Status | Notes |
|---|---|---|
| `src/sub-agents/icons.ts` | new (+19) | Extracted `SUB_AGENT_ICONS` from `register.ts` for sharing with `render.ts` |
| `src/sub-agents/format.ts` | new (+103) | `SPINNER_FRAMES`, `getSpinnerFrame()`, `formatDuration()`, `truncatePath()`, `formatCost()` |
| `src/sub-agents/render.ts` | modified (+85 net) | Header redesign, footer aggregate, error hint extraction |
| `src/sub-agents/progress-reporter.ts` | modified (+8) | Wire `truncatePath` into `summarizeToolArgs` for path-like keys |
| `src/sub-agents/register.ts` | modified (−8) | Replaced inline `SUB_AGENT_ICONS` with import from `icons.ts` |
| `src/sub-agents/__tests__/format.test.ts` | new (+154) | 22 cases covering all formatters |
| `src/sub-agents/__tests__/render.test.ts` | new (+297) | 25 cases covering header bits, current/last tool, error hint, footer aggregate |

### Manual verification checklist (for user)

Run a session with each scenario and visually confirm:

- [ ] **Running**: spinner braille animates smoothly (~10fps), agent icon 🔭/🧠/📚/⚡/📋 shows beside name in accent color.
- [ ] **Running between calls**: when `currentTool` clears momentarily, `◷ <lastTool>` appears muted instead of going blank.
- [ ] **Completed**: header reads `✓ <agent> · <duration> · N calls · <chars> chars` — no "completed" word, model is in expanded footer not header.
- [ ] **Failed**: header reads `✗ <agent> · <duration> · <one-line error in red>` — user can see *why* without expanding.
- [ ] **Sub-second tools**: timeline shows `(47ms)` not `(0.0s)`.
- [ ] **Long paths**: tool arg shows `…/sub-agents/render.ts` not `/Users/invoker/Work/personal/pi-bla…` (filename always visible).
- [ ] **Expanded footer**: `<model> · Tools: 12× read · 4× bash · $0.004` (smart cost format, tool aggregate sorted by count).
