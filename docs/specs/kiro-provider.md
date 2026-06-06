# Blackbytes Kiro Provider — Product + Technical Spec

> **Status**: Accepted
> **Date**: 2026-06-07
> **Owner**: invoker
> **Variant**: brownfield (adds a bundled Pi model provider to the existing extension)
> **Source / Motivation**: investigation of `pi-provider-kiro@0.8.0`, Pi custom-provider docs, Kiro CLI auth docs, and local Kiro token/cache behavior
> **Related docs**: [`README.md`](../../README.md), [`AGENTS.md`](../../AGENTS.md)

---

## 1. Context

`pi-blackbytes` intentionally owns local integrations when that makes auth, config, error handling, rendering, or maintenance easier. Kiro is currently consumed through the separate `pi-provider-kiro` package, but that creates two maintenance problems:

1. Kiro-specific rate-limit behavior needs provider-local handling. Pi's generic retry path is not tuned for Kiro `429` throttle windows, while `kiro-cli` can often continue after waiting longer.
2. Multi-account usage is awkward. The upstream provider registers a single provider name (`kiro`) and reads one active credential source (`~/.aws/sso/cache/kiro-auth-token.json` or active `kiro-cli` SQLite auth). Pi auth storage is provider-name scoped, so one `kiro` namespace is not enough for isolated personal/work accounts.

This feature adds an optional bundled Kiro provider surface in Blackbytes. The design favors maintainability over patching installed packages: copy only the provider logic Blackbytes needs into `src/providers/kiro/`, preserve upstream-compatible auth behavior, and add account alias registration plus Kiro-local retry.

## 2. Goals and Success Metrics

- **Maintainable provider ownership**: Kiro provider code lives in this repo, with tests and docs, not as edits to installed `node_modules`.
- **Provider-local Kiro retry**: transient HTTP `429` responses use Kiro-specific backoff without changing global Pi retry behavior.
- **Safe multi-account use**: users can register distinct provider aliases such as `kiro_personal` and `kiro_work`, each isolated by provider name/config.
- **Kiro CLI/IDE compatibility**: default single-account behavior can still reuse existing Kiro IDE / `kiro-cli` credentials.
- **Secret hygiene**: tokens, refresh tokens, API keys, client secrets, and authorization headers are never logged or displayed by `/blackbytes-status`.

Measurable acceptance:

- At least two configured Kiro aliases can be registered in one session with separate provider names and model IDs.
- Provider-local `429` retry respects `Retry-After` when present, aborts on `AbortSignal`, and does not retry quota exhaustion (`MONTHLY_REQUEST_COUNT`).
- Capacity failures (`INSUFFICIENT_MODEL_CAPACITY`) remain separate from rate-limit retry and keep their own budget.
- Existing default provider behavior is unchanged when `blackbytes.kiro.enabled !== true`.
- `bun run lint && bun run typecheck && bun run build && bun run test` passes.

## 3. Personas / Users

- **Primary — maintainer using multiple legitimate Kiro accounts**: switches between personal/work Kiro subscriptions without editing installed packages or manually swapping token files.
- **Secondary — long-running Pi user on Kiro**: expects Kiro transient throttles to be retried locally in a way that matches Kiro's service behavior.
- **Tertiary — Blackbytes maintainer**: needs provider code to be testable, redacted, config-gated, and isolated from unrelated Blackbytes tools/sub-agents.

## 4. User Journeys

### Journey 1 — Enable one bundled Kiro provider from existing credentials

1. User logs in with Kiro IDE or `kiro-cli` as usual.
2. User sets `blackbytes.kiro.enabled=true` and leaves `accounts` empty.
3. On the next Pi session, Blackbytes registers one provider alias, defaulting to `kirob` (`Kirob` user-facing label).
4. The provider reads existing Kiro credentials and exposes Kiro models in `/model` and `/setup-models`.

### Journey 2 — Use personal and work Kiro accounts simultaneously

1. User configures two Kiro account aliases under `blackbytes.kiro.accounts`.
2. Each alias registers as an independent Pi provider name, for example `kiro_personal` and `kiro_work`.
3. User can choose `kiro_personal/<model>` or `kiro_work/<model>` without overwriting the other account's Pi auth namespace.
4. `/blackbytes-status` shows aliases and credential source types, but not secret values.

### Journey 3 — Kiro returns transient throttling

1. Kiro responds with HTTP `429` during streaming.
2. The provider reads `Retry-After` if present, otherwise uses bounded exponential backoff with Kiro-specific defaults.
3. The provider retries only if the body is not a known quota exhaustion pattern.
4. If all retries fail, the user sees an honest Kiro-specific error; no global retry policy is changed.

