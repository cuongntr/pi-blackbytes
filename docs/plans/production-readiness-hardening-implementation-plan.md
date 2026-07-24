# Production Readiness Hardening — Phase 1 Implementation Plan

| Field | Value |
|---|---|
| Status | Draft |
| Owner | invoker |
| Source PRD | [`../specs/production-readiness-hardening.md`](../specs/production-readiness-hardening.md) |
| Source Technical Design | [`../specs/production-readiness-hardening.md#6-technical-design`](../specs/production-readiness-hardening.md#6-technical-design) |
| Related ADRs | None |
| Phase | Phase 1 MVP |

## 1. MVP-Lock

**In phase:** REQ-001 through REQ-004, implemented by the five leaves below.

**Out of phase:** every other audit finding, including generic HTTP redaction, JSONL line caps,
cwd/prompt wording, hard-link policy changes, config work, private-network opt-in, and docs cleanup.

**Exit criteria:** all five leaves and their focused tests pass; `bun run check` passes; package remains
below 500 KB gzip; no runtime dependency or public tool schema is added.

## 2. Work Items

### E-1 — Fix the four demonstrated boundary failures

- **T-001 — Validate every direct-fetch destination and redirect**
  - **What + why**: Prevent direct `web_fetch` from reaching private addresses while keeping the
    policy local to user-controlled direct fetches.
  - **Files**: `src/tools/_shared/http.ts`, `src/tools/websearch/fetch.ts`, their existing tests; one
    small direct-fetch policy helper only if it keeps IP/DNS logic testable.
  - **Acceptance criteria**:
    - Add `redirect?: RequestRedirect` to shared HTTP options and expose response headers on HTTP errors.
    - Reject literal or DNS-resolved IPv4/IPv6 loopback, private, and link-local destinations.
    - Follow a fixed number of redirects manually, resolve relative `Location`, and validate each hop.
    - One deadline covers all hops; each request receives only the remaining timeout.
    - Public HTTPS success and fixed provider endpoint behavior remain unchanged.
  - **DoD**: focused literal-IP, injected-DNS, relative redirect, public-to-private redirect, redirect
    limit, and timeout-budget tests pass; no generic sandbox or custom transport.
  - **Reference**: [REQ-001 / §6.1](../specs/production-readiness-hardening.md#61-direct-fetch).

- **T-002 — Terminate nested Pi process groups on timeout and cancellation**
  - **What + why**: Prevent descendants from surviving after the existing timeout/cancel path reports
    completion; extend the runner lifecycle rather than adding a supervisor.
  - **Files**: `src/sub-agents/runner.ts`, `src/sub-agents/runner.test.ts`, existing runner fixtures.
  - **Acceptance criteria**:
    - POSIX nested Pi runs in its own process group; termination signals the group.
    - Existing SIGTERM/grace/SIGKILL sequence and `timed_out`/`cancelled` classifications remain.
    - Unsupported group signaling falls back to current direct-child termination.
  - **DoD**: a POSIX fixture proves a spawned grandchild does not survive; existing timeout and cancel
    tests pass; no process-manager abstraction.
  - **Reference**: [REQ-002 / §6.2](../specs/production-readiness-hardening.md#62-nested-runner).

- **T-003 — Require a parsed `agent_end` before zero-exit success**
  - **What + why**: Stop treating incomplete raw JSONL stdout as a valid delegate answer while
    preserving current banner tolerance and content extraction.
  - **Files**: `src/sub-agents/runner.ts`, `src/sub-agents/runner.test.ts`.
  - **Acceptance criteria**:
    - Set `sawAgentEnd` when a parsed event has `type === "agent_end"`.
    - Exit zero without `sawAgentEnd` returns `malformed_jsonl`.
    - Do not require assistant text or add deeper event schema validation.
    - Valid zero-exit runs and existing non-zero classification remain unchanged.
  - **DoD**: zero-exit with and without `agent_end` tests pass along with current malformed/non-zero tests.
  - **Reference**: [REQ-002 / §6.2](../specs/production-readiness-hardening.md#62-nested-runner).

- **T-004 — Resolve each fallback attempt's prompt family in `register.ts`**
  - **What + why**: Use the model already passed to the existing per-attempt runner adapter; do not
    move prompt construction into generic fallback orchestration.
  - **Files**: `src/sub-agents/register.ts`, registration/fallback integration tests,
    `docs/specs/prompt-system-hardening.md` for the superseded behavior note.
  - **Acceptance criteria**:
    - Build the declaration overlay once.
    - Immediately before `runNestedPi`, resolve/build the persona body from the attempt's `o.model`
      and prepend the existing overlay.
    - GPT→non-GPT and non-GPT→GPT fallback tests capture the correct body for both attempts.
    - Primary-only, budget, eligibility, and retry behavior remain unchanged; `fallback.ts` needs no
      prompt-factory API.
  - **DoD**: focused registration tests pass and the old primary-prompt-reuse statement is marked
    superseded without a broader prompt rewrite.
  - **Reference**: [REQ-003 / §6.3](../specs/production-readiness-hardening.md#63-prompt-attempt-context).

- **T-005 — Complete both existing hashline write paths**
  - **What + why**: Handle short writes correctly without changing target-selection or hard-link policy.
  - **Files**: `src/tools/hashline-edit/fs-write.ts`,
    `src/tools/hashline-edit/__tests__/atomic-write.test.ts`.
  - **Acceptance criteria**:
    - One small `writeBufferFully` helper advances by actual bytes written and throws on zero progress.
    - Both in-place hard-link and temp-file paths use the same helper.
    - A pre-rename failure removes the unpublished temp file and leaves the target unchanged.
    - Existing hard-link, symlink, mode, BOM, and CRLF behavior remains unchanged.
  - **DoD**: narrow injected-writer tests cover short/zero writes; hashline regressions pass; no writer
    interface, persistence class, new config, or new error code.
  - **Reference**: [REQ-004 / §6.4](../specs/production-readiness-hardening.md#64-hashline-persistence).

## 3. Dependencies

T-001 through T-005 are independent and may be implemented in any order. There are no dependency
edges or cycles. Full `bun run check` is an epic exit gate, not a separate bead.

## 4. Test and Rollback Strategy

Each leaf runs its focused `node:test` suite. Shared type changes also run `bun run typecheck`. After
all leaves, run `bun run check` in the repository-defined order (`lint → typecheck → build → test →
size`). The existing 880-test baseline must have zero regression; no new coverage percentage is added.

There is no data/config migration or public request-schema change. Each leaf is independently
revertible. Private fetch support, deeper JSONL validation, and platform-wide process supervision
require separate designs rather than expansion of this phase.

## 5. Risks and Open Questions

| ID | Risk | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | DNS may change after preflight. | Document residual risk; custom pinned transport is out of scope — invoker. | Accepted |
| R-002 | Process groups are platform-specific. | POSIX test plus direct-child fallback — invoker. | Mitigated |

No open question blocks implementation.

## 6. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-24 | Amp | Created focused five-leaf plan |
| 2026-07-24 | Amp | Removed adjacent hardening and integration/docs bead after overengineering review |
