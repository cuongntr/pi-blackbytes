# Delegation Monitor — Switchable Side Panel Spec

> **Status**: Draft  
> **Date**: 2025-05-25  
> **Goal**: Xem chi tiết sub-agent đang chạy trong view riêng, switch qua lại với chat chính

---

## 1. Problem

Hiện tại, delegation progress hiển thị **inline trong chat flow** qua `renderResult`. Khi sub-agent chạy:

- **Collapsed** (default): `✓ explore · 3.2s · 5 calls · $0.004` — quá ít thông tin
- **Expanded** (Ctrl+O): tool timeline + output — **chiếm chỗ trong chat**, cuộn lên khi có nội dung mới

Không có cách nào xem chi tiết real-time mà không làm rối chat chính.

## 2. Solution

Một **overlay side panel** toggle bằng hotkey, hiển thị live delegation activity bên cạnh (hoặc thay thế tạm) chat chính.

### UX Flow

```
Chat chính (normal)                     Side panel (Ctrl+Shift+D)
┌────────────────────────────┐          ┌────────────────────────────────┐
│ User: explore the auth...  │          │ ╭─ Delegation Monitor ────────╮│
│                            │          │ │                             ││
│ 🔭 delegate_explore        │    ⇄     │ │ 🔭 explore (running 4.2s)   ││
│ ✓ explore · 3.2s · $0.004 │  toggle  │ │ model: claude-sonnet-4-5    ││
│                            │          │ │ tools: 5 calls              ││
│ Found the auth module...   │          │ │                             ││
│                            │          │ │ ▸ read src/auth/login.ts    ││
│                            │          │ │   0.8s · 2.1KB              ││
│                            │          │ │ ✓ grep "passport" src/      ││
│                            │          │ │   0.3s · 15 matches         ││
│                            │          │ │ ✓ read src/auth/middleware  ││
│                            │          │ │   0.4s · 1.5KB              ││
│                            │          │ │ ▸ read src/auth/oauth.ts    ││
│                            │          │ │   (running...)              ││
│                            │          │ │                             ││
│                            │          │ │ ── Output Preview ──        ││
│                            │          │ │ The auth module uses...     ││
│                            │          │ │                             ││
│                            │          │ │ ↑input: 12.3k  ↓out: 2.1k  ││
│                            │          │ │ cost: $0.0042  ctx: 45k     ││
│                            │          │ ╰─────────────────────────────╯│
│                            │          │                                │
│                            │          │ ── History ──                  │
│                            │          │ ✓ oracle · 12.4s · $0.012     │
│                            │          │ ✓ explore · 3.2s · $0.004     │
│                            │          │                                │
│                            │          │ Total: 3 delegations · $0.020  │
│                            │          │                                │
│                            │          │ [esc] close  [↑↓] scroll       │
│                            │          └────────────────────────────────┘
└────────────────────────────┘
```

### Key behaviors

1. **Hotkey toggle**: `Ctrl+Shift+D` opens/closes the panel (configurable)
2. **Non-blocking**: Panel is a passive overlay — chat vẫn hoạt động bình thường
3. **Live updates**: Panel cập nhật real-time khi delegation đang chạy
4. **History**: Hiển thị tất cả delegations trong session hiện tại
5. **Auto-show** (optional): Tự mở khi delegation bắt đầu, tự đóng khi xong
6. **Scrollable**: ↑↓ scroll khi nội dung vượt quá panel height
7. **Compact chat**: Khi panel mở, chat inline rendering giữ compact (không expand)

## 3. Architecture

### 3.1 Component Stack