## 5. Requirements

### REQ-001 — Config-gated bundled Kiro provider

Priority: P0

Acceptance criteria:

- Adds typed config under `blackbytes.kiro` with `enabled`, `accounts`, retry options, and safe defaults.
- Does not register any Kiro provider unless explicitly enabled.
- Preserves `BlackbytesConfigSchema.passthrough()` behavior for unknown keys.
- `/blackbytes-status` redacts all Kiro secrets and summarizes aliases safely.

### REQ-002 — Provider alias registration for account isolation

Priority: P0

Acceptance criteria:

- Supports registering multiple configured provider aliases in one `session_start`.
- Provider aliases are validated as safe Pi provider IDs and must be unique.
- Each alias has independent credential resolution and model metadata.
- Default model/provider selection surfaces such as `/setup-models` naturally group by alias/provider name.

### REQ-003 — Credential source compatibility

Priority: P0

Acceptance criteria:

- Supports existing Kiro IDE token source (`~/.aws/sso/cache/kiro-auth-token.json`) for the default account.
- Supports existing `kiro-cli` SQLite credential source for the default account.
- Supports alias-specific credential source configuration without requiring token-file mutation as the normal path.
- Preserves unknown auth fields when refreshing credentials stored outside Pi auth where applicable.

### REQ-004 — Provider-local rate-limit and capacity retry

Priority: P0

Acceptance criteria:

- HTTP `429` retries are implemented inside the Kiro provider stream path.
- `Retry-After` header is respected when present; otherwise a bounded exponential backoff is used.
- `AbortSignal` cancels sleeps and in-flight retries.
- `MONTHLY_REQUEST_COUNT` and other configured non-retryable quota patterns are not retried.
- `INSUFFICIENT_MODEL_CAPACITY` remains a separate retry path with a separate budget.

### REQ-005 — Upstream-compatible Kiro model and request behavior

Priority: P0

Acceptance criteria:

- Uses Kiro endpoint shape compatible with `https://q.<region>.amazonaws.com/generateAssistantResponse`.
- Resolves API region from credential/config with `us-east-1` default.
- Preserves model list behavior or uses a documented static fallback when live model refresh is unavailable.
- Does not weaken existing tool-use/event parsing behavior copied from upstream provider.

### REQ-006 — Documentation, tests, and rollback

Priority: P1

Acceptance criteria:

- README and AGENTS config docs describe the bundled provider, multi-account aliases, retry behavior, and rollback.
- Unit tests cover config parsing, alias validation, redaction, credential source selection, and retry classification.
- Integration tests cover provider registration enabled/disabled and multiple aliases.
- Rollback is a config change: set `blackbytes.kiro.enabled=false` and use the external provider if desired.

## 6. Roadmap Phases

### Phase 1 MVP — bundled provider aliases + Kiro-local retry

Exit criteria:

- Default Kiro provider alias `kirob` registers only when `blackbytes.kiro.enabled=true`.
- Two configured aliases can coexist in one Pi session with isolated provider names.
- Kiro-local `429`/capacity retry behavior is implemented, bounded, abortable, and tested.
- Docs describe setup, limitations, and rollback.

### Phase 2 MVP — account-management convenience (deferred)

Exit criteria:

- Optional commands or helpers can import/list account snapshots without mutating active Kiro CLI/IDE token files by default.
- Any account switching or rotation behavior is explicitly policy-reviewed and documented before implementation.

## 7. Non-Functional Requirements

- **Security**: do not print access tokens, refresh tokens, client secrets, API keys, or authorization headers. Treat token-file paths as potentially sensitive only when explicitly user-provided.
- **Reliability**: retry only known transient Kiro failures; do not hide quota exhaustion or authentication failures behind long retry loops.
- **Maintainability**: provider modules should be small and separated by concern: config, auth, retry, stream/event parsing, models, registration.
- **Compatibility**: no behavior change for existing Blackbytes users unless the Kiro provider is enabled.
- **Package budget**: no new runtime dependency unless justified by a follow-up ADR/spec; prefer built-in `fs`, `path`, `fetch`, and small helpers.

## 8. Out of Scope

- Circumventing Kiro quotas, bans, or account association controls.
- Automatic account rotation to evade rate limits or monthly usage limits.
- Mutating Kiro IDE or `kiro-cli` active token files as the default multi-account mechanism.
- Building a full GUI account manager.
- Changing Pi core OAuth storage behavior.
- Replacing all external model providers with Blackbytes-managed providers.

