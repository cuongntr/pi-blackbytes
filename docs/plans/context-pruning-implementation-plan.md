# Dynamic Context Pruning — Implementation Plan

| Field | Value |
|---|---|
| Status | Deferred — evidence gate |
| Owner | invoker |
| Source Spec | [`../specs/context-pruning.md`](../specs/context-pruning.md) |
| Related ADRs | None present in this repo |
| Phase | Superseded runtime Phase 1 |

---

> **Do not implement this plan.** The evidence-first PRD superseded this solution-led runtime plan
> before activation. Its bead graph is deferred under the `evidence:required` label and is retained
> only for traceability. A new Evidence Spike plan may be created after the revised PRD is accepted.
> All `OLD-REQ-*` IDs and the former runtime phase below belong to the superseded draft; they do not
> correspond to the current PRD's `REQ-*` IDs or its Phase 1 Evidence Spike.

## 1. MVP-Lock

In the superseded runtime phase (formerly "Phase 1 MVP"):

- OLD-REQ-001: context event hook + provenance mapping
- OLD-REQ-002: model-driven `compress` tool
- OLD-REQ-003: context transformation (pruning)
- OLD-REQ-004: state persistence via tool-result details
- OLD-REQ-005: guardrails (net-saving, recent-turn protection, caps, no historical auth, sub-agent exclusion)
- OLD-REQ-006: compaction interoperability
- OLD-REQ-009: configuration schema
- OLD-REQ-010: tests and compatibility verification

Out of this phase:

- OLD-REQ-007: context usage nudge (former Phase 2)
- OLD-REQ-008: status commands and `/blackbytes-status` section (former Phase 2)
- Nested DAG compression (Phase 3)
- Automatic dedup/error purge (Phase 3)
- Message-level compression (Phase 3)
- Separate summarizer model (Phase 3)

Exit criteria:

- Shadow mode produces correct provenance maps with zero false-positive turn assignments in synthetic tests.
- `compress` tool validates, persists, and returns correct results.
- Context transformation correctly replaces compressed ranges with summary messages.
- All guardrails reject invalid operations.
- Pi compaction retires pre-compaction blocks without errors.
- Config schema parses correctly with defaults and rejects invalid values.
- `bun run check` passes.
- Existing delegate tools, sub-agents, and config surfaces remain backward compatible.

Scope changes after this plan is promoted to Active require a delta-change doc.

## 2. Work Item Hierarchy

### Epic E-1: Core infrastructure and config

#### Task T-1: Config schema and feature gating

- **T-001 — Add `context_pruning` section to BlackbytesConfigSchema**
  - **What + why**: Extend the Zod schema in `src/config/schema.ts` with the new `context_pruning` object and all its fields with defaults. Export the typed config interface. Add `contextPruning` to `PromptFeatureFlags` in `src/config/resource-metadata.ts` so the Bytes overlay can conditionally mention the feature.
  - **Related files**: `src/config/schema.ts`, `src/config/resource-metadata.ts`, `src/config/__tests__/schema.test.ts`.
  - **Acceptance criteria**: schema parses empty `context_pruning: {}` with all defaults applied; rejects invalid field types and out-of-range values; `PromptFeatureFlags` includes `contextPruning`; existing schema tests still pass.
  - **Definition of Done**: schema tests pass; typecheck passes.

- **T-002 — Create context-pruning module scaffold and registration**
  - **What + why**: Create `src/context-pruning/` directory with `index.ts` exporting a `registerContextPruning(pi, config)` function. Wire it into `handleSessionStart()` in `src/handlers/index.ts`, gated on `config.context_pruning?.enabled`. Register the `context` event hook, `session_compact` event hook, and the `compress` tool. Add `context_pruning` to `EnabledSet` or a parallel runtime flag.
  - **Related files**: new `src/context-pruning/index.ts`, `src/context-pruning/config.ts`, `src/handlers/index.ts`, `src/bootstrap.ts`.
  - **Acceptance criteria**: when `context_pruning.enabled = false`, no hooks or tools are registered; when `true`, the `context` hook, `session_compact` hook, and `compress` tool are registered; `bun run check` passes.
  - **Definition of Done**: integration test proves registration gating; existing session-start tests still pass.

### Epic E-2: Provenance mapping

#### Task T-2: Build context manifest from session entries and messages