```
┌───────────────────────────────────────────────────┐
│                  Pi Host                          │
│                                                   │
│  registerShortcut("ctrl+shift+d")                 │
│       │                                           │
│       ▼                                           │
│  ┌─────────────────────┐   ┌───────────────────┐  │
│  │ DelegationMonitor   │   │ MonitorState       │  │
│  │ (Overlay Component) │◄──│ (Session-scoped)   │  │
│  │                     │   │                    │  │
│  │ • ActiveSection     │   │ • activeDelegation │  │
│  │ • HistorySection    │   │ • history[]        │  │
│  │ • FooterSection     │   │ • scrollOffset     │  │
│  └─────────────────────┘   │ • isVisible        │  │
│                            └────────┬────────────┘  │
│                                     │              │
│  Events that feed the state:        │              │
│  ┌──────────────────────────────────┘              │
│  │                                                 │
│  │  tool_execution_start  ──► if delegate_* tool   │
│  │  tool_execution_update ──► progress details     │
│  │  tool_execution_end    ──► move to history      │
│  │                                                 │
└───────────────────────────────────────────────────┘
```

### 3.2 Data Flow

Không cần thay đổi executor hay progress reporter. Sử dụng **Pi event hooks hiện có**:

```ts
// Capture delegation events from Pi's tool execution lifecycle
pi.on("tool_execution_start", async (event) => {
  if (event.toolName.startsWith("delegate_")) {
    monitorState.startDelegation(event.toolCallId, event.toolName, event.args);
    refreshPanel();
  }
});

pi.on("tool_execution_update", async (event) => {
  if (event.toolName.startsWith("delegate_")) {
    // event.partialResult contains the SubAgentRenderDetails
    monitorState.updateDelegation(event.toolCallId, event.partialResult);
    refreshPanel();
  }
});

pi.on("tool_execution_end", async (event) => {
  if (event.toolName.startsWith("delegate_")) {
    monitorState.finishDelegation(event.toolCallId, event.result);
    refreshPanel();
  }
});
```

**Quan trọng**: Tận dụng `SubAgentRenderDetails` đã có trong `event.partialResult.details` — chứa đầy đủ `toolHistory`, `currentTool`, `usage`, `outputPreview`, `model`, `elapsedMs`. Không cần thay đổi bất kỳ code sub-agent nào.

### 3.3 Monitor State

```ts
interface MonitorState {
  // Active delegation (only one at a time in current design)
  activeDelegation: ActiveDelegation | null;

  // Session history (completed delegations)
  history: CompletedDelegation[];

  // UI state
  isVisible: boolean;
  scrollOffset: number;
  selectedHistoryIndex: number; // -1 = active, 0+ = history item
}

interface ActiveDelegation {
  toolCallId: string;
  agent: string;              // "explore", "oracle", etc.
  startedAt: number;
  lastDetails: SubAgentRenderDetails | null;
}

interface CompletedDelegation {
  agent: string;
  startedAt: number;
  endedAt: number;
  success: boolean;
  details: SubAgentRenderDetails;
}
```

### 3.4 Panel Component

```ts
class DelegationMonitorPanel implements Component {
  private state: MonitorState;
  private cachedLines: string[] | undefined;
  private cachedWidth: number | undefined;

  render(width: number): string[] {
    // Header: "╭─ Delegation Monitor ─╮"
    // Active section (nếu có delegation đang chạy)
    // History section (scrollable list)
    // Footer: keybindings help
  }

  handleInput(data: string): void {
    // ↑↓: scroll
    // Enter: expand/collapse history item
    // Esc: close panel
    // 1-5: jump to specific history item
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }
}
```

### 3.5 Active Section Render

```
🔭 explore (running 4.2s)
  model: claude-sonnet-4-5
  tools: 5 calls

  ▸ read src/auth/login.ts        0.8s
  ✓ grep "passport" src/          0.3s · 15 matches
  ✓ read src/auth/middleware.ts    0.4s
  ▸ read src/auth/oauth.ts        (running...)

  ── Output Preview ──
  The auth module uses passport.js for...
  [truncated at 500 chars]

  ↑12.3k  ↓2.1k  $0.0042  ctx:45k
```

### 3.6 History Item Render

```
── History (3 delegations · $0.020) ──

  ✓ oracle  · 12.4s · 8 calls · $0.012   ← selected (Enter to expand)
  ✓ explore · 3.2s  · 5 calls · $0.004
  ✗ general · 45.2s · 12 calls · $0.004  [timed_out]
```

Expanded history item:

```
  ✓ oracle · 12.4s · model: claude-sonnet-4-5
    ──────────
    ✓ read src/config/schema.ts             0.3s
    ✓ read src/handlers/index.ts            0.5s
    ✓ ast_search "defineSubAgent" ts        0.8s
    ✓ read src/sub-agents/register.ts       0.4s
    ✓ read src/sub-agents/render.ts         0.3s
    ✓ read src/sub-agents/progress-...      0.4s
    ✓ read src/sub-agents/delegation-...    0.2s
    ✓ glob **/*.test.ts                     0.1s
    ──────────
    Output: The sub-agent management flow in...
    [1,234 chars · 8 tools · ↑45k ↓12k · $0.012]
```

## 4. Implementation Plan

### 4.1 New Files

| File | Purpose | ~LOC |
|------|---------|------|
| `src/monitor/state.ts` | `MonitorState` class + `ActiveDelegation`/`CompletedDelegation` types | ~60 |
| `src/monitor/panel.ts` | `DelegationMonitorPanel` component (render + input) | ~200 |
| `src/monitor/index.ts` | Registration: shortcut + event hooks + overlay management | ~80 |

**Total: ~340 LOC**, 3 files. Không thay đổi code hiện có.

### 4.2 Registration (in session_start)

```ts
// src/monitor/index.ts
export function registerDelegationMonitor(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const state = new MonitorState();

  // 1. Capture delegation lifecycle via existing Pi events
  pi.on("tool_execution_start", async (event) => {
    if (!event.toolName.startsWith("delegate_")) return;
    state.startDelegation(event.toolCallId, event.toolName, event.args);
    refreshOverlay();
  });

  pi.on("tool_execution_update", async (event) => {
    if (!event.toolName.startsWith("delegate_")) return;
    state.updateDelegation(event.toolCallId, event.partialResult?.details);
    refreshOverlay();
  });

  pi.on("tool_execution_end", async (event) => {
    if (!event.toolName.startsWith("delegate_")) return;
    state.finishDelegation(event.toolCallId, event.result?.details);
    refreshOverlay();
  });

  // 2. Register toggle shortcut
  let overlayHandle: OverlayHandle | null = null;

  pi.registerShortcut("ctrl+shift+d", {
    description: "Toggle Delegation Monitor",
    handler: async () => {
      if (overlayHandle) {
        overlayHandle.hide();
        overlayHandle = null;
        state.isVisible = false;
      } else {
        showOverlay();
      }
    },
  });

  // 3. Auto-show on delegation start (if configured)
  function refreshOverlay() {
    if (overlayHandle) {
      overlayHandle.requestRender?.();
    } else if (config.autoShow && state.activeDelegation) {
      showOverlay();
    }
  }

  function showOverlay() {
    state.isVisible = true;
    ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        const panel = new DelegationMonitorPanel(state, theme, tui, () => {
          done(undefined);
          overlayHandle = null;
          state.isVisible = false;
        });
        return panel;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: "45%",
          minWidth: 50,
          maxHeight: "90%",
          margin: { top: 1, right: 1, bottom: 1 },
          visible: (termWidth) => termWidth >= 100, // auto-hide on narrow terminals
        },
        onHandle: (handle) => { overlayHandle = handle; },
      },
    );
  }
}
```

### 4.3 Widget Indicator (compact always-visible hint)

Khi panel đóng nhưng có delegation đang chạy, hiển thị widget nhỏ:

```ts
// Below editor widget showing active delegation status
ctx.ui.setWidget("delegation-indicator", (_tui, theme) => {
  if (!state.activeDelegation) return { render: () => [], invalidate: () => {} };

  const d = state.activeDelegation;
  const elapsed = ((Date.now() - d.startedAt) / 1000).toFixed(1);
  const line = theme.fg("accent", `🔭 ${d.agent}`) +
    theme.fg("muted", ` · ${elapsed}s`) +
    theme.fg("dim", ` · Ctrl+Shift+D to monitor`);

  return {
    render: () => [line],
    invalidate: () => {},
  };
}, { placement: "belowEditor" });
```

## 5. Config

