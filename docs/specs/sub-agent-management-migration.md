# Sub-Agent Management Migration Spec

> **Status**: Draft  
> **Date**: 2025-05-25  
> **Author**: Auto-generated from ecosystem research  

---

## 1. Motivation

Hệ thống sub-agent hiện tại của pi-blackbytes hoạt động nhưng có các pain points rõ ràng:

### 1.1 Pain Points hiện tại

| Vấn đề | Mô tả | Ảnh hưởng |
|--------|-------|-----------|
| **Monolithic registration** | `registerSubAgent()` (~270 LOC) vừa build prompt, finalize tools, spawn process, track progress, log delegation — tất cả trong 1 function | Khó test, khó extend, khó debug |
| **Tight coupling render ↔ execution** | Progress reporter được tạo bên trong execute callback; render component bind trực tiếp với details shape | Không thể swap render strategy mà không sửa executor |
| **setInterval polling cho elapsed timer** | `setInterval(invalidate, 1000)` trong render — brute-force, 1 timer per active delegation | Resource waste, flicker khi nhiều agents chạy song song |
| **No delegation lifecycle hooks** | Không có trước-khi-spawn, sau-khi-hoàn-thành hooks cho external observers | `/blackbytes-status` phải poll in-memory log thay vì reactive |
| **Flat delegation log** | `DelegationEntry[]` module-level mutable array, no structure beyond agent name | Không trace được parent↔child relationships nếu sau này cho phép depth > 1 |
| **YAML loader tightly coupled** | `loadYamlDeclarations()` validates + transforms + diagnoses trong 1 pass | Khó extend schema, khó add new YAML features |
| **Status command là text dump** | `/blackbytes-status` render text string, không interactive, không drill-down vào specific agent | UX kém cho monitoring |

### 1.2 Ecosystem benchmark

Nghiên cứu đã thực hiện trên các framework:

| Framework | Delegation Model | Rendering | Unique Strength |
|-----------|-----------------|-----------|-----------------|
| **Crush** (ex-OpenCode) | Không có sub-agent; MCP tools only | Bubble Tea atomic messages | Simplicity, zero overhead |
| **Claude Code** | `Task` tool → child process | Spinner + task name → final result | Clean UX, cost transparency |
| **Roo Code** | `new_task` + `switch_mode` + `skill` | Conversation-level events | Mode system = declarative persona routing |
| **Cline** | `new_task` boomerang | New conversation in WebView | Human-mediated delegation |
| **pi-blackbytes** | `defineSubAgent` → nested `pi -p` JSONL | Live-updating component + tool timeline | Most capable nhưng most complex |

**Key takeaway**: pi-blackbytes đã có infrastructure mạnh nhất (YAML agents, fallback chain, tool timeline, cost tracking). Vấn đề không phải thiếu features mà là **architecture coupling** và **UX presentation**.

---

## 2. Design Goals

1. **Separation of Concerns**: Tách registration, execution, rendering, và observability thành independent layers
2. **Pluggable Rendering**: Cho phép swap render strategy (compact/detailed/silent) mà không sửa executor
3. **Reactive Observability**: Event-driven delegation lifecycle thay vì poll-based
4. **Simpler Mental Model**: Mỗi layer có single responsibility rõ ràng
5. **Backward Compatible**: YAML agents, config schema, tool names không đổi

---

## 3. Proposed Architecture

### 3.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Pi Host (registerTool)                │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │ Declaration  │   │  Render      │   │ Lifecycle    │ │
│  │ Registry     │   │  Adapter     │   │ Emitter      │ │
│  │              │   │              │   │              │ │
│  │ • builtin    │   │ • compact    │   │ • onStart    │ │
│  │ • yaml       │   │ • detailed   │   │ • onProgress │ │
│  │ • validate   │   │ • silent     │   │ • onFinish   │ │
│  │ • snapshot   │   │ • custom     │   │ • onError    │ │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘ │
│         │                  │                  │         │
│  ┌──────▼──────────────────▼──────────────────▼───────┐ │
│  │                   Executor                         │ │
│  │                                                    │ │
│  │  • prompt assembly                                 │ │
│  │  • tool finalization                               │ │
│  │  • spawn (runNestedPi)                             │ │
│  │  • fallback chain                                  │ │
│  │  • abort handling                                  │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │              Delegation Store                      │ │
│  │                                                    │ │
│  │  • structured log (tree, not flat list)            │ │
│  │  • reactive subscribers                            │ │
│  │  • session-scoped lifecycle                        │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Module Breakdown

