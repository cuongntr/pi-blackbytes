# Sub-Agent Mechanism Hardening — Phase 2 Implementation Plan

> **Status**: Active
> **Spec**: `docs/specs/subagent-mechanism-hardening.md`
> **Phase 1 status**: Complete (REQ-001, REQ-002, REQ-003 shipped)
> **Date**: 2026-06-08
> **Supersession (2026-08-03)**: The builtin Reviewer was later removed and its difficult-review contract merged into Oracle. See the current [`README`](../../README.md) and [`CHANGELOG`](../../CHANGELOG.md). Historical examples below describe the original phase.

## Scope

Phase 2 implements REQ-004 (redacted artifact capture) and REQ-005 (lightweight sequential chain), plus the Phase 2 portion of REQ-006 (tests and compatibility).

Phase 1 (lifecycle classification, status diagnostics, prompt contracts) is already shipped and tested.

---

## REQ-004 — Redacted Artifact Capture

### Context

When a sub-agent produces output larger than `MAX_RETURN_CHARS` (24,576 chars), `boundReturnContent()` truncates the middle, losing detail. Artifact capture persists the full redacted output to disk so the parent can read it later if needed.

### Design Decisions

- **Opt-in per delegation**: artifact capture defaults to off. A new optional `captureArtifacts?: boolean` flag on `RunNestedPiOptions` enables it. The `registerSubAgent` handler passes this through from a new config key `sub_agents.<name>.artifactCapture` (boolean, default `false`).
- **Location**: `$PI_AGENT_DIR/blackbytes/artifacts/sub-agents/<YYYY-MM-DD>/<agent>-<HHmmss>.md`. Falls back to `~/.pi/agent/blackbytes/artifacts/...` when `PI_AGENT_DIR` is unset.
- **Timing**: capture runs after `redactSecrets()` and before `boundReturnContent()` discards middle content. The captured file gets the full redacted text; the returned `content` remains bounded as today.
- **Metadata header**: YAML front-matter block with agent name, startedAt, duration, model, failureKind (if any), redaction note, and original size.
- **Limits**: single artifact capped at 512 KB. Outputs under 1 KB (after redaction) are not persisted. Directory retention is best-effort: a `cleanupArtifacts()` helper removes files older than 7 days, called lazily on session start (not on every capture).
- **DelegationEntry**: add optional `artifactPath?: string` field.

### Files

| File | Change |
|------|--------|
| `src/sub-agents/artifacts.ts` | **New**. `captureArtifact()`, `resolveArtifactDir()`, `buildMetadataHeader()`, `cleanupArtifacts()`, constants (`MAX_ARTIFACT_BYTES`, `MIN_ARTIFACT_CHARS`, `RETENTION_DAYS`). |
| `src/sub-agents/types.ts` | Add `captureArtifacts?: boolean` to `RunNestedPiOptions`. |
| `src/sub-agents/runner.ts` | After redaction, before bounding: if `captureArtifacts`, call `captureArtifact()` and attach `artifactPath` to result. |
| `src/sub-agents/delegation-log.ts` | Add `artifactPath?: string` to `DelegationEntry`. Thread through `recordDelegation()`. |
| `src/sub-agents/register.ts` | Pass `captureArtifacts` from config snapshot to runner options. |
| `src/config/schema.ts` | Add `artifactCapture?: boolean` to per-agent config (default `false`). |
| `src/sub-agents/__tests__/artifacts.test.ts` | **New**. Tests: cap enforcement, min-size skip, safe path construction, redaction in file, metadata header, cleanup of old files, fallback dir when PI_AGENT_DIR unset. |
| `src/sub-agents/__tests__/runner.test.ts` | Add tests for artifact path threading when capture is enabled/disabled. |

### Acceptance

- Large redacted outputs are saved as artifacts when `captureArtifacts` is true.
- Small outputs are not persisted.
- Artifact files contain redacted content with metadata header.
- `DelegationEntry` carries `artifactPath` when applicable.
- `/blackbytes-status` Sub-Agent Diagnostics shows artifact count/path summary (additive to existing section).
- No change to bounded `content` in `DelegateResult`.
- Config defaults to off; enabling per-agent works.

---

## REQ-005 — Lightweight Sequential Chain

### Design Decisions

