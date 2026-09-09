# Change 002 — Model identity API erratum

**Status: Active technical erratum — 2026-09-09; documentation/tracker only.**
Source/design: [approved change-001](subagent-mechanism-hardening-change-001-sdk-child-launcher.md#7-activation-and-superseding-routing-decision--2026-09-09),
[approved controlled protocol](sdk-child-controlled-rehearsal-protocol.md).

## Authority and narrowly superseded prose

This records the supplied independent Oracle API adjudication within the user's already-approved
exact-model/still-installed-wrapper boundary. It is not a material architecture change, a new
invoker approval, a gate waiver, or implementation/rehearsal evidence. Change-001 §7 approval and
its routing/gates remain authoritative; no architecture reapproval is required for this correction.

Superseded **only**: change-001 §2.2's fresh-registry-object equality (including
`session.model === admittedObject === services.modelRuntime.getModel(provider,id)`), associated
session/registry identity wording, and equivalent normative clauses in current execution briefs.
The protocol's Q-02/Q-03 prose and C06 are clarified below, not rewritten. Frozen change-001,
protocol, baseline plan/spec and closed contract bead `pib-2elc.1` remain historical originals.
The current v1 codec/schema contract is unaffected; its closed codec/review evidence remains valid.
Other Q-01–04 obligations, classifications and delivery gates are unchanged.

## API evidence and provenance

Preflight evidence: `/tmp/pib-2elc.2-baseline-I8SOdj/BLOCK.md` and
`/tmp/pib-2elc.2-baseline-I8SOdj/identity-proof.json`. The latter is an isolated pure-function
proof on installed Pi 0.83.0: two calls, same tuple true, same object false; zero SDK imports,
sessions, provider/tool/auth/network calls. It is **not** an SDK runtime rehearsal receipt.

The supplied independent Oracle confirmed the source chain on Pi **0.83.0 and 0.85.1**:
services' actual `modelRuntime.getModel/getModels` path delegates to pi-ai `Models`, which invokes
provider `getModels` anew; the legacy custom-provider composer calls `applyExtension` and builds
new model objects on each lookup. Thus ordinary services with legacy model definitions exercise
this path, not merely a detached registry or hypothetical API. Repeated fresh lookup identity
cannot distinguish normal composition from mutation. Source references in BLOCK.md are inspection
citations, never permission for production private imports. The 0.85.1 confirmation is source
inspection, not an executed runtime cell. No SDK was imported or rehearsed by this erratum unit.

## Corrected normative admission contract

1. After ordinary `createAgentSessionServices` resource loading and factory provider registration,
   obtain `admittedObject` **once** using `services.modelRuntime.getModel(provider,id)` for the
   immutable literal tuple. Require that object's tuple to match and the tuple to exist in
   `getModels()` and `getAvailableSnapshot()`, with configured-auth evidence via the public API.
   Missing/filtered/unavailable fails closed. Pass **that same object** to
   `createAgentSessionFromServices`, never a copied, synthesized, reparsed or undefined model.
2. Keep the owned wrapper CLOSED before binding; await startup and initiated-run settlement.
   Before opening, require `session.model === admittedObject`, matching immutable tuple,
   current exact-tuple catalogue membership/cached availability/configured auth, exact active
   tools and all existing gate/latch/ownership postconditions.
3. Before every forwarded request require **both** `session.model === admittedObject` and
   `requestModel === admittedObject`, and both objects' tuple equal to the immutable tuple.
   Recheck current catalogue and cached availability/auth **by exact tuple, not fresh lookup
   object identity**. Do not recapture/replace the admitted object. Forward original arguments
   unchanged only if all existing checks pass; preserve permanent nonthrowing refusal latch and
   `provider_or_model_unavailable` for identity/tuple/availability/auth refusal.
4. Reject same-tuple **session or request object replacement**, tuple mutation, selected tuple
   removal/change in the catalogue, and lost cached availability/configured auth. Normal
   recomposition into fresh catalogue objects for the same tuple is not a violation. Hidden
   same-tuple provider semantic replacement leaving the session/admitted object untouched cannot
   be detected by this boundary. Same-object endpoint mutation, upstream routing, payload rewrites,
   arbitrary trusted-extension direct calls and wrapper bypass remain outside the existing guarantee.
5. No fingerprints, deep equality, registry memoization, private generations/internal APIs,
   extra getAuth/checkAuth/refresh/network admission probes, model reset, or native-provider-only
   fixture substitution. No new sandbox, privileges, resources, budgets or endpoint attestation.

## Existing protocol cases and candidate-review gate

C01/C08 ordinary-services legacy custom-provider positive fixture must demonstrate that repeated
public lookups return distinct objects with the same tuple while the captured admitted object
is passed to the factory and a valid guarded request succeeds (selected counter positive,
decoy zero). This clarifies the existing successful custom-provider cases, not a new case/resource.
C06's “same-tuple replacement” means session/request object replacement; “registry replacement”
means observable loss/change of the selected tuple, not routine fresh catalogue objects or hidden
same-tuple provider semantic substitution. Startup and before-request negatives retain latched
refusal, no model repair and zero forwarded calls. Other C01–C20 cases/applicability remain unchanged.

The **unchanged approved protocol authority applies with this API clarification**. Before any SDK
rehearsal (including the ordinary-services positive fixture), implement the candidate, run pure/
injected checks and full repository checks, then record independent R2 candidate review, immutable
launcher/fixture/build hashes and pre-existing supported SDK-root inventory. The parent-owned
candidate review record must cite **both the approved protocol and this erratum, with their actual
SHA-256 hashes**; also retain change-001 provenance. No pre-review SDK runtime shortcut is permitted.
The protocol's executor/reviewer disposition, sentinels, approved roots, cases, serial execution,
10-second case budget plus existing 5000ms drain, 20-minute suite cap, no safety retries, bounded
receipts, stops and cleanup all remain unchanged. No broadened cases/resources/budgets or new
execution approval is inferred. Missing runtime cells remain NOT RUN, not source-derived PASS.

Frozen reference hashes (SHA-256):
- Change-001: `9f00b7bfa73b0ba18d1d182ce5d89d129c1656f47d1d1044ede7b1f4bf8300a4`.
- Approved protocol: `9aa27798ff9206759a29c15f335f604ccf0db03e56866aeaf21733ebc72ae2d1`.
- Compute this erratum's hash from its final bytes when recording candidate review; no self-hash.

## Tracker handoff

Only nonclosed affected briefs receive this Source/Design erratum reference and self-contained
constraints: `pib-2elc.2` (producer), `pib-2elc.3` (adoption), `pib-2m0i` (join), `pib-ll8n`
(integration/security), `pib-4bsc` (compatibility), `pib-04hc` (operational limits).
`pib-2elc.2` stays **in_progress**: the fresh-registry-identity preflight contradiction is resolved
at specification level, not delivered or runtime-proven. No parent blocked status is implied.
No new nodes/edges/status transitions; closed contract/protocol, four closed Phase 3a leaves,
WP-001 and all 212 historical records remain untouched. Implementation, candidate review and
applicable rehearsal receipts are subsequent work; this unit runs none of them.