#### A. Declaration Registry (`src/sub-agents/registry.ts`) — NEW

Replaces scattered imports in `handleSessionStart()`.

```ts
interface SubAgentRegistry {
  register(decl: SubAgentDeclaration): void;
  registerFromYaml(dir: string): YamlDiagnostics;
  get(name: string): SubAgentDeclaration | undefined;
  getAll(): ReadonlyMap<string, SubAgentDeclaration>;
  getEnabled(): SubAgentDeclaration[];
  isEnabled(name: string): boolean;
}
```

**Migration**: Move builtin declarations from `handleSessionStart()` into `registry.register()` calls. YAML loading stays in `loader.ts` but flows through the same registry.

#### B. Executor (`src/sub-agents/executor.ts`) — REFACTORED from register.ts

Single responsibility: given a declaration + params, produce a result.

```ts
interface ExecutorOptions {
  declaration: SubAgentDeclaration;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  cwd?: string;
  spawnFn?: SpawnFn;
}

interface ExecutionResult {
  content: string;
  success: boolean;
  details: ExecutionDetails;
  attemptedModels: AttemptInfo[];
}

interface ExecutionDetails {
  agent: string;
  durationMs: number;
  outputChars: number;
  toolCallCount: number;
  toolHistory: ToolHistoryEntry[];
  usage?: UsageInfo;
  model?: string;
}

async function executeSubAgent(opts: ExecutorOptions): Promise<ExecutionResult>;
```

**Key change**: Executor does NOT know about rendering. It emits structured events through a `LifecycleEmitter` and returns a pure data result.

#### C. Lifecycle Emitter (`src/sub-agents/lifecycle.ts`) — NEW

Event-driven delegation lifecycle, replacing the tight coupling between executor and render.

```ts
type DelegationEvent =
  | { type: "delegation:start"; agent: string; model?: string; timestamp: number }
  | { type: "delegation:progress"; agent: string; details: ExecutionDetails }
  | { type: "delegation:tool_start"; agent: string; tool: string; summary?: string }
  | { type: "delegation:tool_end"; agent: string; tool: string; durationMs: number }
  | { type: "delegation:finish"; agent: string; result: ExecutionResult }
  | { type: "delegation:error"; agent: string; error: string };

interface LifecycleEmitter {
  on(handler: (event: DelegationEvent) => void): () => void;  // returns unsubscribe
  emit(event: DelegationEvent): void;
}

function createLifecycleEmitter(): LifecycleEmitter;

// Session-scoped singleton
function getSessionLifecycle(): LifecycleEmitter;
```

**Consumers**:
- Render adapter subscribes to lifecycle events → updates UI
- Delegation store subscribes → persists entries
- `/blackbytes-status` subscribes → live view (future)

#### D. Render Adapter (`src/sub-agents/render-adapter.ts`) — REFACTORED from render.ts

Decoupled from executor. Subscribes to lifecycle events.

```ts
type RenderStrategy = "compact" | "detailed" | "silent";

interface RenderAdapterOptions {
  strategy: RenderStrategy;
  theme: Theme;
}

// Factory that produces Pi-compatible renderResult function
function createSubAgentRenderer(
  agent: string,
  lifecycle: LifecycleEmitter,
  options: RenderAdapterOptions,
): PiRenderResultFn;
```

**Render strategies**:

| Strategy | Behavior | When |
|----------|----------|------|
| `compact` | Single-line: `✓ explore · 3.2s · 5 calls · $0.004` | Default |
| `detailed` | Current behavior: header + expandable tool timeline | Opt-in via config |
| `silent` | No render output, logging only | CI/automation |

**Timer improvement**: Replace `setInterval(invalidate, 1000)` with lifecycle event-driven updates. The emitter already fires on every tool start/end and progress tick — no need for a separate timer.

#### E. Delegation Store (`src/sub-agents/delegation-store.ts`) — REPLACES delegation-log.ts

Structured, reactive, tree-capable.

