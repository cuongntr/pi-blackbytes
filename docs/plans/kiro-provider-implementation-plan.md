# Blackbytes Kiro Provider — Implementation Plan

| Field | Value |
|---|---|
| Status | Active |
| Owner | invoker |
| Source Spec / PRD | [`../specs/kiro-provider.md`](../specs/kiro-provider.md) |
| Source Technical Design | [`../specs/kiro-provider.md#9-technical-design`](../specs/kiro-provider.md#9-technical-design) |
| Related ADRs | None present in this repo |
| Phase | Phase 1 MVP |

---

## 1. MVP-Lock

In this phase:

- REQ-001: config-gated bundled Kiro provider.
- REQ-002: provider alias registration for account isolation.
- REQ-003: credential source compatibility for default IDE/CLI sources and explicit alias sources.
- REQ-004: provider-local rate-limit and capacity retry.
- REQ-005: upstream-compatible Kiro model/request behavior.
- REQ-006: documentation, tests, and rollback.

Out of this phase:

- Automatic account rotation to avoid quota/rate limits.
- Full GUI or command-based account manager.
- Writing/switching Kiro IDE or `kiro-cli` active token files as the normal multi-account mechanism.
- Global Pi retry changes.
- New runtime dependencies.
- Replacing other external model providers.

Exit criteria:

- `blackbytes.kiro.enabled=true` registers the default Kiro provider alias `kirob` from existing IDE/CLI credentials.
- Two configured accounts register two independent provider aliases in one session.
- Kiro `429` transient retry is provider-local, abortable, respects `Retry-After`, and does not retry `MONTHLY_REQUEST_COUNT` quota bodies.
- Kiro capacity retry remains separate from `429` retry.
- `/blackbytes-status` redacts all Kiro secrets.
- README/AGENTS document config, multi-account limits, and rollback.
- `bun run lint && bun run typecheck && bun run build && bun run test` passes.

Scope changes after this plan is promoted to Active require a delta-change doc.

### Pre-bead decisions

> Resolved by owner on 2026-06-07. `Kirob` is recorded as provider id `kirob` to keep Pi model references lowercase and shell-friendly.

| ID | Decision | Outcome | Owner / Status |
|---|---|---|---|
| D-001 | Default provider alias | `kirob` | invoker / answered |
| D-002 | Phase 1 auth surface | Preserve upstream-compatible Pi OAuth hooks | invoker / answered |

## 2. Work Item Hierarchy

### Epic E-1: Provider config and registration foundation

#### Task T-1: Add typed Kiro config and validation

- **T-001 — Add `blackbytes.kiro` schema and resolver**
  - **What + why**: Extend `src/config/schema.ts` with an optional `kiro` block and add a resolver that applies safe defaults. This keeps the provider disabled by default and makes retry/account settings testable.
  - **Related files / packages**: `src/config/schema.ts`, `src/config/__tests__/schema.test.ts`, new `src/providers/kiro/config.ts`, new `src/providers/kiro/__tests__/config.test.ts`.
  - **Acceptance criteria**: parses `enabled`, `default_provider`, `retry`, and `accounts`; preserves passthrough unknown keys; defaults `default_provider` to `kirob`; defaults retry budgets; empty accounts with `enabled=true` resolves one default account.
  - **Definition of Done**: config code + unit tests + no behavior change when omitted.
  - **References**: [`kiro-provider.md#req-001--config-gated-bundled-kiro-provider`](../specs/kiro-provider.md#req-001--config-gated-bundled-kiro-provider), [`kiro-provider.md#93-config--data-model`](../specs/kiro-provider.md#93-config--data-model).

- **T-002 — Validate Kiro account aliases and provider names**
  - **What + why**: Reject duplicate account ids/provider ids and unsafe provider identifiers before calling `pi.registerProvider`. Provider aliases are the isolation boundary for multi-account usage.
  - **Related files / packages**: `src/providers/kiro/config.ts`, `src/providers/kiro/__tests__/config.test.ts`.
  - **Acceptance criteria**: duplicate `id` fails; duplicate `provider` fails; invalid provider names fail with actionable messages; valid names like `kirob`, `kiro_personal`, `blackbytes-kiro`, and `kiro.work` pass.
  - **Definition of Done**: validation implemented and covered by tests.
  - **References**: [`kiro-provider.md#req-002--provider-alias-registration-for-account-isolation`](../specs/kiro-provider.md#req-002--provider-alias-registration-for-account-isolation).

#### Task T-2: Register provider aliases during session start

- **T-003 — Implement `registerKiroProviders()` and wire it into `session_start`**
  - **What + why**: Add a Kiro provider registration entry point similar to `registerCopilotHeader()`, but capable of registering zero, one, or many account aliases from config.
  - **Related files / packages**: new `src/providers/kiro/register.ts`, `src/handlers/index.ts`, `src/test-utils/pi-mock.ts`, `src/__tests__/integration/session-start.test.ts` or new provider integration test.
  - **Acceptance criteria**: disabled config registers nothing; enabled empty-account config registers default alias `kirob`; enabled two-account config registers two aliases; provider options include base URL, alias-scoped models, upstream-compatible OAuth hooks, credential hooks, and `streamSimple`.
  - **Definition of Done**: implementation + integration tests with Pi mock, including a test that external `kiro` provider collision is avoided unless explicitly configured.
  - **References**: [`AGENTS.md#registration-flow-critical`](../../AGENTS.md#registration-flow-critical), [`kiro-provider.md#94-provider-api--public-contract`](../specs/kiro-provider.md#94-provider-api--public-contract).

### Epic E-2: Credential source compatibility

#### Task T-3: Read existing Kiro IDE and CLI credentials safely

- **T-004 — Port minimal Kiro IDE token reader**
  - **What + why**: Read Kiro IDE token JSON from the default path or an alias-specific `token_path` without printing token values. This supports users already logged into Kiro IDE.
  - **Related files / packages**: new `src/providers/kiro/cli-auth.ts`, `src/providers/kiro/auth.ts`, `src/providers/kiro/__tests__/auth.test.ts`.
  - **Acceptance criteria**: reads valid unexpired token; optionally allows expired token for refresh flow; handles missing/malformed files without leaking contents; maps region/auth/profile metadata.
  - **Definition of Done**: reader + fixtures with redacted dummy tokens + tests.
  - **References**: [`kiro-provider.md#req-003--credential-source-compatibility`](../specs/kiro-provider.md#req-003--credential-source-compatibility), [`kiro-provider.md#95-credential-resolution`](../specs/kiro-provider.md#95-credential-resolution).

- **T-005 — Port minimal `kiro-cli` SQLite credential reader**
  - **What + why**: Reuse active `kiro-cli` credentials for the default account and explicit account sources. This preserves upstream provider compatibility without requiring users to log in again.
  - **Related files / packages**: `src/providers/kiro/cli-auth.ts`, `src/providers/kiro/__tests__/auth.test.ts`.
  - **Acceptance criteria**: reads IDC key `kirocli:odic:token`; reads social key `kirocli:social:token`; supports `auth_method=auto`; gracefully skips if SQLite binary/access is unavailable; never logs token JSON.
  - **Definition of Done**: reader + tests using a temp SQLite fixture or mocked query layer.
  - **References**: [`kiro-provider.md#95-credential-resolution`](../specs/kiro-provider.md#95-credential-resolution).

#### Task T-4: Refresh and resolve credentials per alias

- **T-006 — Implement alias-scoped credential resolver and refresh helpers**
  - **What + why**: Build one credential path per provider alias so personal/work aliases do not overwrite each other. Refresh helpers should preserve upstream IDC/desktop behavior while keeping secrets redacted.
  - **Related files / packages**: `src/providers/kiro/auth.ts`, `src/providers/kiro/cli-auth.ts`, `src/providers/kiro/__tests__/auth.test.ts`.
  - **Acceptance criteria**: explicit `api_key` env source works; default IDE/CLI discovery works; alias-scoped OAuth login/refresh hooks work; IDC refresh hits AWS OIDC token endpoint shape; desktop refresh hits Kiro desktop refresh endpoint shape; refresh errors include status but not secret bodies.
  - **Definition of Done**: resolver + refresh tests with mocked `fetch`, with dummy credentials only.
  - **References**: [`kiro-provider.md#95-credential-resolution`](../specs/kiro-provider.md#95-credential-resolution), [`kiro-provider.md#97-security`](../specs/kiro-provider.md#97-security).

### Epic E-3: Kiro stream, models, and retry behavior

#### Task T-5: Port stream/event/model core

- **T-007 — Add Kiro model definitions and model modification behavior**
  - **What + why**: Provide the model list and region-specific base URL behavior needed for Pi model selection and requests.
  - **Related files / packages**: new `src/providers/kiro/models.ts`, `src/providers/kiro/register.ts`, `src/providers/kiro/__tests__/models.test.ts`.
  - **Acceptance criteria**: model provider names match each alias; region resolves to `https://q.<region>.amazonaws.com/generateAssistantResponse`; static fallback model list is documented if live cache update is deferred.
  - **Definition of Done**: model helper + tests.
  - **References**: [`kiro-provider.md#req-005--upstream-compatible-kiro-model-and-request-behavior`](../specs/kiro-provider.md#req-005--upstream-compatible-kiro-model-and-request-behavior).

- **T-008 — Add Kiro event parser fixture tests**
  - **What + why**: Port and isolate the parser for Kiro-compatible response events before wiring live stream requests. This keeps the most brittle wire-format logic testable independently.
  - **Related files / packages**: new `src/providers/kiro/event-parser.ts`, `src/providers/kiro/__tests__/event-parser.test.ts`.
  - **Acceptance criteria**: parses content, tool use, tool input, stop, usage, context usage, follow-up prompt, and error events; malformed event chunks fail safely; fixtures use redacted/dummy payloads only.
  - **Definition of Done**: parser implementation + fixture tests.
  - **References**: [`kiro-provider.md#98-sequence-diagram`](../specs/kiro-provider.md#98-sequence-diagram), [`kiro-provider.md#99-testing-strategy`](../specs/kiro-provider.md#99-testing-strategy).

- **T-009 — Implement Kiro stream request assembly and success path**
  - **What + why**: Implement the `streamSimple` success path separately from retry logic so request shape, credential injection, model/region selection, and event forwarding can be validated before transient-failure behavior is added.
  - **Related files / packages**: new `src/providers/kiro/stream.ts`, `src/providers/kiro/event-parser.ts`, `src/providers/kiro/auth.ts`, `src/providers/kiro/models.ts`, `src/providers/kiro/__tests__/stream.test.ts`.
  - **Acceptance criteria**: sends requests to `https://q.<region>.amazonaws.com/generateAssistantResponse`; attaches the resolved alias credential without leaking secrets; forwards parsed content/tool/usage events; handles a successful mocked streaming response end-to-end.
  - **Definition of Done**: stream success-path implementation + mocked `fetch` tests.
  - **References**: [`kiro-provider.md#98-sequence-diagram`](../specs/kiro-provider.md#98-sequence-diagram).

#### Task T-6: Implement provider-local retry

- **T-010 — Implement Kiro retry classification and abortable backoff**
  - **What + why**: Keep Kiro-specific retry in the provider, not Pi global retry. This fixes transient `429` behavior while avoiding retries for quota exhaustion.
  - **Related files / packages**: new `src/providers/kiro/retry.ts`, `src/providers/kiro/__tests__/retry.test.ts`.
  - **Acceptance criteria**: detects non-retryable quota patterns; detects capacity pattern; parses `Retry-After` seconds and HTTP-date; caps fallback exponential backoff; delay helper rejects/aborts on `AbortSignal`.
  - **Definition of Done**: retry helper + deterministic unit tests with fake timers or small injected delay function.
  - **References**: [`kiro-provider.md#req-004--provider-local-rate-limit-and-capacity-retry`](../specs/kiro-provider.md#req-004--provider-local-rate-limit-and-capacity-retry), [`kiro-provider.md#96-retry--reliability`](../specs/kiro-provider.md#96-retry--reliability).

- **T-011 — Integrate retry budgets into `streamKiro()`**
  - **What + why**: Apply the retry helper around Kiro HTTP responses so `429` and capacity have independent budgets and do not consume unrelated outer retry logic.
  - **Related files / packages**: `src/providers/kiro/stream.ts`, `src/providers/kiro/retry.ts`, `src/providers/kiro/__tests__/stream.test.ts`.
  - **Acceptance criteria**: transient `429` succeeds after retry in tests; `MONTHLY_REQUEST_COUNT` fails without retry; capacity retry remains separate; abort during backoff cancels promptly; retry attempt counts are bounded by config.
  - **Definition of Done**: stream retry integration + mocked `fetch` tests.

### Epic E-4: Status, docs, and verification

#### Task T-7: Redaction and status visibility

- **T-012 — Extend redaction and add Kiro status summary**
  - **What + why**: Users need to verify aliases and credential source types without exposing tokens or secrets.
  - **Related files / packages**: `src/commands/blackbytes-status.ts`, new `src/providers/kiro/redaction.ts`, `src/commands/__tests__/blackbytes-status.test.ts`, possibly `src/shared/logger.ts`.
  - **Acceptance criteria**: redacts token/refresh/client secret/API key fields recursively; status output may show alias, provider, region, and credential source type; tests prove dummy secrets are absent.
  - **Definition of Done**: redaction helper/status update + tests.
  - **References**: [`kiro-provider.md#97-security`](../specs/kiro-provider.md#97-security), [`kiro-provider.md#req-006--documentation-tests-and-rollback`](../specs/kiro-provider.md#req-006--documentation-tests-and-rollback).

#### Task T-8: Documentation and final verification

- **T-013 — Document Kiro provider config, multi-account limits, and rollback**
  - **What + why**: Make clear that aliases are for legitimate account separation, not quota evasion, and show safe setup/rollback steps.
  - **Related files / packages**: `README.md`, `AGENTS.md`, possibly `CHANGELOG.md` if this is prepared for release.
  - **Acceptance criteria**: README lists config examples for default `kirob` and two aliases; AGENTS config section lists supported keys and secret handling; docs warn that Kiro CLI itself remains one active session and that automatic rotation is out of scope; docs record D-001/D-002 outcomes.
  - **Definition of Done**: docs updated and consistent with implemented schema.
  - **References**: [`kiro-provider.md#8-out-of-scope`](../specs/kiro-provider.md#8-out-of-scope), [`kiro-provider.md#10-migration--rollback`](../specs/kiro-provider.md#10-migration--rollback).

- **T-014 — Run full project verification and size check**
  - **What + why**: Ensure the provider is safe to ship and does not break existing extension surfaces.
  - **Related files / packages**: all changed files; package scripts.
  - **Acceptance criteria**: `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test`, and `bun run check:size` pass, or failures are fixed/documented honestly.
  - **Definition of Done**: verification commands captured in final implementation report.
  - **References**: [`AGENTS.md#development`](../../AGENTS.md#development).

## 3. Dependencies

| Edge | Reason |
|---|---|
| T-002 depends on T-001 | Alias validation uses the normalized config shape. |
| T-003 depends on T-001, T-002 | Registration needs normalized accounts plus provider-name validation. |
| T-004 depends on T-001 | Token paths/source options come from config. |
| T-005 depends on T-001 | CLI DB path/auth method options come from config. |
| T-006 depends on T-004, T-005 | Resolver composes IDE/CLI readers and upstream-compatible OAuth hooks. |
| T-007 depends on T-003 | Model provider names are alias-scoped during registration. |
| T-008 has no code dependency after T-001 | Parser can be implemented from fixtures once provider module structure exists. |
| T-009 depends on T-006, T-007, T-008 | Stream success path needs credentials, model/region request shape, and parser output. |
| T-010 depends on T-001 | Retry budgets come from config defaults/overrides. |
| T-011 depends on T-009, T-010 | Stream retry integration needs stream success path and retry helpers. |
| T-012 depends on T-001, T-003 | Status summarizes configured and registered aliases. |
| T-013 depends on T-001 through T-012 | Docs must match final implementation behavior and owner decisions. |
| T-014 depends on T-013 | Verify after code and docs are complete. |

No cycles. Bottlenecks: T-001/T-002/T-003 establish the registration seam; T-006 blocks stream execution; T-010 blocks reliable retry behavior.

## 4. Test Strategy

- Unit tests with `node:test` and `node:assert/strict` for config, alias validation, redaction, retry helpers, event parsing, and model helpers.
- Mocked `fetch` tests for token refresh and stream retry behavior.
- Temp-file or mocked-query tests for Kiro IDE token and `kiro-cli` SQLite readers; use dummy tokens only.
- Integration tests with `src/test-utils/pi-mock.ts` for provider registration enabled/disabled/default/two-alias cases.
- Status tests proving recursive redaction of `accessToken`, `refreshToken`, `clientSecret`, `api_key`, and `authorization` fields.
- No numeric coverage target is set for this repo; minimum acceptable coverage is targeted tests for every new provider module plus registration/status integration tests.
- Verification commands in project order: `bun run lint && bun run typecheck && bun run build && bun run test`, plus `bun run check:size` because provider code adds bundled surface area.

## 5. Migration / Rollback

Migration:

- No database migration.
- No automatic edits to Kiro IDE token files or `kiro-cli` SQLite database.
- Existing Blackbytes users see no behavior change until `blackbytes.kiro.enabled=true`.

Backward compatibility:

- External `pi-provider-kiro` can remain installed if provider names do not collide.
- Default Blackbytes provider name is `kirob`, avoiding external `kiro` unless the user explicitly configures a colliding alias.
- Existing Blackbytes config remains passthrough and preserved.

Rollback:

```json
{
  "blackbytes": {
    "kiro": {
      "enabled": false
    }
  }
}
```

After rollback, restart Pi and use the external Kiro provider or another model provider.

## 6. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | Upstream provider changes request/auth shape while Blackbytes copy drifts | Isolate provider modules; document copied upstream version; keep fixtures close to wire shape — owner: invoker | open |
| R-002 | Provider ID collision with external `kiro` | Default alias resolved to `kirob`; still test explicit collision handling — owner: invoker | mitigated |
| R-003 | SQLite fixture setup is brittle on systems without `sqlite3` CLI | Abstract query layer for tests; use mocked query for most tests and one optional integration if practical — owner: invoker | open |
| R-004 | Retry tests become slow if real sleeps are used | Inject delay function or fake clock; keep tests deterministic — owner: invoker | open |
| R-005 | Secret redaction misses a differently-cased key | Use recursive case-insensitive substring redaction and add table-driven tests — owner: invoker | open |
| D-001 | Default provider alias | `kirob` — owner: invoker | answered |
| D-002 | Phase 1 auth surface | Preserve upstream-compatible OAuth hooks — owner: invoker | answered |

## 7. Beads Handoff Notes

- Beads directory detected at `.beads/` with `beads.db` and `issues.jsonl`; use the `br`/`bv` ecosystem unless project tooling indicates otherwise.
- Suggested feature label: `feature:kiro-provider`.
- Suggested service label: `service:providers`.
- Convert after `plan-ready-for-beads` passes; pre-bead decisions D-001/D-002 are answered.

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-06-07 | Bytes | Created Draft implementation plan from Kiro provider spec |
| 2026-06-07 | Bytes | Reviewed for bead readiness; added pre-bead decisions, split stream/parser work, tightened dependencies and validation |
| 2026-06-07 | invoker | Resolved D-001 as `kirob` and D-002 as upstream-compatible OAuth hooks; promoted plan to Active |