## 9. Technical Design

### 9.1 Boundaries

This design owns:

- Blackbytes config and registration for bundled Kiro provider aliases.
- Kiro auth source resolution and safe refresh helpers used by the provider.
- Kiro stream request/event parsing and provider-local retry.
- Status redaction and documentation for this provider.

This design does not own:

- Kiro service behavior, quota policy, or account enforcement.
- Pi core provider registry internals beyond `pi.registerProvider(...)`.
- Kiro CLI's own login/logout/session storage behavior.
- Global Pi retry behavior.

### 9.2 Architecture

```text
src/config/schema.ts
  └─ blackbytes.kiro config schema + resolver

src/providers/kiro/
  ├─ register.ts          # session_start registration of aliases
  ├─ config.ts            # account normalization + validation
  ├─ auth.ts              # credential source resolution + refresh
  ├─ cli-auth.ts          # kiro-cli SQLite / IDE token readers
  ├─ retry.ts             # 429/capacity/non-retryable classification
  ├─ stream.ts            # streamSimple implementation
  ├─ event-parser.ts      # Kiro response event parsing
  ├─ models.ts            # static/cached model definitions
  └─ redaction.ts         # safe status/log summaries

src/handlers/index.ts
  └─ session_start calls registerKiroProviders(pi, config)

src/commands/blackbytes-status.ts
  └─ config redaction + optional Kiro provider summary
```

The registration entry point mirrors the existing `registerCopilotHeader()` pattern but supports multiple account aliases.

### 9.3 Config / Data Model

No database migration is needed. The data model is Blackbytes JSON config plus optional credential source references.

Proposed config shape:

```ts
interface KiroConfig {
  enabled?: boolean;
  default_provider?: string; // default: "kirob"
  retry?: {
    rate_limit_max_retries?: number; // default: 3
    rate_limit_base_delay_ms?: number; // default: 10_000
    capacity_max_retries?: number; // default: 3
    capacity_base_delay_ms?: number; // default: 5_000
  };
  accounts?: KiroAccountConfig[];
}

interface KiroAccountConfig {
  id: string; // user-facing account id, e.g. "personal"
  provider: string; // Pi provider id, e.g. "kiro_personal"
  region?: string; // default: "us-east-1"
  credential_source?:
    | { type: "kiro_ide"; token_path?: string }
    | { type: "kiro_cli"; db_path?: string; auth_method?: "idc" | "desktop" | "auto" }
    | { type: "pi_oauth" }
    | { type: "api_key"; env?: string; value?: string };
}
```

Validation rules:

- `provider` must be a safe provider identifier (`[a-zA-Z0-9._-]+`) and unique across accounts.
- `id` must be non-empty and unique across accounts.
- Secret inline values are allowed only for explicit `api_key.value`, are redacted everywhere, and should be documented as less preferred than env vars.
- When `enabled=true` and `accounts` is empty, register one default account `kirob` using existing IDE/CLI credential discovery plus upstream-compatible OAuth hooks.

### 9.4 Provider API / Public Contract

Provider registration uses Pi's custom provider surface:

```ts
pi.registerProvider(account.provider, {
  baseUrl: `https://q.${region}.amazonaws.com/generateAssistantResponse`,
  api: "kiro-api",
  models: kiroModelsFor(account),
  oauth: {
    name: `Kiro (${account.id})`,
    login,
    refreshToken,
    getApiKey: (cred) => cred.access,
    getCliCredentials,
    modifyModels,
    fetchUsage,
  },
  streamSimple: streamKiro,
});
```

Backward compatibility:

- External `pi-provider-kiro` can still be installed and used separately if the Blackbytes provider is disabled or uses non-conflicting provider aliases.
- The default Blackbytes provider name is `kirob`, so it avoids clobbering upstream `kiro` unless the user explicitly configures a colliding alias.

### 9.5 Credential Resolution

Credential resolution order for a configured account:

1. Explicit account credential source (`api_key`, `pi_oauth`, `kiro_ide`, `kiro_cli`).
2. Default Kiro IDE token path when source is omitted.
3. Default `kiro-cli` SQLite auth path when IDE credentials are unavailable.
4. Pi OAuth login flow for that provider alias.

Multi-account principle:

- Do not treat Kiro CLI's active browser session as multi-account storage. Kiro CLI has one active browser session precedence path; account isolation is provided by separate Blackbytes provider aliases and explicit source references.
- Avoid writing `~/.aws/sso/cache/kiro-auth-token.json` or `kiro-cli` SQLite rows just to switch accounts. If a future workflow needs import/snapshot support, add it as a separate spec/change.

### 9.6 Retry / Reliability

Retry classification:

- Retry HTTP `429` only when response body does not match non-retryable quota patterns such as `MONTHLY_REQUEST_COUNT`.
- Retry `INSUFFICIENT_MODEL_CAPACITY` on its own capacity budget.
- Do not retry authentication errors, malformed requests, unsupported models, or too-large request errors unless an existing Kiro-specific path already handles them safely.

Backoff:

- If `Retry-After` is a valid seconds or HTTP-date value, use it with an upper bound.
- Otherwise use exponential backoff from `rate_limit_base_delay_ms`, capped at 30 seconds by default.
- All delays are abortable.

### 9.7 Security

- Extend redaction keys to include `token`, `access_token`, `accessToken`, `refresh_token`, `refreshToken`, `client_secret`, `clientSecret`, `api_key`, `authorization`, and Kiro API key aliases.
- Never include credential JSON in thrown errors or debug logs.
- `/blackbytes-status` may show provider alias, account id, region, and credential source type; it must not show token values or client registration secrets.

### 9.8 Sequence Diagram

```text
session_start
  -> loadBlackbytesConfig()
  -> registerKiroProviders(pi, config)
    -> normalizeKiroConfig(config.kiro)
    -> for each account alias
      -> pi.registerProvider(alias.provider, providerOptions)

