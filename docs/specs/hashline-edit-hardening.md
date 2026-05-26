# Hashline Edit Hardening — Correctness, Token Efficiency, UX

> **Status**: ✅ Done (Phase 1 + Phase 2 shipped together) · ⏳ Phase 3 deferred
> **Date**: 2026-05-26
> **Owner**: invoker
> **Variant**: brownfield (extending existing tool, no new ADR)
> **Estimate**: Phase 1 (~600 LOC, 4-5 ngày) + Phase 2 (~200 LOC, 1-2 ngày). Phase 3 đánh giá riêng.
> **Related cross-project review**: so sánh với [`pi-hashline-edit`](https://github.com/RimuruW/pi-hashline-edit) và [`pi-hashline-readmap`](https://github.com/coctostan/pi-hashline-readmap) → quyết định port các correctness/UX gap nhỏ, không port mảng readmap khổng lồ.

---

## 1. Problem

`hashline_edit` của `pi-blackbytes` (xem [`src/tools/hashline-edit/index.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/index.ts)) hoạt động đúng cho happy path nhưng thua hai project tham chiếu ở **6 nhóm vấn đề**:

1. **Write không atomic.** `writeFileSync(filePath, …)` trực tiếp — interrupt giữa chừng có thể truncate file. `pi-hashline-edit` dùng temp+rename, blackbytes thì không.
2. **Không preserve symlink/hardlink/permission.** `writeFileSync` ghi đè theo path literal → break symlink chain, mất hard-link inode, mất file mode bits.
3. **Mutation queue không canonical.** [`runQueuedHashlineEdit`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/index.ts#L341-L356) queue theo `input.filePath` literal; hai alias (symlink path A và canonical path B) → hai queue riêng → race condition trên cùng inode.
4. **Không có `replace_text` op.** Khi anchor stale, model chỉ có thể fail và bắt buộc re-read. Hai project tham chiếu đều có exact-unique substring fallback giảm round-trip.
5. **Không có diff preview + "Updated anchors" trong response.** Mỗi lần edit xong, model phải `read` lại nếu muốn chained edit gần đó. Token-waste lặp lại.
6. **Silent autocorrect ẩn lỗi model.** [`stripLineIdPrefix`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/index.ts#L70-L74) âm thầm strip prefix `LINE#ID|` khi model dán nhầm — ngược triết lý "strict anchors fail" của hashline. Cũng không có error code taxonomy → LLM khó phân loại lỗi để retry đúng cách.

Phụ:

7. **Error trả về không có code phân loại** (chỉ free-text). LLM khó switch logic theo loại lỗi (`hash-mismatch` vs `text-not-found` vs `multi-match`).
8. **Không có `postEditVerify` flag** — không bắt được corruption silent (BOM/CRLF restore sai, encoding edge case).
9. **TUI result hiện không hiển thị diff** — user phải mở file riêng để verify edit đã đúng chưa.

Không thuộc scope spec này (xem § 2):

- Structural readmap / symbol-aware read / `replace_symbol` op.
- Override `read` / `grep` / `ls` / `find` / `write` của pi.
- RTK bash compression.
- Tree-sitter syntax regression validate.
- Difftastic semantic summaries.

---

## 2. Non-Goals

- **Không** thay đổi public schema theo cách phá vỡ caller cũ. Mọi field mới (`replace_text`, `postEditVerify`, returnMode) đều optional, default off, schema hiện tại vẫn parse được payload cũ.
- **Không** thêm dependency runtime nặng. Nếu cần diff, viết ~50 LOC line-level diff thuần (không pull `diff` package). Budget 500KB gzipped phải giữ.
- **Không** port readmap (~2.5k LOC), `replace_symbol` (~400 LOC + parsers), syntax validate (~500 LOC + WASM grammars), RTK (~2k LOC). Lý do và phân loại đầy đủ ở phần Tier C của câu trả lời cross-project review (chat 2026-05-26).
- **Không** override `read` của pi. Giữ approach hiện tại (tool_result rewrite cho anchors via [`read-renderer.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/read-renderer.ts)).
- **Không** thay đổi hash function (custom 16-bit hash hiện tại). Trade-off collision đã accepted; thay sang xxHash là spec riêng nếu cần.
- **Không** tách `hashline_edit` ra package riêng (như `pi-hashline-edit`). Giữ là một tool trong blackbytes extension.

---

## 3. Solution Overview

Chia thành **3 phases độc lập**:

| Phase | Mục tiêu | LOC | Effort | Ship riêng? |
|---|---|---|---|---|
| Phase 1 | Correctness (atomic/symlink/hardlink/perm/canonical queue) + UX cốt lõi (`replace_text`, diff preview, Updated anchors, error codes, strict patch) | ~600 | 4-5 ngày | ✅ |
| Phase 2 | UX nâng cao (inline TUI diff, `postEditVerify`, edit variant aliases) | ~200 | 1-2 ngày | ✅ |
| Phase 3 | Optional / cần spike (`replace_symbol` qua ast-grep CLI, project-local settings, policy export) | ~300 | Đánh giá riêng sau Phase 1+2 | Spec riêng |

Mỗi phase pass `lint + build + test` độc lập, không phụ thuộc nhau về schema.

### 3.1 Thiết kế chính

**A. Atomic write + alias preservation** (new file `src/tools/hashline-edit/fs-write.ts`, ~120 LOC)

```ts
// Pseudo-API
async function resolveWriteTarget(path: string): Promise<{
  canonicalPath: string;   // realpath sau khi resolve symlink chain
  isSymlink: boolean;
  hardLinkCount: number;   // > 1 → write in-place giữ inode
  mode: number;            // preserve file mode
}>;

async function writeFileAtomically(
  targetPath: string,         // canonical path
  hardLinkCount: number,
  mode: number,
  content: string,
): Promise<void>;
// hardLinkCount > 1 → openSync(O_WRONLY|O_TRUNC) + writeSync + close (in-place)
// hardLinkCount = 1 → write to "<dir>/.<basename>.tmp.<pid>" + chmod + renameSync
```

Logic:

1. `fs.realpathSync(path)` → canonical.
2. `fs.lstatSync(path)` → detect symlink.
3. `fs.statSync(canonical)` → `nlink` + `mode`.
4. Nếu `nlink > 1` → in-place write (giữ inode, giữ hardlink mates).
5. Ngược lại → write temp `.<name>.tmp.<pid>.<rand>` ở cùng dir (cùng filesystem để `rename` atomic), `chmod` theo mode, `renameSync` đè target canonical. Symlink ở `path` gốc vẫn trỏ đúng vì ta ghi vào canonical.
6. EACCES/EPERM/ENOSPC/EROFS → friendly error message kèm error code.

Trên Windows: `O_EXCL` không atomic như POSIX nhưng `renameSync` vẫn replace-on-rename qua `MoveFileExW`. Test path: macOS + Linux đủ; Windows ghi note "best-effort".

**B. Canonical-path mutation queue** (~15 LOC trong `runQueuedHashlineEdit`)

```ts
const sortedQueuePaths = [...new Set(queuePaths)]
  .map((p) => safeRealpath(p) ?? p)  // resolve symlink, fallback to literal
  .sort();
```

`safeRealpath` catch `ENOENT` (rename case — target chưa tồn tại) → fallback literal.

**C. `replace_text` op** (~80 LOC, mở rộng schema + executor)

```ts
type Edit =
  | { op: "replace"; pos: string; end?: string; lines?: ... }
  | { op: "append";  pos?: string; lines?: ... }
  | { op: "prepend"; pos?: string; lines?: ... }
  | { op: "replace_text"; oldText: string; newText: string };
```

Apply order: `replace_text` chạy **trước** anchored edits (vì nó dịch chuyển line numbers; anchored edits cần snapshot ổn định sau khi text-replace xong). Mỗi `replace_text`:

- Đếm exact occurrences. 0 → `[E_NO_MATCH]`. >1 → `[E_MULTI_MATCH]` (kèm n vị trí đầu để LLM disambiguate). =1 → replace.
- Sau khi tất cả `replace_text` áp xong, re-validate anchors của các edit còn lại trên snapshot mới (CID phải khớp). Nếu lệch → `[E_HASH_MISMATCH]` thông thường.
- Không cho mix `replace_text` cùng anchored edits **chạm cùng vùng** (overlap detection mở rộng).

**D. Updated anchors + diff preview trong response** (~150 LOC, new file `src/tools/hashline-edit/diff-preview.ts`)

Không cần LCS — input edits đã cho biết chính xác line ranges thay đổi:

```
File updated. 142 lines.

--- Updated anchors ---
 41#VR|export function foo(): void {
 42#KT|  console.log("new");
 43#BH|}

--- Diff preview ---
- 41#OLD|export function foo() {
- 42#OLD|  console.log("old");
+ 41#VR |export function foo(): void {
+ 42#KT |  console.log("new");
```

Algorithm:

1. Trước khi apply, snapshot `oldLines = [...fileLines]`.
2. Compute change set từ edits: union các ranges `(startLine, endLine, replacementLines)`.
3. Sau apply, recompute CID cho range tương ứng trong snapshot mới.
4. Render diff: cho mỗi changed range, in `-` cho old lines (CID = `OLD` placeholder để tránh confuse anchor parser), `+` cho new lines (CID thật từ post-snapshot).
5. Updated anchors block: chỉ in vùng đã thay đổi + 3 context lines mỗi phía.
6. Cap output: max 50 changed lines hiển thị; quá dài → truncate giữa với marker `[… N lines elided …]`.

**E. Error code taxonomy** (~30 LOC)

Chuẩn hoá error string format: `[CODE] human-readable message\n<context>`. Codes:

| Code | Meaning |
|---|---|
| `E_BAD_REF` | Anchor format sai (`/^\d+#[A-Z]{2}$/` không match) |
| `E_HASH_MISMATCH` | Line tồn tại nhưng CID không khớp (file đã đổi) |
| `E_OUT_OF_RANGE` | Anchor trỏ tới line vượt file length |
| `E_INVALID_PATCH` | `lines` chứa anchor prefix `\d+#[A-Z]{2}\|` hoặc diff marker `^[+-] ` |
| `E_OVERLAP` | Replace ranges overlap nhau |
| `E_NO_MATCH` | `replace_text` không tìm thấy `oldText` |
| `E_MULTI_MATCH` | `replace_text` tìm thấy > 1 match |
| `E_WRITE_FAILED` | Filesystem error (EACCES/EPERM/ENOSPC/EROFS) |
| `E_NOT_FOUND` | File không tồn tại lúc read |
| `E_VERIFY_FAILED` | `postEditVerify=true` và content sau write khác expected |

Tất cả compactible bởi [`compactHashlineError`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/index.ts#L125-L137) hiện tại (giữ).

**F. Strict patch rejection** (~25 LOC, thay [`stripLineIdPrefix`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/index.ts#L70-L80))

Thay vì silent strip:

```ts
function validateLines(lines: string[]): { ok: true } | { ok: false; offending: string[] } {
  const offending: string[] = [];
  for (const l of lines) {
    if (/^\d+#[A-Z]{2}\|/.test(l)) offending.push(l);
    else if (/^[+-] /.test(l) && !l.startsWith("+ \\")) offending.push(l); // diff marker heuristic
  }
  return offending.length ? { ok: false, offending } : { ok: true };
}
```

Config gate trong [`src/config/schema.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/config/schema.ts) (đã có block `hashline_edit`):

```ts
hashline_edit: z.object({
  strict_patch: z.boolean().default(true),       // mới — default reject
  // các field cũ giữ nguyên
}).default({}),
```

Khi `strict_patch=false` (legacy), giữ behavior strip. Doc bắn warning vào prompt guidelines: "Never include `LINE#ID|` prefix in lines payload."

**G. `postEditVerify` opt-in** (Phase 2, ~30 LOC)

Schema thêm `postEditVerify?: boolean` (top-level, default false). Sau khi `writeFileAtomically` xong, đọc lại canonical path, normalize CRLF/BOM theo cách giống pre-write reconstruction, `===` so với `result` string đã ghi. Lệch → rollback (restore từ snapshot pre-write nếu hardlink case, hoặc rename temp back), trả `[E_VERIFY_FAILED]`.

**H. Inline TUI diff trong expanded view** (Phase 2, ~150 LOC, new file `src/tools/hashline-edit/result-renderer.ts`)

Mở rộng `renderResult` (hiện dùng `buildStatsRenderResult` factory). Khi result success và `details.diffPreview` có giá trị:

- Collapsed: giữ nguyên (`✓ <message>`).
- Expanded (Ctrl+O): render diff block với gutter `▌+ ` / `▌- ` / `▌  ` (text-mode visible cho screen readers / plain transcripts), color qua `theme.fg("success", …)` / `theme.fg("error", …)`.

Reuse pattern từ [`src/sub-agents/render.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/sub-agents/render.ts) (đã có expanded/collapsed conditional). Không cần spinner / interval — static render.

**I. Edit variant aliases** (Phase 2, ~25 LOC schema-only)

Thêm op aliases để LLM nói rõ ý:

| Alias | Tương đương | Lý do |
|---|---|---|
| `insert_after` | `append` với `pos` required | Tên rõ hơn về vị trí tương đối |
| `insert_before` | `prepend` với `pos` required | Cùng lý do |
| `replace_range` | `replace` với `end` required | Tách single-line vs range |

Schema accept cả 6 op (3 cũ + 3 alias). Executor normalize về 3 op gốc. Backward-compat 100%.

### 3.2 Files changed (dự kiến)

| File | Phase | Status | LOC delta |
|---|---|---|---|
| [`src/tools/hashline-edit/index.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/index.ts) | 1 | modify | +150 / -40 |
| `src/tools/hashline-edit/fs-write.ts` | 1 | new | +120 |
| `src/tools/hashline-edit/diff-preview.ts` | 1 | new | +130 |
| `src/tools/hashline-edit/errors.ts` | 1 | new | +60 |
| [`src/config/schema.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/config/schema.ts) | 1 | modify | +5 |
| `src/tools/hashline-edit/__tests__/atomic-write.test.ts` | 1 | new | +200 |
| `src/tools/hashline-edit/__tests__/replace-text.test.ts` | 1 | new | +150 |
| `src/tools/hashline-edit/__tests__/diff-preview.test.ts` | 1 | new | +120 |
| `src/tools/hashline-edit/__tests__/errors.test.ts` | 1 | new | +80 |
| Existing [`src/tools/hashline-edit/__tests__/hashline-edit.test.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/__tests__/hashline-edit.test.ts) | 1 | modify | +50 (cover strict_patch, canonical queue) |
| `src/tools/hashline-edit/result-renderer.ts` | 2 | new | +150 |
| `src/tools/hashline-edit/post-verify.ts` | 2 | new | +50 |
| `src/tools/hashline-edit/__tests__/result-renderer.test.ts` | 2 | new | +120 |
| `src/tools/hashline-edit/__tests__/post-verify.test.ts` | 2 | new | +80 |
| [`AGENTS.md`](file:///Users/invoker/Work/personal/pi-blackbytes/AGENTS.md) | 1+2 | modify | +30 (settings doc) |
| [`CHANGELOG.md`](file:///Users/invoker/Work/personal/pi-blackbytes/CHANGELOG.md) | 1+2 | modify | +40 |

Total source: ~615 LOC (Phase 1) + ~200 LOC (Phase 2) = ~815 LOC. Tests: ~750 LOC. **Tổng ~1.565 LOC** spread across 16 files (đủ độ lớn để dùng `delegate_general` nếu chia chunks tốt, nhưng chia bead theo Phase + sub-tasks dưới đây sẽ cho 1 person/agent xử lý từng bead trong 0.5-1 ngày — đúng size cho bead workflow).

### 3.3 Refs

- Existing code: [`src/tools/hashline-edit/index.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/index.ts), [`src/tools/hashline-edit/read-renderer.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/read-renderer.ts), [`src/utils/cid.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/utils/cid.ts).
- Config schema: [`src/config/schema.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/config/schema.ts).
- Convention render expanded view: [`src/sub-agents/render.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/sub-agents/render.ts), [`src/tools/_shared/stats-render.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/_shared/stats-render.ts).
- Cross-project reference (đã clone về `/tmp/pi-hl/`):
  - `pi-hashline-edit/src/fs-write.ts` (atomic write reference) — ~76 LOC.
  - `pi-hashline-edit/src/hashline.ts` § `replace_text` (lines 280-548) — error codes + match logic.
  - `pi-hashline-readmap/prompts/edit.md` — variant naming convention (`set_line` / `replace_lines` / `insert_after`).
- Pi docs: `docs/extensions.md` (renderResult signature), `docs/tui.md` (expanded view contract).

---

## 4. Tasks (bead-ready breakdown)

Mỗi task được viết để 1 implementer (người hoặc `general` sub-agent) hoàn thành trong 0.5-1 ngày, có DoD rõ ràng, self-contained.

### Phase 1 — Correctness + UX core

#### T1 — Error code taxonomy + strict patch rejection (½ ngày)

**Files**: new `src/tools/hashline-edit/errors.ts`, modify `index.ts` + `src/config/schema.ts`, new test `__tests__/errors.test.ts`.

**Changes**:

- Export `ERROR_CODES` enum + `formatError(code, message, context?)` helper trong `errors.ts`.
- Refactor mọi error string trong `index.ts` thành `formatError(...)`. Áp dụng cho: `parseAnchor` fail, out-of-range, CID mismatch, range invalid, overlap, write fail, file not found.
- Thay `stripLineIdPrefix` bằng `validateLines` (reject mode). Add config flag `hashline_edit.strict_patch: boolean = true`.
- Update prompt `description` + `promptGuidelines` (warn về `LINE#ID|` prefix).
- Test: mỗi error code có ít nhất 1 case trigger; legacy mode (`strict_patch=false`) vẫn strip.

**DoD**: 8 error codes covered; `bun run test` xanh; `bun run lint` xanh.

---

#### T2 — Canonical-path mutation queue (¼ ngày)

**Files**: modify `index.ts` (function `runQueuedHashlineEdit`).

**Changes**:

- Add `safeRealpath(path: string): string` helper — `fs.realpathSync` với catch ENOENT.
- Trong `runQueuedHashlineEdit`, map queue paths qua `safeRealpath` trước khi `new Set` + sort.
- Test: tạo symlink `/tmp/link → /tmp/real`; chạy 2 concurrent edits qua `/tmp/link` và `/tmp/real` → assert serialized (no race).

**DoD**: regression test passing; existing tests không break.

---

#### T3 — Atomic write + alias preservation (1 ngày)

**Files**: new `src/tools/hashline-edit/fs-write.ts`, modify `index.ts`, new test `__tests__/atomic-write.test.ts`.

**Changes**:

- Implement `resolveWriteTarget(path)` + `writeFileAtomically(target, nlink, mode, content)` per spec § 3.1.A.
- Thay 2 chỗ `writeFileSync` trong `applyHashlineEdits` bằng async call qua `writeFileAtomically`.
- Rename path: ghi nội dung mới vào temp ở cùng directory với `rename` target, `renameSync` đè `rename` path, unlink `filePath` cũ. Preserve mode từ source.
- Permission error → `formatError("E_WRITE_FAILED", ...)`.

**Tests** (real filesystem trong `os.tmpdir()`):

1. Symlink: edit qua symlink → underlying file updated, symlink vẫn là symlink.
2. Hardlink: 2 hardlinks A & B chia inode; edit A → B cũng thấy nội dung mới (cùng inode preserved).
3. Mode: file mode `0o755` → sau edit vẫn `0o755`.
4. Interrupt: simulate temp-file leftover (tạo `.foo.tmp.x` cũ trong dir) → không gây conflict.
5. EACCES path: read-only dir → trả `E_WRITE_FAILED` với hint.

**DoD**: 5 tests pass trên macOS + Linux CI; existing tests xanh.

---

#### T4 — `replace_text` op (1 ngày)

**Files**: modify `index.ts` (schema + executor), new test `__tests__/replace-text.test.ts`.

**Changes**:

- Extend `EditSchema` union với `{ op: "replace_text", oldText: string, newText: string }`.
- Trong `applyHashlineEdits`: separate `textEdits` từ `anchoredEdits`. Apply `textEdits` trước (sequential, count occurrences sau mỗi step).
- Match algorithm: exact string match (no fuzzy in v1). 0 → `E_NO_MATCH`. >1 → `E_MULTI_MATCH` với preview 3 vị trí đầu (line numbers từ snapshot hiện tại). =1 → splice replacement.
- Sau text-edits, re-split lines + validate anchors còn lại (CID có thể đổi do shift line; trả `E_HASH_MISMATCH` kèm fresh anchors gần đúng vị trí).
- Overlap detection mở rộng: nếu `replace_text` match nằm trong range của một `replace` anchored edit → `E_OVERLAP`.

**Tests**:

1. Single match → applied.
2. Zero match → `E_NO_MATCH`.
3. Multi match → `E_MULTI_MATCH` với line numbers.
4. Mixed `replace_text` + anchored `replace` non-overlap → both apply, anchored CIDs validated sau shift.
5. Mixed overlap → `E_OVERLAP`.
6. `oldText` chứa newline (multi-line replacement) → applied đúng (splice multi-line).
7. `oldText` rỗng → `E_NO_MATCH` (defensive).

**DoD**: 7 tests pass; schema doc cập nhật trong tool `description`.

---

#### T5 — Diff preview + Updated anchors block (1 ngày)

**Files**: new `src/tools/hashline-edit/diff-preview.ts`, modify `index.ts` (response builder), new test `__tests__/diff-preview.test.ts`.

**Changes**:

- Track `oldLines` snapshot trước apply.
- Compute `changedRanges: Array<{ oldStart, oldEnd, newStart, newEnd }>` từ edits (deterministic, no LCS — sort edits bottom-up, transform line indices step-by-step).
- `renderUpdatedAnchors(newLines, ranges)`: cho mỗi range, in 3 lines context trước + range mới + 3 lines context sau với CID fresh.
- `renderDiffPreview(oldLines, newLines, ranges)`: per range, in `- LINE#OLD|<content>` cho old, `+ LINE#CID|<content>` cho new. CID placeholder `OLD` không match anchor regex (loại bỏ confusion).
- Cap: `MAX_DIFF_LINES = 50`. Overflow → middle-cut với `[… N lines elided …]`.
- Append vào success message: `<message>\n\n--- Updated anchors ---\n<anchors>\n\n--- Diff preview ---\n<diff>`.
- Thêm vào `details` (cho TUI Phase 2 consume): `details.diffData = { oldLines, newLines, ranges }` (chỉ slice các vùng changed + context để tránh giữ full file trong memory).

**Tests**:

1. Single-line replace → diff đúng 1 `-` + 1 `+`.
2. Range replace 5 lines → 1 với 3 lines mới → diff `-5 +3`.
3. Pure append → chỉ `+` lines, no `-`.
4. Pure delete (`lines: null` trên replace) → chỉ `-` lines.
5. Multiple non-overlapping edits → diff blocks separated by blank line.
6. Overflow >50 lines → middle-cut marker xuất hiện.
7. CID placeholder `OLD` không bị anchor parser parse (defensive).

**DoD**: 7 tests pass; output sample manual verify đẹp.

---

#### T6 — Phase 1 integration + AGENTS.md + CHANGELOG (½ ngày)

**Files**: modify `AGENTS.md`, `CHANGELOG.md`, prompts (nếu cần).

**Changes**:

- AGENTS.md "Core settings" section: thêm `hashline_edit.strict_patch` (bool, default true).
- CHANGELOG: Unreleased section, group Added/Changed/Fixed theo Keep-a-Changelog.
- Run `bun run lint && bun run build && bun run test && bun run check:size`. Bundle size phải < 500KB gzipped (current ~258KB → còn nhiều room).
- Manual smoke test: chạy `hashline_edit` qua live pi session, edit 1 file qua symlink + 1 edit dùng `replace_text` + 1 edit có diff preview output. Verify visually.

**DoD**: 4 commands xanh; size budget pass; manual smoke recorded.

---

### Phase 2 — UX nâng cao

#### T7 — `postEditVerify` opt-in flag (½ ngày)

**Files**: new `src/tools/hashline-edit/post-verify.ts`, modify `index.ts` (schema + executor), new test `__tests__/post-verify.test.ts`.

**Changes**:

- Schema thêm `postEditVerify?: boolean` top-level.
- Sau `writeFileAtomically`, nếu flag set: read canonical path, normalize CRLF/BOM giống reconstruction logic, `===` so với `result` string đã ghi.
- Mismatch → restore pre-write snapshot (cho hardlink case: ghi đè lại bằng `oldContent`; cho temp+rename case: best-effort restore từ in-memory `oldContent`), trả `E_VERIFY_FAILED` với first 200 chars diff context.
- Test: happy path + simulate verify fail (mock `readFileSync` trả nội dung khác).

**DoD**: 3 tests pass; flag default off, không impact existing tests.

---

#### T8 — Edit variant aliases (½ ngày)

**Files**: modify `index.ts` (schema + normalizer), update existing test.

**Changes**:

- `EditSchema` union accept op = `replace_range` / `insert_after` / `insert_before`.
- `normalizeEdit(edit)` helper map alias → canonical (`replace_range` → `replace` với `end` required, etc.).
- Validate `insert_after` / `insert_before` phải có `pos` (không silent fallback BOF/EOF như `append`/`prepend` không pos).
- Update prompt `description` liệt kê đủ 6 op (với note "aliases for clarity").

**DoD**: backward-compat tests pass; 3 alias tests mới pass.

---

#### T9 — Inline TUI diff trong expanded view (1 ngày)

**Files**: new `src/tools/hashline-edit/result-renderer.ts`, modify `index.ts` (renderResult), new test `__tests__/result-renderer.test.ts`.

**Changes**:

- Hiện tại `index.ts` dùng `buildStatsRenderResult({ partial: "Editing..." })` factory generic. Cần custom renderer cho hashline_edit để hiển thị diff.
- `renderHashlineEditResult(result, options, theme, context)`:
  - Collapsed: `✓ <summary>` (giống factory hiện tại).
  - Expanded: header `✓ <summary>` + blank line + diff block.
  - Diff block: per range render `▌- <content>` (red) / `▌+ <content>` (green) / `▌  <context>` (muted) — text marker visible even without color.
  - Width clamp qua `clampLinesToWidth` (helper từ `src/sub-agents/format.ts` nếu shareable, hoặc duplicate nhỏ trong renderer).
- Failure path: giữ behavior `buildHashlineErrorResult` hiện tại (compact error).

**Test theo bit pattern** (giống `render.test.ts` của sub-agents):

- Collapsed render: chứa `✓` + summary, không có diff.
- Expanded render: chứa `▌-` và `▌+` markers, có color tokens `error`/`success`.
- Width clamp: line >width bị truncate, không wrap.
- Empty diff (rename only) → expanded chỉ show summary, no diff section.

**DoD**: 4+ test cases pass; manual visual verify trong live pi session với 3 case (single-line edit, multi-line range, append-only).

---

#### T10 — Phase 2 wrap-up (¼ ngày)

**Files**: `AGENTS.md`, `CHANGELOG.md`.

- Doc `postEditVerify` flag (per-call, không phải config).
- Doc edit aliases trong AGENTS.md hoặc tool description.
- CHANGELOG entry cho Phase 2.
- `bun run lint && bun run build && bun run test && bun run check:size`.

**DoD**: như T6.

---

## 5. Verify

### Auto (CI)

- `bun run lint` xanh.
- `bun run build` xanh + `dist/index.js` exists.
- `bun run test` xanh, tổng tests +~30 cases mới (Phase 1) + ~15 (Phase 2).
- `bun run check:size` < 500KB gzipped.
- `bun run typecheck` xanh (`hashline_edit` schema mở rộng không break consumer).

### Manual (live pi session)

Sau Phase 1:

1. Edit qua symlink: `ln -s real.ts link.ts` → `hashline_edit({ filePath: "link.ts", … })` → verify `real.ts` updated, `link.ts` vẫn là symlink (`lstat`).
2. Edit file có hardlink: `ln a.ts b.ts` → edit `a.ts` → `b.ts` thấy thay đổi.
3. `replace_text` happy + multi-match (xem error message có rõ ràng cho LLM không).
4. Edit normal → check response có `--- Updated anchors ---` + `--- Diff preview ---`.
5. Dán nhầm `lines: ["10#VK|content"]` → assert `E_INVALID_PATCH` trả về với hint.
6. Đặt config `strict_patch=false` → legacy strip behavior vẫn work.
7. Force EACCES (`chmod -w dir`) → `E_WRITE_FAILED` friendly message.

Sau Phase 2:

8. `postEditVerify: true` happy path.
9. Edit + Ctrl+O → diff preview inline rendered đẹp, color đúng, text markers visible.
10. Aliases (`insert_after`, `replace_range`) → behavior identical với canonical ops.

### Cross-tool regression

- `read` tool vẫn render anchors qua [`read-renderer.ts`](file:///Users/invoker/Work/personal/pi-blackbytes/src/tools/hashline-edit/read-renderer.ts) (không đụng).
- Sub-agents (explore/oracle/general) vẫn delegate được, không có flag/schema mới ảnh hưởng nested CLI args.
- `/blackbytes-status` section "Hashline Edit" (nếu có) update reflect `strict_patch` config.

---

## 6. Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| `renameSync` không atomic cross-device (temp ở `/tmp`, target ở mount khác) | Medium | High | Temp **luôn** tạo trong cùng directory với target (`path.dirname(canonical)`), không phải `os.tmpdir()`. |
| Hardlink in-place write giữa interrupt → truncate | Low | Medium | `nlink > 1` case là edge; document risk. Long-term: `O_TMPFILE` + linkat trên Linux, defer. |
| `fs.realpathSync` throw trên file chưa tồn tại (rename target) | Medium | Low | `safeRealpath` catch ENOENT, fallback literal. |
| Diff preview kéo dài làm response over context budget | Medium | Medium | `MAX_DIFF_LINES=50` cap + middle-cut. Test edge case 1000-line edit. |
| `replace_text` semantic ambiguity khi `oldText` chứa CRLF nhưng file là LF (hoặc ngược lại) | Medium | Medium | Normalize cả file + oldText về LF trước match; document trong tool description. |
| Strict patch reject break model đã quen silent strip | Medium | Low | Config flag default true nhưng có escape (`strict_patch=false`); error message hint cách fix; ship đầu Phase 1 để collect feedback sớm. |
| Inline TUI diff render slow trên file lớn | Low | Low | Chỉ render slice trong `details.diffData` (đã cap), không full file. |
| `postEditVerify` rollback fail (write OK, verify fail, rollback fail) → file ở trạng thái không xác định | Low | High | Document rõ trong error message: "verify failed AND rollback failed — file may be partially corrupted, check manually". Don't pretend ổn. |
| Bundle size vượt 500KB | Low | Medium | `check:size` ở mỗi phase end. Current ~258KB; +~30KB cho Phase 1 source là conservative. |
| Test flakiness trên CI Windows | Medium | Low | Skip atomic-write tests trên Windows (`process.platform === 'win32'`) với TODO note. POSIX behavior là primary target. |

---

## 7. Rollout

- **Phase 1** ship như một release minor (`0.x.0`). CHANGELOG mark **BREAKING** cho `strict_patch=true` default (model nào đó đang gửi prefix-laden lines sẽ fail). Workaround đơn giản: set `strict_patch=false`.
- **Phase 2** ship như release patch sau khi Phase 1 ổn ≥3 ngày.
- **Phase 3** spike spec riêng (`hashline-edit-symbol-ops.md`?), không trong scope này.

Không cần feature flag runtime — config flag `strict_patch` đã đủ là escape hatch cho phase 1 BREAKING change.

---

## 8. Done check

Phase 1:
- [x] T1-T6 đều ship.
- [x] `bun run lint && bun run build && bun run test && bun run check:size` xanh.
- [ ] Manual verify 7 case Phase 1. _(deferred to release smoke; automated coverage = 52 new tests across the 5 modules)_
- [x] CHANGELOG + AGENTS.md updated.
- [x] Spec này update status từ "Draft" → "Phase 1 Done".

Phase 2:
- [x] T7-T10 đều ship.
- [ ] Verify 3 case Phase 2 manual. _(deferred to release smoke; automated coverage = 22 new tests in post-verify + result-renderer + alias suites)_
- [x] CHANGELOG + AGENTS.md updated.
- [x] Spec này update status → "Done".

---

## 9. Implementation notes (post-mortem)

(Section điền sau khi ship, theo pattern [`subagent-ui-polish.md`](file:///Users/invoker/Work/personal/pi-blackbytes/docs/specs/subagent-ui-polish.md#L132).)

### Architecture choices that survived

- **Strict patch default `true` + escape hatch** — `{ strict_patch: false }` left the door open for legacy callers without compromising the default. Schema as `union(boolean, object)` preserved both shapes; `getHashlineEditConfig()` normalises at consumption sites.
- **No LCS for diff preview** — prefix/suffix trim is deterministic, O(N+M), and adequate for v1. Multiple disjoint edits collapse into one coarse range — acceptable trade-off documented for future refinement.
- **Removed-line format omits `#`** (`- <ln>| ...` instead of `- <ln>#<CID>| ...`) so it cannot match the strict-patch regex even when copied verbatim into a follow-up `lines` payload. This invariant is asserted as a dedicated test in `diff-preview.test.ts`.
- **Strict-patch regex matches shape, not CID alphabet** (`/^\d+#[A-Z]{2}\|/`). A line starting `99#OL|...` is rejected even though `OL` is outside the canonical 16-char CID alphabet — model mistakes don't always pick valid alphabet letters.
- **Atomic write branching on `nlink`** — in-place `O_TRUNC` for hard-linked files (preserves inode) vs temp+rename for `nlink == 1` (atomic on POSIX). Trade-off: in-place truncate is not atomic against process kill; documented in spec § Risks.
- **Canonical-path queue via `safeRealpath`** — also reused by `resolveWriteTarget` so symlink resolution rules live in one place.
- **`postEditVerify` as opt-in per-call flag** (Phase 2) — default off; doubles syscall cost when enabled but lets cautious callers gate critical writes without forcing the cost on the happy path.
- **Op aliases via top-of-executor normalisation** (Phase 2) — `normalizeEdit()` runs once before any other partition / validation logic so the rest of the executor only sees canonical ops (`replace` / `append` / `prepend` / `replace_text`). Cheaper than threading alias awareness through every code path.
- **Renderer-owned `clampToWidth` helper** (Phase 2) — 10 lines of local code rather than restructuring `src/sub-agents/format.ts` to export `clampLinesToWidth`. The helper is intentionally ANSI-unaware in v1.

### Architecture choices that got rolled back

- **Restructuring `hashline_edit` config to a pure object form** — considered making the config field `{ enabled, strict_patch }` only, but kept the `boolean` shorthand to avoid breaking every existing settings.json and test fixture. The union approach (boolean OR object) preserves both shapes losslessly.
- **Per-edit fine-grained ranges in diff preview** — considered tracking each applied edit's (oldRange, newRange) at apply time and emitting one range per edit. Punted to a future enhancement; the simpler snapshot-based prefix/suffix trim ships first.
- **Diff-marker heuristic for strict patch** — considered also rejecting lines that begin with `/^[+-] /`, but the false-positive rate on legitimate Markdown bullets / prose was too high. Only the `LINE#ID|` prefix shape is rejected.

### Bugs caught by test gate during implementation

- `applyHashlineEdits` initially iterated `edits` (the full input array) in the inverted-range, overlap, and partition loops AFTER the text-edit partition was introduced. This caused `replace_text` ops to be re-validated as anchored. Switched to `otherEdits` for the post-partition loops. Caught by the `replace-text.test.ts` mixed-overlap case before any runtime regression.
- Initial `formatError` swallowed empty-string context, producing `[CODE] msg\n` with a dangling newline; tightened to treat empty context as no context.
- Long-line `validateLines.preview` overflowed terminal width; capped at 117 chars + ellipsis (118 total), asserted explicitly.
- (Phase 2) `node:test`'s `mock.method` cannot redefine ESM-imported `node:fs` exports (`Cannot redefine property: readFileSync`). Refactored `verifyPersistedContent` and `applyHashlineEdits` to accept injectable hooks (`__verifyReadFn`, `__rollbackWriteFn`) for tests instead of relying on monkey-patching the namespace. The bead's polish note that `mock.method` was sufficient on Node ≥20.6 turned out to be wrong for ESM.
- (Phase 2) Initial post-verify rollback path tried to re-restore CRLF by replacing `\n` with `\r\n` on `rawContent`, but `rawContent` already retained its original CRLF (CRLF normalisation happens on the separate `normalized` variable). The double-conversion would have corrupted the rollback. Fixed to write `rawContent` back unchanged, only re-prepending the BOM when present.
- (Phase 2) `Text` from pi-tui has no useful `toString()`; my first renderer test extracted via `String(text)` and got `[object Object]`. Switched to `text.render(width)` matching the pattern in `src/sub-agents/__tests__/render.test.ts`.
- (Phase 2) Partial `Text` output is space-padded to the requested width, so an exact-equality assertion on `«muted:Editing...»` failed. Tightened the assertion to `startsWith` to tolerate the padding.

### Files changed

Phase 1 (T1-T6):

- `src/tools/hashline-edit/errors.ts` (new) — 10 error codes, `formatError`, `validateLines`.
- `src/tools/hashline-edit/fs-write.ts` (new) — `resolveWriteTarget`, `writeFileAtomically`.
- `src/tools/hashline-edit/diff-preview.ts` (new) — `computeChangedRanges`, `renderUpdatedAnchors`, `renderDiffPreview`, `renderEditPreview`.
- `src/tools/hashline-edit/index.ts` — refactored all error sites to use `formatError`; added `safeRealpath`, canonical-path queue, atomic write integration, `replace_text` partition + apply, success diff preview, schema and tool description updates, `strictPatch` option threading.
- `src/config/schema.ts` — `hashline_edit` union shape + `getHashlineEditConfig()` helper.
- `src/handlers/index.ts` — normalise via helper + thread `strictPatch` at registration.
- `src/tools/hashline-edit/__tests__/errors.test.ts` (new, 15 cases)
- `src/tools/hashline-edit/__tests__/canonical-queue.test.ts` (new, 5 cases)
- `src/tools/hashline-edit/__tests__/atomic-write.test.ts` (new, 9 cases)
- `src/tools/hashline-edit/__tests__/replace-text.test.ts` (new, 8 cases)
- `src/tools/hashline-edit/__tests__/diff-preview.test.ts` (new, 12 cases)
- `src/tools/hashline-edit/__tests__/hashline-edit.test.ts` — 3 cases updated/added.
- `AGENTS.md` — documented `hashline_edit.strict_patch`.
- `CHANGELOG.md` — Unreleased section for Phase 1.

Verification snapshot at end of Phase 1: 707 tests passing, lint/typecheck/build green, bundle 140 KB gzipped (well under the 500 KB budget).

Phase 2 (T7-T10):

- `src/tools/hashline-edit/post-verify.ts` (new) — `verifyPersistedContent` + injectable `readFn` seam, diff-context builder with line/column locator.
- `src/tools/hashline-edit/result-renderer.ts` (new) — `renderHashlineEditResult` with partial/collapsed/expanded paths, inline `▌-`/`▌+` diff with width clamping, local `clampToWidth` helper.
- `src/tools/hashline-edit/index.ts` — added `postEditVerify` schema field; verify branch after write with rollback path; `normalizeEdit` for the 3 alias ops (`insert_after` / `insert_before` / `replace_range`); 3 new op literals in `EditSchema`; tool description updated for aliases; `renderResult` swapped to the new renderer; internal `__verifyReadFn` / `__rollbackWriteFn` test hooks on `ApplyHashlineEditsOptions`.
- `src/tools/hashline-edit/__tests__/post-verify.test.ts` (new, 7 cases) — 3 pure-function + 4 integration covering happy / flag-absent / mismatch+rollback-restores / mismatch+rollback-fails.
- `src/tools/hashline-edit/__tests__/result-renderer.test.ts` (new, 10 cases) — collapsed success/error, partial, expanded diff with `▌-`/`▌+` colour-token assertions, expanded fallback for empty `diffData`, expanded error path, `clampToWidth` unit tests. Uses the stub-theme pattern from `src/sub-agents/__tests__/render.test.ts` and `Text.render(width)` extraction.
- `src/tools/hashline-edit/__tests__/hashline-edit.test.ts` — 6 new alias tests appended (3 happy + 3 missing-anchor).

Final verification snapshot (Phase 1 + 2): 729 tests passing (+22 since Phase 1 close), lint/typecheck/build/size green, bundle 145 KB gzipped (29% of the 500 KB budget).(TBD — update bảng § 3.2 với actual delta sau khi ship.)