- **Internal-only in Phase 2**: no new public `delegate_chain` tool. The chain executor is an internal module callable from the parent agent's handler logic or future tool registration. Q-001 (public tool vs internal) deferred to Phase 3 evaluation.
- **Reuses existing infrastructure**: each step resolves through `computeEnabledSet`, composes prompts via the existing `registerSubAgent` path, and runs through `executeWithFallback`/`runNestedPi`. No new spawn mechanism.
- **Previous output propagation**: each step's `task` is prefixed with `## Previous step output\n\n<prior step content>\n\n---\n\n` when a prior step exists.
- **Total timeout budget**: a single `totalTimeoutMs` is split across remaining steps. Each step gets `min(step.timeoutMs ?? defaultForAgent, remainingBudget)`. If the budget is exhausted, remaining steps are skipped with `timed_out`.
- **Stop on first failure**: default behavior. A `continueOnFailure?: boolean` option allows running through all steps (useful for explore-then-review patterns where a weak explore shouldn't block the reviewer).
- **Delegate tool blocking**: chain steps reuse the same `validateToolNames` / `finalizeNestedTools` path, so `delegate_*` tools never leak into chain step sessions.
- **No fanout, no async, no YAML chain DSL, no inter-agent chat**.

### Types

```ts
interface ChainStep {
  agent: string; // must match a registered, enabled agent name
  task: string;
  context?: string;
  timeoutMs?: number; // per-step override
}

interface ChainOptions {
  steps: ChainStep[];
  totalTimeoutMs: number;
  continueOnFailure?: boolean; // default false
  captureArtifacts?: boolean; // passed through to each step
}

interface ChainStepResult {
  agent: string;
  success: boolean;
  content: string; // bounded summary
  artifactPath?: string;
  durationMs: number;
  failureKind?: DelegateFailureKind;
}

interface ChainResult {
  success: boolean; // all steps succeeded
  steps: ChainStepResult[];
  totalDurationMs: number;
  stoppedEarly: boolean; // true if stopped on failure or timeout
}
```

### Files

| File | Change |
|------|--------|
| `src/sub-agents/chain.ts` | **New**. `executeChain()` — sequential step executor. `composeStepInput()` — previous output propagation. `allocateStepTimeout()` — budget splitting. |
| `src/sub-agents/chain.test.ts` | **New**. Tests: sequential execution order, previous-output propagation, stop-on-failure, continue-on-failure, disabled agent rejection, total timeout budget exhaustion, per-step timeout, artifact path threading, empty chain rejection, single-step chain. |
| `src/sub-agents/types.ts` | Export `ChainStep`, `ChainOptions`, `ChainStepResult`, `ChainResult`. |
| `src/sub-agents/index.ts` | Re-export chain types and `executeChain`. |

### Acceptance

- Chain runs 2–5 steps sequentially using existing delegate infrastructure.
- Previous step output is passed to the next step under a clear heading.
- Total timeout budget is enforced; remaining steps are skipped on exhaustion.
- First failure stops the chain by default; `continueOnFailure` overrides.
- Disabled/unknown agents are rejected before execution starts.
- `delegate_*` tools never leak into chain step sessions.
- Per-step summaries and artifact paths are returned.
- No dynamic fanout, background mode, YAML chain DSL, or inter-agent communication.

---

## REQ-006 — Documentation, Tests, and Compatibility (Phase 2)

### Files

| File | Change |
|------|--------|
| `AGENTS.md` | Document artifact capture config, chain module existence, and limitations. |
| `README.md` | Add artifact capture and chain to feature summary (brief). |

### Tests

All new modules have dedicated test files. Existing delegate tests must continue to pass unchanged. Final verification: `bun run check`.

### Compatibility

- Existing delegate tool names, schemas, and output semantics unchanged.
- Artifact capture is opt-in (config default `false`).
- Chain is internal-only; no new public tool surface.
- YAML agents need no new fields.

---

## Implementation Order

1. `src/sub-agents/types.ts` — add `captureArtifacts` to `RunNestedPiOptions`, export chain types
2. `src/sub-agents/artifacts.ts` — new module
3. `src/sub-agents/artifacts.test.ts` — tests
4. `src/sub-agents/runner.ts` — integrate artifact capture
5. `src/sub-agents/delegation-log.ts` — add `artifactPath` field
6. `src/sub-agents/register.ts` — thread config through
7. `src/config/schema.ts` — add `artifactCapture` setting
8. `src/sub-agents/__tests__/runner.test.ts` — artifact integration tests
9. `src/commands/blackbytes-status.ts` — artifact count in diagnostics
10. `src/sub-agents/chain.ts` — new module
11. `src/sub-agents/chain.test.ts` — tests
12. `src/sub-agents/index.ts` — re-export
13. `AGENTS.md` + `README.md` — documentation
14. `bun run check` — final verification

---

## Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-06-08 | Bytes | Created Phase 2 implementation plan from spec §6 Phase 2 |