```ts
interface DelegationRecord {
  readonly id: string;           // unique per delegation
  readonly agent: string;
  readonly parentId?: string;    // for future depth > 1
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs: number;
  readonly success: boolean;
  readonly failureKind?: string;
  readonly toolCallCount: number;
  readonly outputChars: number;
  readonly cost?: number;
  readonly model?: string;
  readonly attemptedModels: string[];
  readonly toolHistory: readonly ToolHistoryEntry[];
}

interface DelegationStore {
  // Write
  record(entry: Omit<DelegationRecord, "id">): string;  // returns id

  // Read
  getAll(): readonly DelegationRecord[];
  getByAgent(agent: string): readonly DelegationRecord[];
  getById(id: string): DelegationRecord | undefined;

  // Reactive
  subscribe(handler: (records: readonly DelegationRecord[]) => void): () => void;

  // Aggregation
  getSummary(): DelegationSummary;
  getAgentStats(agent: string): AgentStats;

  // Lifecycle
  reset(): void;
}

interface DelegationSummary {
  total: number;
  byAgent: Map<string, AgentStats>;
  totalCost: number;
  totalDurationMs: number;
}

interface AgentStats {
  count: number;
  successes: number;
  failures: number;
  avgDurationMs: number;
  totalCost: number;
  lastRun?: number;
}
```

#### F. Registration Bridge (`src/sub-agents/bridge.ts`) — REPLACES registerSubAgent() in register.ts

Thin wiring layer that connects all pieces and registers with Pi host.

```ts
function bridgeSubAgent(
  pi: ExtensionAPI,
  declaration: SubAgentDeclaration,
  lifecycle: LifecycleEmitter,
  store: DelegationStore,
  options?: { spawnFn?: SpawnFn; renderStrategy?: RenderStrategy },
): void;
```

**What it does (each ~10-20 LOC)**:
1. Check enabled set → skip if disabled
2. Create render adapter from lifecycle + strategy
3. Call `pi.registerTool()` with declaration metadata + render adapter
4. Wire execute callback → `executeSubAgent()` → lifecycle events → store recording

Total: ~60 LOC vs current ~270 LOC in `registerSubAgent()`.

---

## 4. File Changes Summary

### New Files

| File | Purpose | ~LOC |
|------|---------|------|
| `src/sub-agents/registry.ts` | Centralized declaration registry | ~80 |
| `src/sub-agents/executor.ts` | Pure execution logic (extracted from register.ts) | ~120 |
| `src/sub-agents/lifecycle.ts` | Event emitter for delegation lifecycle | ~50 |
| `src/sub-agents/render-adapter.ts` | Strategy-based renderer subscribing to lifecycle | ~100 |
| `src/sub-agents/delegation-store.ts` | Structured delegation store (replaces delegation-log) | ~90 |
| `src/sub-agents/bridge.ts` | Thin wiring between all layers | ~60 |

### Modified Files

| File | Change |
|------|--------|
| `src/sub-agents/register.ts` | Deprecate `registerSubAgent()`, re-export from bridge |
| `src/sub-agents/render.ts` | Keep `SubAgentResultComponent` + `rebuildSubAgentResultComponent` for backward compat; new renderers import from here |
| `src/sub-agents/delegation-log.ts` | Deprecate, delegate to store internally |
| `src/sub-agents/progress-reporter.ts` | Refactor to emit lifecycle events instead of calling onUpdate directly |
| `src/handlers/index.ts` | Use registry + bridge instead of manual registerSubAgent calls |
| `src/commands/blackbytes-status.ts` | Use DelegationStore.getSummary() instead of getDelegationSummary() |

### Deleted Files (after migration complete)

None initially — deprecation first, removal in follow-up.

---

## 5. Migration Plan

### Phase 1: Foundation (no behavior change)

1. Create `lifecycle.ts` — pure event emitter, no consumers yet
2. Create `delegation-store.ts` — implements `DelegationStore`, internally uses same array pattern but with `subscribe()`
3. Create `registry.ts` — wraps existing declaration loading
4. **Wire**: Make existing `delegation-log.ts` delegate to store
5. **Test**: All existing tests pass unchanged

### Phase 2: Extract Executor

1. Extract prompt assembly + tool finalization + spawn logic from `registerSubAgent()` into `executor.ts`
2. Executor emits lifecycle events
3. `registerSubAgent()` becomes a thin wrapper calling executor
4. **Test**: Integration tests pass, rendering unchanged

### Phase 3: Render Adapter

1. Create `render-adapter.ts` with `compact` strategy matching current behavior
2. Remove `setInterval` timer — lifecycle events drive updates
3. Add `detailed` and `silent` strategies
4. Add `sub_agents.render_strategy` config option (default: `"compact"`)
5. **Test**: Visual parity with current render