model request using alias
  -> Pi invokes streamSimple
  -> resolve credentials for alias
  -> POST generateAssistantResponse
  -> if 429 transient: abortable backoff + retry same request
  -> if capacity transient: capacity backoff + retry same request
  -> parse Kiro events -> stream content/tool events to Pi
```

### 9.9 Testing Strategy

Use the project test stack: `node:test`, `node:assert/strict`, and existing Pi mocks.

- Unit tests for config normalization, provider alias validation, redaction, retry delay parsing/classification, and credential source precedence.
- Stream tests with mocked `fetch` for `429`, `Retry-After`, quota body, capacity body, abort behavior, and success after retry.
- Registration integration tests with `src/test-utils/pi-mock.ts` for disabled, default account, and two aliases.
- Status tests to verify Kiro config is redacted and summaries remain useful.
- Final verification: `bun run lint && bun run typecheck && bun run build && bun run test`.

### 9.10 MVP Scope Summary

Phase 1 MVP includes REQ-001 through REQ-006, with the multi-account model implemented as provider aliases and upstream-compatible OAuth hooks preserved. Account import/snapshot management and automatic rotation are explicitly out of scope.

## 10. Migration / Rollback

Migration:

- No database migration.
- Existing users are unaffected until `blackbytes.kiro.enabled=true`.
- Users can keep external `pi-provider-kiro` installed while testing Blackbytes aliases if provider names do not collide.

Backward compatibility:

- Existing Blackbytes tools, sub-agents, and web/docs providers are unchanged.
- `/setup-models` continues to consume Pi's available model registry; it does not need to store provider credentials.

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

If rollback is needed, disable the bundled provider and continue using the external `pi-provider-kiro` package or another model provider.

## 11. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | Upstream `pi-provider-kiro` changes Kiro request/auth shape | Keep copied code isolated under `src/providers/kiro/`; document upstream version/source; add tests around request shape — owner: invoker | open |
| R-002 | Provider alias `kiro` conflicts with external provider | Default alias resolved to `kirob`; still test explicit collision handling — owner: invoker | mitigated |
| R-003 | Alias-specific token files may become stale if Kiro CLI refreshes only in memory | Prefer Pi OAuth/env API key or explicit refresh helpers; document stale-token failure and recovery — owner: invoker | open |
| R-004 | 429 retry could mask true quota exhaustion | Maintain non-retryable body patterns and cap attempts strictly — owner: invoker | open |
| R-005 | Inline API key values in settings are risky | Prefer env var source; redact aggressively; document inline values as last resort — owner: invoker | open |
| Q-001 | Should the default provider name be `blackbytes-kiro` or `kiro`? | Answered as `kirob` (`Kirob` user-facing label) — owner: invoker | answered |
| Q-002 | Which credential source should be first for default account: IDE token or `kiro-cli` SQLite? | Use documented order: explicit source, default Kiro IDE token, default `kiro-cli` SQLite, then Pi OAuth — owner: invoker | answered |

## 12. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-06-07 | Bytes | Created Draft spec from provider/multi-account investigation |
| 2026-06-07 | invoker | Accepted default provider alias `kirob` and upstream-compatible OAuth hooks for Phase 1 |
