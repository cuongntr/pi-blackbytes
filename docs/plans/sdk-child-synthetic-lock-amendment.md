# Controlled synthetic lock amendment — pib-2elc.2

User approval: **“Cho phép lock giả lập”**, supplied in this invocation.
Recorded at **2026-09-09T14:24:15+07:00**, from actual `date -Iseconds`.
This is the recording timestamp; the conversation supplies no separate message timestamp.
Frozen [protocol](sdk-child-controlled-rehearsal-protocol.md) and
[change-002 erratum](subagent-mechanism-hardening-change-002-model-identity-erratum.md)
remain byte-unchanged. This supersedes only the receipt-only prohibition for the
following synthetic lock-directory lifecycle, not credential data writes.

## Exact authority

Under one canonical, owned `mkdtemp` fixture root R, the only eligible files are
`R/agent-a/auth.json`, `R/agent-a/settings.json`, and
`R/checkout/.pi/settings.json`. Inventory must enumerate the exact subset actually
prepared, its canonical absolute paths and unchanged SHA-256 content hashes.
The lock allowlist is exactly each enumerated file plus `.lock`, never a glob,
parent-directory grant, decoy agent-b grant, general auth-directory write, or
permission to create other locks. No symlink component, alias, hard-linked data,
real credential source, fallback home or redirected lock is permitted.

Only mkdir (nonrecursive), necessary mtime update, stat and rmdir (nonrecursive)
of those exact empty lock directories are allowed. Record acquired directory
identity, reject pre-existing/unowned/replaced locks, descendants, unexpected files
and all data-write/open/truncate/rename/link/unlink operations. Synthetic auth and
settings content must remain unchanged, including when SDK callers swallow errors.
No stale-lock takeover or recursive cleanup is authorized by this amendment.

Node exact absent-lock-path write grants must first be verified with a tiny owned
disposable no-SDK fixture. Node grants are not operation-specific authority; narrow
sentinels must enforce lifecycle/ownership/empty-directory constraints. Query denied
capabilities only: never attempt forbidden I/O as a smoke test. Capture hashes before
and after, fixed counters, canonical ownership and process-close proof; prove no
owned process remains before final cleanup, locks absent and hashes unchanged.
On uncertainty stop and retain the owned fixture for directed cleanup.

## Gates and handoff

No real credential/settings/trust reads, network, install, external writes, SDK
session/rehearsal, production edits, adoption, live pilot or commit in this unit.
Fixture setup writes only explicitly synthetic initial bytes before hashing;
no auth/settings data writes during lock lifecycle. Prior budgets/cases and all
other sentinel rules remain. Missing unused optional dependencies and sensitive
source-name inventory entries confer no read/load authority: DENY_IF_REQUESTED,
not global gaps solely for being present/absent. Never read sensitive contents.

Candidate inventory/authorization must bind this amendment's actual SHA-256 alongside
protocol + erratum hashes, with change-001 provenance, exact fixture/lock manifest
and build/runtime hashes. Pure tests and core 1282-pass/2-skip evidence do not authorize
SDK execution. `--run` and preload stops remain. Independent parent R2 review and
immutable candidate authorization precede any future execution. Only nonclosed
pib-2elc.2, WP pib-2elc and epic pib-idmm resume in_progress for policy remediation;
closed beads/history are immutable. This is no provider closure or runtime PASS.