```jsonc
{
  "blackbytes": {
    "delegation_monitor": {
      "enabled": true,            // enable/disable feature
      "shortcut": "ctrl+shift+d", // customizable hotkey
      "auto_show": false,         // auto-open on delegation start
      "auto_hide": true,          // auto-close when all delegations complete
      "min_terminal_width": 100,  // hide on narrow terminals
      "panel_width": "45%",       // panel width
      "max_history": 20           // max completed delegations to keep
    }
  }
}
```

## 6. Key Design Decisions

### 6.1 Tại sao Overlay thay vì Full-screen custom UI?

- **Non-blocking**: Chat vẫn hoạt động, user vẫn đọc được output
- **Side-by-side**: Xem delegation detail bên cạnh chat context
- **Toggle nhanh**: Ctrl+Shift+D mở/đóng tức thì, không mất context
- **Responsive**: Tự ẩn trên terminal hẹp

### 6.2 Tại sao dùng Pi events thay vì sửa executor?

- **Zero coupling**: Không sửa bất kỳ file sub-agent nào (`register.ts`, `render.ts`, `progress-reporter.ts`)
- **Additive only**: Chỉ thêm files mới, register event handlers
- **Data đã có**: `tool_execution_update` mang `partialResult` chứa đầy đủ `SubAgentRenderDetails` — tool history, usage, output preview, model, elapsed
- **Dễ disable**: Nếu user không muốn, `enabled: false` → không register gì cả

### 6.3 Tại sao không thay đổi inline rendering?

Inline rendering (`renderResult`) vẫn hữu ích cho:
- Terminal hẹp không đủ chỗ cho side panel
- Xem lại kết quả delegation trong scroll history
- Users không muốn panel

Monitor là **bổ sung**, không phải thay thế.

## 7. Files Changed

| Action | File | Change |
|--------|------|--------|
| **NEW** | `src/monitor/state.ts` | MonitorState class |
| **NEW** | `src/monitor/panel.ts` | DelegationMonitorPanel component |
| **NEW** | `src/monitor/index.ts` | Registration, event hooks, overlay management |
| **MODIFY** | `src/handlers/index.ts` | Call `registerDelegationMonitor()` in `handleSessionStart()` |
| **MODIFY** | `src/config/schema.ts` | Add `delegation_monitor` config section |

**5 files total** (3 new, 2 minor modifications).  
**~340 LOC new code**. No existing code modified beyond wiring.

## 8. Verification

- [ ] Panel opens/closes with Ctrl+Shift+D
- [ ] Active delegation shows live tool timeline
- [ ] Tool history scrolls with ↑↓
- [ ] Panel auto-hides on terminal width < 100
- [ ] Completed delegations move to history section
- [ ] Widget indicator shows below editor when panel is closed but delegation is active
- [ ] Config `enabled: false` disables entire feature
- [ ] No changes to existing sub-agent behavior
- [ ] All existing tests pass
- [ ] Package size budget maintained

## 9. Future Extensions (out of scope now)

- **Detail drill-down**: Enter on history item → full-screen detail view
- **Output streaming**: Show real-time text output (not just preview) in panel
- **Multi-delegation**: Track parallel delegations (when Pi supports it)
- **Export**: Copy delegation log to clipboard
- **Filter**: Filter history by agent name
- **Cost chart**: Visual cost breakdown across session

---

## Appendix: Pi TUI APIs Used

| API | Purpose |
|-----|---------|
| `ctx.ui.custom({ overlay: true })` | Side panel overlay |
| `overlayOptions.anchor: "right-center"` | Right-side positioning |
| `overlayOptions.visible: (w) => w >= 100` | Responsive visibility |
| `onHandle: (handle) => ...` | Programmatic visibility control |
| `pi.registerShortcut()` | Toggle hotkey |
| `ctx.ui.setWidget()` | Compact indicator below editor |
| `pi.on("tool_execution_start/update/end")` | Capture delegation events |
| `matchesKey()`, `Key.*` | Keyboard navigation in panel |
| `truncateToWidth()` | Safe ANSI-aware truncation |
| `Container`, `Text`, `Spacer` | Panel composition |