### Phase 4: Bridge & Cleanup

1. Create `bridge.ts` wiring all layers
2. Update `handleSessionStart()` to use registry + bridge
3. Deprecate `registerSubAgent()` (keep as re-export for any external consumers)
4. Update `/blackbytes-status` to use store's reactive API
5. **Test**: Full e2e, all tests green

### Phase 5: Enhanced UX (optional follow-up)

1. Add `detailed` render strategy with per-tool cost breakdown
2. Add live `/delegation-status` command with reactive store subscription
3. Add delegation tree visualization for future depth > 1
4. Add configurable render strategies per agent via `sub_agents.<name>.render`

---

## 6. Config Changes

```jsonc
// ~/.pi/agent/settings.json
{
  "blackbytes": {
    "sub_agents": {
      // Existing (unchanged)
      "explore": {
        "model": "claude-sonnet-4-5",
        "reasoningEffort": "medium",
        "timeoutMs": 600000,
        "fallbackModels": ["gpt-4o"]
      },

      // New: per-agent render strategy
      "explore": {
        "render": "compact"           // "compact" | "detailed" | "silent"
      },

      // New: global default
      "_defaults": {
        "render": "compact"           // default for all agents
      }
    }
  }
}
```

---

## 7. Inspiration Credits

| Pattern | Source | How we adapt it |
|---------|--------|-----------------|
| Atomic tool messages | Crush/Bubble Tea | Lifecycle events are atomic, renderer decides how to compose |
| Spinner + task name → final result | Claude Code | `compact` strategy does exactly this |
| Mode system | Roo Code | Registry `getEnabled()` already acts as a mode filter |
| Cost transparency post-run | Claude Code | DelegationStore.getSummary() surfaces per-agent cost |
| MCP-style tool extensibility | Crush | YAML agents are already our version of this |
| Boomerang pattern | Cline | Future: `parentId` in DelegationRecord enables tracing |

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Breaking existing YAML agent configs | Low | High | Registry validates same schema; bridge is transparent |
| Render regression | Medium | Medium | Phase 3 starts with visual parity test |
| Performance overhead from event emitter | Low | Low | Synchronous emit, no async; <1ms per event |
| Increased file count | Certain | Low | Each file is <120 LOC; total code roughly same |
| External consumers of `registerSubAgent()` | Unknown | Medium | Keep deprecated re-export |

---

## 9. Success Criteria

- [ ] All existing tests pass without modification
- [ ] `registerSubAgent()` is <10 LOC (bridge wrapper)
- [ ] Render strategy is configurable per agent
- [ ] No `setInterval` in render path
- [ ] DelegationStore supports `subscribe()` for reactive consumers
- [ ] `/blackbytes-status` delegation section uses store API
- [ ] Lint, typecheck, build, test all pass
- [ ] Package size budget (<500KB gzipped) maintained

---

## 10. Non-Goals (explicitly out of scope)

- **Depth > 1 recursion**: Store supports `parentId` but executor still enforces depth=1
- **Parallel sub-agent dispatch**: Pi controls parallelism; this spec doesn't change that
- **`append` prompt mode**: Still reserved/throws; not addressed here
- **Browser tool / LSP integration**: Orthogonal features
- **Extension marketplace**: Out of scope

---

## Appendix A: Current vs Proposed LOC Comparison

| Module | Current LOC | Proposed LOC | Δ |
|--------|------------|-------------|---|
| register.ts (registerSubAgent) | ~270 | ~10 (re-export) | -260 |
| executor.ts | 0 (new) | ~120 | +120 |
| lifecycle.ts | 0 (new) | ~50 | +50 |
| render-adapter.ts | 0 (new) | ~100 | +100 |
| delegation-store.ts | 0 (new) | ~90 | +90 |
| bridge.ts | 0 (new) | ~60 | +60 |
| registry.ts | 0 (new) | ~80 | +80 |
| render.ts | ~200 | ~150 (keep components) | -50 |
| progress-reporter.ts | ~310 | ~200 (emit lifecycle) | -110 |
| delegation-log.ts | ~60 | ~10 (delegate to store) | -50 |
| **Total** | **~840** | **~870** | **+30** |

Code volume roughly equal — complexity is redistributed, not added.