- **T-003 — Implement `buildContextManifest()`**
  - **What + why**: Given `ctx.sessionManager.getBranch()` and the incoming `AgentMessage[]`, produce a `ContextManifest` mapping each message to its originating `SessionEntry.id` and grouping messages into complete turns. Use conservative alignment: match by unique `(role, timestamp, toolCallId)` first, then structural digest, then order-preserving LCS for ambiguous cases. Messages that cannot be confidently mapped are left unowned.
  - **Related files**: new `src/context-pruning/provenance.ts`, `src/context-pruning/__tests__/provenance.test.ts`.
  - **Acceptance criteria**: correctly maps a simple linear session; handles inserted messages (unowned); handles deleted messages (gap in mapping); handles reordered messages (ambiguous → unowned); produces stable refs (`m_<entryId>`) for user-turn boundaries; never assigns a ref to assistant or tool messages.
  - **Definition of Done**: provenance tests cover normal, insert, delete, reorder, duplicate, and empty scenarios.

- **T-004 — Implement source digest computation**
  - **What + why**: Compute a stable content digest for each turn to detect when the model's view of a range has changed since a compression was created. The digest must be deterministic and based on the canonical message content (text, tool names, tool inputs/outputs, but not transient IDs or timestamps).
  - **Related files**: `src/context-pruning/provenance.ts` (add `computeSourceDigest()`), `src/context-pruning/__tests__/provenance.test.ts`.
  - **Acceptance criteria**: same turn content → same digest; different content → different digest; digest is stable across repeated context hook invocations; digest ignores message IDs, timestamps, and other transient fields.
  - **Definition of Done**: digest tests cover stability, uniqueness, and field exclusion.

- **T-005 — Implement context reference injection**
  - **What + why**: Inject `[context-ref: m_<entryId>]` markers into user messages at turn boundaries. The marker is a dedicated text block prepended to the user message content, not appended to existing text. Only inject when the feature is enabled and not in shadow mode (or inject in shadow mode but mark as invisible/comment).
  - **Related files**: `src/context-pruning/provenance.ts` (add `injectContextRefs()`), `src/context-pruning/__tests__/provenance.test.ts`.
  - **Acceptance criteria**: each user message that starts a complete turn receives exactly one ref marker; assistant and tool messages are never modified; ref markers are deterministic; shadow mode does not inject visible markers.
  - **Definition of Done**: injection tests cover normal, shadow-mode, and edge cases (empty messages, messages with only tool calls).

### Epic E-3: Compression state

#### Task T-3: State persistence and reconstruction

- **T-006 — Implement `CompressionState` reducer**
  - **What + why**: Define the `CompressionBlock` type and a pure reducer that takes a list of `compress` tool-result details from the current branch and produces the set of active compression blocks. Blocks are active unless deactivated by user or superseded by a later block on the same range. Corrupt or malformed details are skipped individually.
  - **Related files**: new `src/context-pruning/state.ts`, `src/context-pruning/__tests__/state.test.ts`.
  - **Acceptance criteria**: reducer correctly activates blocks from valid details; skips blocks with missing required fields; skips blocks with invalid digest format; handles multiple blocks on disjoint ranges; handles user-deactivated blocks; produces deterministic output for the same input.
  - **Definition of Done**: state tests cover normal, malformed, deactivated, overlapping, and empty scenarios.

- **T-007 — Implement state reconstruction from session branch**
  - **What + why**: On each `context` hook invocation (and on `session_start`), scan `ctx.sessionManager.getBranch()` for `compress` tool results, extract their `details`, and reduce into active blocks. Cache the result keyed by `(leafId, lastModified)` to avoid repeated scanning.
  - **Related files**: `src/context-pruning/state.ts` (add `rebuildState()`), `src/context-pruning/__tests__/state.test.ts`.
  - **Acceptance criteria**: state is correctly rebuilt from a branch with compress tool results; state is empty for a branch with no compress results; cache is invalidated when leaf changes; fork/tree navigation naturally excludes blocks from other branches.
  - **Definition of Done**: reconstruction tests cover normal, empty, branch-switch, and cache-invalidation scenarios.

### Epic E-4: Context transformation

#### Task T-4: Apply compression blocks to messages

