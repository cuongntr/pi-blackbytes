# Implementation Plan: Align General Delegation with oc-blackbytes

**Variant**: Lightweight  
**Effort**: < 1 day  
**Goal**: Increase General subagent call frequency by aligning delegation philosophy, thresholds, and promotion with oc-blackbytes.

## Changes

### 1. Overlay delegation philosophy (`src/system-prompt/bytes/overlay.ts`)

In `buildConditionalWorkflowsBody()`:

- **Replace** `"Default: work directly. Delegate only when..."` → `"Default to delegating when a task matches a subagent's specialty — don't do everything yourself."`
- **Replace** one-liner routing matrix with rich per-agent descriptions (General gets 5-6 bullets)
- **Add** delegation workflow (6 numbered steps)
- **Add** proactive delegation triggers section: `"delegate WITHOUT hesitation when:"`
- **Soften** cost signal: keep cost awareness but remove "do it yourself" discouragement

### 2. General declaration (`src/sub-agents/general.ts`)

- **Soften tool description**: Remove "Only when ALL hold" gating. Change to oc-style: `"Implementation executor agent. Handles heavy multi-file implementations, cross-layer refactors, mass migrations, and boilerplate generation. Full write access — operates as a fire-and-forget executor for well-defined tasks."`
- **Lower threshold**: `5+ file edits` → `3+ files` in routing metadata
- **Add triggers**: "Scaffolding new modules", "Repetitive changes across many files"
- **Soften Plan-Sanity Check**: Replace "return early with rejection" → "do your best with reasonable defaults" for non-critical missing info. Keep sanity check for truly missing context but frame it as a fallback, not first-pass filter.
- **Update routing.keyTrigger**: Align with new description

### 3. Routing matrix (`src/sub-agents/routing.ts`)

- **No changes needed** — the overlay will now build its own rich delegation section directly instead of relying solely on `buildOverlayRoutingMatrix()`. The existing function can remain for `/blackbytes-status` and other consumers.

### 4. Test updates

- **`src/system-prompt/__tests__/bytes-overlay.test.ts`**: Update assertion from `"Default: work directly"` to `"Default to delegating"`. Update negative assertions accordingly.
- **`src/sub-agents/__tests__/delegates.test.ts`**: Update regex assertions for `generalDeclaration.description` to match new wording (remove `/file paths \+ intended changes/` and `/5–10×/` patterns, add new patterns matching oc-style description).
- **`src/sub-agents/__tests__/routing.test.ts`**: Verify existing tests still pass (likely no changes needed since routing.ts itself isn't changing).

## File list

| # | File | Action |
|---|------|--------|
| 1 | `src/system-prompt/bytes/overlay.ts` | Modify |
| 2 | `src/sub-agents/general.ts` | Modify |
| 3 | `src/system-prompt/__tests__/bytes-overlay.test.ts` | Modify |
| 4 | `src/sub-agents/__tests__/delegates.test.ts` | Modify |

## Verification

```bash
bun run lint
bun run build
bun run test
```

## Out of scope

- Changes to other subagents (explore, oracle, librarian, reviewer)
- Changes to `routing.ts` or `resource-metadata.ts`
- Changes to general-safety-overlay.ts
