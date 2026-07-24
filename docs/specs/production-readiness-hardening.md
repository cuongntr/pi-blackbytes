# Production Readiness Hardening — Phase 1 Spec

| Field | Value |
|---|---|
| Status | Draft |
| Owner | invoker |
| Created | 2026-07-24 |
| Variant | Brownfield |
| Related specs | [`prompt-system-hardening.md`](prompt-system-hardening.md), [`subagent-mechanism-hardening.md`](subagent-mechanism-hardening.md), [`hashline-edit-hardening.md`](hashline-edit-hardening.md) |
| Related ADRs | None; no new technology or dependency |

## 1. Context and Goal

The audit found four concrete boundary failures that are not covered by the otherwise strong normal
paths: direct fetches can reach private destinations, nested runs can leave descendants or accept
zero-exit output without `agent_end`, fallback attempts can receive the primary model's prompt, and
filesystem writes assume one `writeSync()` writes every byte. Phase 1 fixes only these problems.

Success means each boundary has an adversarial regression test, `bun run check` remains green, no
public tool schema changes, and the package stays below 500 KB gzip.

## 2. Users and Primary Journey

- **Coding-agent user**: expects network, cancellation, and file mutations to fail safely.
- **Plugin maintainer**: needs malformed provider/process/filesystem behavior to be bounded and
  classified without redesigning the plugin.

Primary journey: untrusted input reaches a boundary, the plugin validates it before side effects,
returns a controlled error when unsafe, and leaves the workspace/process/network state bounded.

## 3. Requirements

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-001 | Block SSRF in direct `web_fetch`. | P0 | Initial URLs and every redirect hop reject literal or DNS-resolved loopback, private, and link-local addresses; redirects are manual and bounded under one timeout budget; public HTTPS URLs still work. |
| REQ-002 | Correct nested process and terminal-event lifecycle. | P0 | Timeout/cancellation terminate the nested process group on POSIX with direct-child fallback elsewhere; exit zero without a parsed `agent_end` is `malformed_jsonl`; valid runs retain current output behavior. |
| REQ-003 | Resolve the prompt family for the actual fallback attempt. | P0 | Each fallback attempt resolves `systemPromptByFamily` for its own model without changing fallback eligibility, retry rules, or timeout budgeting. |
| REQ-004 | Complete supported hashline writes. | P0 | Both existing write paths loop over a `Buffer` until complete; zero-progress writes fail; incomplete temp content is removed and never renamed; current hard-link, symlink, and mode behavior remains. |

## 4. Non-Functional Requirements

- No new runtime dependency or public tool name/schema.
- New memory bounds are constants with focused tests.
- Security checks fail closed while ordinary upstream failures remain controlled tool results.
- Existing Node 20, ESM, Biome, `node:test`, and package-size conventions remain unchanged.

## 5. Out of Scope

- Generic network sandboxing, custom socket/DNS stack, or private-network opt-in.
- Generic HTTP error redaction, embedded-credential policy, or changes to fixed provider endpoints.
- JSONL line-size limits, missing-stream cleanup, or additional protocol schema validation.
- Cwd/AGENTS handling, prompt rewrites, verification wording, or new prompt modes.
- Changing or removing current hard-link mutation behavior.
- Config parser migration, chain observability, AST/glob refactors, or status UI work.
- License selection, changelog backfill, README cleanup, or tarball declaration cleanup.
- New hashline operations or changing the existing error taxonomy.

## 6. Technical Design

### 6.1 Direct fetch

Add one small direct-fetch URL-policy helper with a narrow DNS resolver injection for tests. It rejects
disallowed literal/resolved IP ranges. Extend the shared HTTP options with `redirect`, and expose
response headers on HTTP-status errors so direct fetch can read `Location`. Direct fetch uses manual
redirects, resolves relative locations, validates every hop, and carries one deadline across all hops.
Fixed provider endpoints do not use the user-URL policy.

Native fetch performs its own lookup after preflight, so DNS rebinding is a documented residual risk;
eliminating it would require a larger custom transport and is explicitly deferred.

### 6.2 Nested runner

On POSIX, spawn nested Pi as its own process group and centralize termination of that group. Preserve
the current SIGTERM/grace/SIGKILL behavior and use direct-child termination where process groups are
not supported. Separately track `sawAgentEnd` when a parsed event has `type === "agent_end"`; exit zero
without it is `malformed_jsonl`. Do not require assistant text or change current output extraction.

### 6.3 Prompt attempt context

Keep fallback orchestration unchanged. In `register.ts`'s existing per-attempt runner adapter, rebuild
the persona body from `o.model` immediately before `runNestedPi`, then prepend the already-built
overlay. This avoids introducing prompt construction into the generic fallback module.

This supersedes the earlier decision in `prompt-system-hardening.md` that fallback models reuse the
primary prompt body.

### 6.4 Hashline persistence

Convert content to one `Buffer` and use one small `writeBufferFully` loop in both existing write paths.
Advance by the returned byte count and throw on zero progress. A pre-rename failure removes an
unpublished temp file. Keep existing hard-link in-place writes, temp rename, symlink targeting, and
mode restoration; do not introduce a filesystem writer interface.

## 7. Compatibility and Rollback

- Existing tool requests remain valid.
- Private destinations and zero-exit output without `agent_end` intentionally change to controlled
  failure. Existing hard-link behavior remains supported.
- No settings or data migration.
- Each workstream can be reverted independently.

## 8. Testing Strategy

- SSRF: IPv4/IPv6 literals, DNS resolution, relative/public-to-private redirect, shared timeout budget.
- Runner: grandchild cleanup and zero-exit with/without parsed `agent_end`, plus timeout regressions.
- Prompt: primary/fallback attempts from different model families and no-fallback regression.
- Hashline: injected short/zero writes, temp cleanup, and unchanged hard-link/symlink/mode behavior.
- Final gate: `bun run check`.

## 9. Roadmap and Exit Criteria

| Phase | Scope | Exit Criteria |
|---|---|---|
| Phase 1 MVP | REQ-001 through REQ-004 | Focused adversarial tests and `bun run check` pass; no new dependency or public schema. |
| Phase 2 MVP | None committed | Any remaining audit item requires a separate intake rather than automatic scope growth. |

## 10. Open Questions

No blocking open questions. Private-network opt-in and a custom DNS-pinned transport are deferred, not
implicitly part of Phase 1.

## 11. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-24 | Amp | Created focused Phase 1 spec from the audit; limited scope to four demonstrated boundary failures |