- **T-008 — Implement `applyBlocks()` pure transformer**
  - **What + why**: Given a `ContextManifest`, a set of active `CompressionBlock`s, and the incoming `AgentMessage[]`, produce a new `AgentMessage[]` with compressed ranges replaced by synthetic historical-summary messages. The function is pure: no side effects, no I/O. On any mismatch (digest mismatch, missing refs, overlapping blocks), skip the problematic block and keep original messages for that range.
  - **Related files**: new `src/context-pruning/transform.ts`, `src/context-pruning/__tests__/transform.test.ts`.
  - **Acceptance criteria**: correctly removes messages in a compressed range and inserts a single summary message; summary message is wrapped with historical-context markers; multiple disjoint blocks are all applied; blocks with digest mismatch are skipped (messages kept); blocks with refs not in manifest are skipped; output is deterministic.
  - **Definition of Done**: transform tests cover single block, multiple blocks, digest mismatch, missing ref, empty range, and full-session compression scenarios.

- **T-009 — Implement synthetic summary message factory**
  - **What + why**: Create the synthetic message that replaces compressed raw messages. It must be a user-role message (so it appears as context to the model) with clear markers that the content is historical and does not constitute current authorization.
  - **Related files**: `src/context-pruning/transform.ts` (add `createSummaryMessage()`), `src/context-pruning/__tests__/transform.test.ts`.
  - **Acceptance criteria**: message has role `"user"`; content includes a clear historical-context prefix; content includes the block summary; content includes the block ID for traceability; message does not include any DCP-specific XML tags or metadata.
  - **Definition of Done**: summary message tests verify structure, markers, and absence of XML/metadata.

### Epic E-5: Compress tool

#### Task T-5: Model-driven compression tool

- **T-010 — Implement `compress` tool definition and execute handler**
  - **What + why**: Register a `compress` tool with Pi using `pi.registerTool()`. The tool accepts `topic` and `ranges[]` (each with `startRef`, `endRef`, `summary`). On execute: validate all ranges against the current manifest, check guardrails, compute net saving, persist compression state in `details`, and return a human-readable result.
  - **Related files**: new `src/context-pruning/compress-tool.ts`, `src/context-pruning/__tests__/compress-tool.test.ts`.
  - **Acceptance criteria**: tool validates that all refs exist in the current manifest; rejects ranges that are not complete turns; rejects ranges that overlap active blocks; rejects ranges that include protected recent turns; rejects when net saving is insufficient; on success, returns a summary message and stores block metadata in `details`; tool runs with `executionMode: "sequential"`.
  - **Definition of Done**: tool tests cover valid single range, valid batch, invalid ref, partial turn, overlap, recent-turn protection, insufficient saving, and stale/replayed call scenarios.

- **T-011 — Implement guardrails module**
  - **What + why**: Extract all validation logic into a pure `src/context-pruning/guardrails.ts` module: `validateRanges()`, `checkNetSaving()`, `checkRecentTurns()`, `checkActiveBlockCap()`, `checkSummaryCap()`, `checkRangeCap()`. Each function takes data and config, returns `{ ok: true } | { ok: false, reason: string }`.
  - **Related files**: new `src/context-pruning/guardrails.ts`, `src/context-pruning/__tests__/guardrails.test.ts`.
  - **Acceptance criteria**: each guardrail correctly passes valid input and rejects invalid input with a descriptive reason; net-saving uses `max(minSavingTokens, minSavingRatio * sourceTokens)`; recent-turn protection excludes the last N turns and the current turn; caps are enforced at the configured limits.
  - **Definition of Done**: guardrail tests cover all check functions with boundary values.

### Epic E-6: Compaction interop

#### Task T-6: React to Pi compaction

- **T-012 — Implement compaction epoch and block retirement**
  - **What + why**: On `session_compact`, record the compaction timestamp as an epoch. All compression blocks with `createdAt` before this epoch are retired (ignored during state reconstruction). This prevents double-summary and orphaned references.
  - **Related files**: `src/context-pruning/index.ts` (add `session_compact` handler), `src/context-pruning/state.ts` (add `retireAllBlocks()`), `src/context-pruning/__tests__/integration.test.ts`.
  - **Acceptance criteria**: after `session_compact`, blocks created before the compaction are not applied; blocks created after the compaction are still applied; the compaction summary and DCP summaries do not overlap on the same range; manifest cache is invalidated.
  - **Definition of Done**: integration tests cover compaction with active blocks, compaction with no blocks, and multiple compactions.

### Epic E-7: Integration, tests, and verification

#### Task T-7: Wire everything together

- **T-013 — Implement `context` event hook integration**
  - **What + why**: Wire the full pipeline in the `context` event handler: build manifest → rebuild state → verify digests → apply blocks → inject refs. Handle errors gracefully (fail-open). Respect shadow mode (build manifest and log metrics but don't modify messages).
  - **Related files**: `src/context-pruning/index.ts`, `src/context-pruning/__tests__/integration.test.ts`.
  - **Acceptance criteria**: full pipeline runs without errors on a normal session; shadow mode does not modify messages; errors in any step result in original messages returned; pipeline is idempotent.
  - **Definition of Done**: integration tests cover full pipeline, shadow mode, error recovery, and idempotency.

- **T-014 — Write comprehensive tests**
  - **What + why**: Ensure all modules have adequate test coverage. Write integration tests that simulate real session scenarios: multi-turn conversations, compress → transform → verify, compaction interop, branch/fork behavior.
  - **Related files**: all `src/context-pruning/__tests__/*.test.ts` files.
  - **Acceptance criteria**: provenance mapping has zero false positives in synthetic tests; compress → transform → verify round-trip works; compaction retires blocks correctly; all guardrails reject invalid operations; existing tests still pass.
  - **Definition of Done**: `bun run test` passes with new tests; coverage is adequate for all new modules.

- **T-015 — Run full verification**
  - **What + why**: Execute the project-defined verification sequence and confirm no regressions.
  - **Related files**: all changed files; `package.json` scripts.
  - **Acceptance criteria**: `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test`, and `bun run check:size` pass, or failures are fixed/documented honestly.
  - **Definition of Done**: verification results captured in implementation summary.

## 3. Dependencies

| Edge | Reason |
|---|---|
| T-002 depends on T-001 | Registration needs config types. |
| T-003, T-004 independent | Provenance and digest can be built in parallel. |
| T-005 depends on T-003 | Ref injection needs manifest structure. |
| T-006 independent of T-003–T-005 | State reducer is pure data transformation. |
| T-007 depends on T-006 | Reconstruction uses the reducer. |
| T-008 depends on T-003, T-006 | Transformer needs both manifest and state types. |
| T-009 depends on T-008 | Summary message factory is part of the transformer. |
| T-010 depends on T-003, T-006, T-011 | Compress tool needs manifest, state, and guardrails. |
| T-011 independent | Guardrails are pure functions. |
| T-012 depends on T-006, T-007 | Compaction interop needs state module. |
| T-013 depends on T-003, T-005, T-007, T-008, T-012 | Integration wires all components. |
| T-014 depends on T-003–T-013 | Tests need implementations. |
| T-015 depends on T-014 | Verification after tests pass. |

No cycles. Bottlenecks: T-001 (config) unblocks T-002 (scaffold); T-003 (provenance) and T-006 (state) are the two parallel tracks that converge at T-008 (transform) and T-010 (tool).

## 4. Test Strategy

- **Unit tests** with `node:test` and `node:assert/strict` for: provenance mapping, digest computation, state reducer, guardrails, summary message factory, config parsing.
- **Integration tests** with mock Pi APIs (`ExtensionContext`, `SessionManager`) for: full context hook pipeline, compress tool execute, compaction interop, state reconstruction from branch.
- **Property tests**: deterministic output (same input → same output), fail-open (error → original messages).
- **Regression tests**: existing delegate tools, sub-agents, and config surfaces remain valid.
- **Verification commands**: `bun run lint && bun run typecheck && bun run build && bun run test && bun run check:size`.

## 5. Migration / Rollback

Migration:

- No database migration.
- No required config migration — the new `context_pruning` section is optional and defaults to disabled.
- Existing sessions, YAML agents, and settings.json files require no changes.

Backward compatibility:

- Existing delegate tool names, parameters, and output semantics remain valid.
- New hooks and tools are only registered when `context_pruning.enabled = true`.
- The `context` hook is non-destructive (returns original messages on error or when disabled).

Rollback:

- Set `context_pruning.enabled = false` to fully deactivate. No state cleanup needed — compression blocks in tool-result details are inert when the feature is off.
- Remove `context_pruning` section from settings.json to revert to defaults.

## 6. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | Provenance mapping produces false positives under complex prior transforms. | Conservative alignment with LCS fallback; unowned messages are never compressed; shadow mode validates mapping before compression is enabled — owner: invoker | open |
| R-002 | `compress` tool prompt engineering is critical — model must produce high-quality summaries and correct boundary refs. | Tool description and prompt guidelines must be clear and tested; shadow mode allows evaluation before enabling compression — owner: invoker | open |
| R-003 | State reconstruction from tool-result details is O(branch length) and could be slow for very long sessions. | Cache by (leafId, lastModified); only scan compress tool results, not all entries; cap active blocks to limit scan cost — owner: invoker | open |
| Q-001 | Should `compress` be exposed as a public delegate tool or remain internal to the host session only? | Decide during Phase 1 implementation; internal-only is safer for MVP — owner: invoker | open |
| Q-002 | Should we support an optional separate "summarizer" model? | Deferred to Phase 3 evaluation — owner: invoker | open |
| Q-003 | What is the exact license of pi-blackbytes? | Deferred; does not block implementation but affects clean-room documentation — owner: invoker | open |

## 7. Beads Handoff Notes

- Conversion already produced the graph traced below; it must not be converted or polished again.
- All 23 graph issues are `deferred` and carry `evidence:required`.
- Do not run implementation against this graph. A later `GO` decision requires a new runtime plan and
  a newly reviewed bead graph.

## 8. Beads Trace

| Plan task | Bead ID |
|---|---|
| Root feature | `pib-pib-context-pruning-phase1-mydl` |
| E-1: Core infrastructure and config | `pib-pib-context-pruning-phase1-mydl.1` |
| T-001: Add context_pruning section to BlackbytesConfigSchema | `pib-pib-context-pruning-phase1-mydl.1.1` |
| T-002: Create context-pruning module scaffold and registration | `pib-pib-context-pruning-phase1-mydl.1.2` |
| E-2: Provenance mapping | `pib-pib-context-pruning-phase1-mydl.2` |
| T-003: Implement buildContextManifest() | `pib-pib-context-pruning-phase1-mydl.2.1` |
| T-004: Implement source digest computation | `pib-pib-context-pruning-phase1-mydl.2.2` |
| T-005: Implement context reference injection | `pib-pib-context-pruning-phase1-mydl.2.3` |
| E-3: Compression state | `pib-pib-context-pruning-phase1-mydl.3` |
| T-006: Implement CompressionState reducer | `pib-pib-context-pruning-phase1-mydl.3.1` |
| T-007: Implement state reconstruction from session branch | `pib-pib-context-pruning-phase1-mydl.3.2` |
| E-4: Context transformation | `pib-pib-context-pruning-phase1-mydl.4` |
| T-008: Implement applyBlocks() pure transformer | `pib-pib-context-pruning-phase1-mydl.4.1` |
| T-009: Implement synthetic summary message factory | `pib-pib-context-pruning-phase1-mydl.4.2` |
| E-5: Compress tool | `pib-pib-context-pruning-phase1-mydl.5` |
| T-010: Implement compress tool definition and execute handler | `pib-pib-context-pruning-phase1-mydl.5.1` |
| T-011: Implement guardrails module | `pib-pib-context-pruning-phase1-mydl.5.2` |
| E-6: Compaction interop | `pib-pib-context-pruning-phase1-mydl.6` |
| T-012: Implement compaction epoch and block retirement | `pib-pib-context-pruning-phase1-mydl.6.1` |
| E-7: Integration, tests, and verification | `pib-pib-context-pruning-phase1-mydl.7` |
| T-013: Implement context event hook integration | `pib-pib-context-pruning-phase1-mydl.7.1` |
| T-014: Write comprehensive tests | `pib-pib-context-pruning-phase1-mydl.7.2` |
| T-015: Run full verification | `pib-pib-context-pruning-phase1-mydl.7.3` |

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-14 | Bytes | Created Draft implementation plan from context pruning spec |
| 2026-07-14 | Bytes | Deferred before activation after PRD audit; runtime implementation now requires an evidence `GO` decision. |
| 2026-07-14 | Bytes | Renamed superseded requirements to `OLD-REQ-*` and clarified that conversion already occurred, preventing cross-reference with the evidence PRD. |
