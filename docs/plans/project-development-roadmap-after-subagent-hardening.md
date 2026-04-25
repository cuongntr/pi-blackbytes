# Project Roadmap After Subagent Hardening

## 1. Purpose

This roadmap describes where `pi-blackbytes` should go after completing the current Subagent Hardening and Quality plan.

The current plan is intentionally conservative: it makes subagents correct, safe, observable, and reliable without turning the project into a full orchestration framework. This roadmap starts from that improved baseline and sequences the larger capabilities that were deliberately excluded from phases 1–2.

Primary goal:

- Evolve `pi-blackbytes` from a hardened tool/subagent extension into a small, high-quality agent runtime layer that remains secure, testable, and lightweight.

Non-goal:

- Do not copy every feature from `pi-subagents`, `oh-my-pi`, or other large extensions. Adopt only the capabilities that fit `pi-blackbytes`' minimal and explicit design.

## 2. Baseline Expected After Current Plan

This roadmap assumes the current hardening plan has already delivered:

- Correct tool allowlists for builtin and YAML subagents.
- Conservative YAML defaults with explicit opt-in for mutating/exec tools.
- Idempotent session startup and clean reset of enabled-set, runtime metadata, and diagnostics.
- User-visible YAML diagnostics in status output.
- Safer nested failure details with truncation.
- Clear `temperature` behavior: either implemented or visibly unsupported/reserved.
- Per-agent timeout support.
- Prompt inheritance machinery with static mode as the safe default.
- Conservative model fallback for read-only agents.
- Optional progress/streaming spike outcome documented.

If any of those remain unfinished, finish them before starting this roadmap.

## 3. Product Direction

`pi-blackbytes` should optimize for:

1. **Explicit capability boundaries** — every tool, subagent, fallback, and isolation mode should be visible and testable.
2. **Small safe primitives** — prefer simple synchronous primitives before async lifecycle managers.
3. **Agent usefulness over feature count** — add features only when they materially improve real coding workflows.
4. **Local-first reliability** — failures should be diagnosable from status output, structured details, and tests.
5. **Minimal dependency growth** — avoid heavy runtime dependencies unless a feature cannot be built safely otherwise.
6. **Prompt-driven workflow** — keep everyday coding workflow in the dynamic Bytes system prompt; roadmap items should add only the runtime support that prompt cannot provide by itself.

## 4. Roadmap Overview

| Horizon | Theme | Outcome |
|---|---|---|
| Phase 3 | Controlled orchestration | Safe read-only parallel delegation, structured results, and capability/status polish |
| Phase 4 | Isolation and side-effect safety | Worktree/sandbox support for write-capable agents |
| Phase 5 | Runtime performance and UX | Optional in-process runner, richer progress, better status |
| Phase 6 | Ecosystem and extensibility | Stable user-agent format, templates, optional cross-extension integration |
| Phase 7 | Long-term intelligence | Agent memory and learning only after safety/isolation exists |

## 5. Phase 3 — Controlled Orchestration

### Goal

Add the smallest runtime primitives needed to support the existing dynamic Bytes workflow. Do not create a separate workflow layer: the system prompt remains the source of truth for context gathering, planning, delegation, verification, review, language matching, and communication style.

### Candidate work

1. **Structured delegate result model**
   - Standardize result status: success, failure, timeout, canceled, skipped.
   - Preserve current Pi tool result shape while keeping internal structured metadata.
   - Include synthesis-friendly metadata where useful: task label, agent name, concise summary, evidence, risks, and suggested next action.

2. **`delegate_parallel` for read-only agents first**
   - Accept a bounded list of tasks.
   - Run only `explore`, `oracle`, `librarian`, and read-only YAML agents initially.
   - Enforce max concurrency and total timeout budget.
   - Return ordered results with per-task status.
   - Require the parent agent to synthesize results instead of forwarding raw nested output.

3. **Capability matrix in status**
   - Show each agent's resolved tool class, model, fallback status, timeout, prompt mode, and write capability.
   - Show enough capability information for the dynamic prompt/status surfaces to stay aligned with actual runtime state.
   - Keep status redacted and prompt-free.

4. **Minimal workflow examples**
   - Keep docs/examples lightweight and tied to existing prompt behavior: exploration fanout, implementation review, design critique, and library research plus local code search.
   - Document when not to parallelize: tiny single-file edits, unclear goals, tasks with shared write targets, or cases where synthesis would cost more than direct work.
   - Avoid duplicating the full Bytes system prompt in roadmap docs.

### Guardrails

- No write-capable parallel agents until isolation exists.
- No background jobs yet.
- No recursive delegation.
- No unbounded fanout.
- Do not introduce runtime workflow modes unless the dynamic prompt cannot express the behavior adequately.

### Acceptance criteria

- Parallel read-only tasks are deterministic and bounded.
- Any task failure is isolated to that task and reported clearly.
- Parent-thread synthesis is concise and structured; raw nested output is not dumped into the final context.
- Partial failure and contradictory-result scenarios are covered by tests or golden examples.
- Capability/status output reflects actual enabled resources and redaction boundaries.
- `delegate_parallel` refuses write-capable agents unless explicitly disabled by design.
- Full verification passes: `bun run lint`, `bun run build`, `bun run test`.

## 6. Phase 4 — Isolation and Side-Effect Safety

### Goal

Make write-capable subagents safer so future parallel/background workflows can include implementation work.

### Candidate work

1. **Git worktree isolation spike**
   - Evaluate whether each write-capable agent can run in a temporary git worktree.
   - Define lifecycle: create, run, collect diff, cleanup.
   - Decide how to handle uncommitted parent changes.

2. **Patch/result handoff model**
   - Instead of letting isolated agents directly mutate the main workspace, collect diffs.
   - Parent agent or user decides whether to apply.
   - Start with `general` only.
   - Include recovery metadata: changed files, validation run, known failures, and whether the diff was applied to the main workspace.

3. **Side-effect-aware fallback for write agents**
   - Only after isolation or patch handoff exists.
   - Do not retry direct workspace writes.

4. **Workspace safety checks**
   - Detect dirty worktree before isolation.
   - Avoid deleting user files during cleanup.
   - Never run destructive git commands without explicit user request.

5. **Recovery workflow**
   - Document how users inspect, reject, or revert agent-produced changes.
   - Prefer patch handoff and explicit apply steps for isolated agents.
   - If host undo APIs are available, evaluate them as UX sugar rather than the primary safety mechanism.

### Guardrails

- Worktree isolation must be optional and off by default until proven stable.
- No FUSE/overlay/ProjFS in this phase unless worktree is insufficient and the extra complexity is justified.
- Do not force users into a branch/worktree workflow.

### Acceptance criteria

- Isolated `general` run can produce a diff without mutating the main workspace.
- Cleanup is safe and tested.
- Dirty-worktree scenarios are handled explicitly.
- Write-agent fallback remains disabled unless isolation is active.
- Users can identify which files an isolated write-capable agent changed and can reject the result without mutating the main workspace.

## 7. Phase 5 — Runtime Performance and UX

### Goal

Improve responsiveness and developer experience without sacrificing the subprocess runner's safety.

### Candidate work

1. **In-process runner evaluation**
   - Investigate `createAgentSession()` or equivalent Pi APIs.
   - Compare subprocess vs in-process on:
     - startup latency
     - tool isolation
     - prompt injection behavior
     - cancellation
     - testability
     - extension compatibility
   - Keep subprocess as default unless in-process is clearly safe.

2. **Runner abstraction**
   - Introduce a small internal interface if needed:
     - subprocess runner
     - optional in-process runner
   - Avoid leaking runner mode into user-facing APIs unless necessary.

3. **Progress and logs UX**
   - If the earlier spike found safe host APIs, expose progress for long-running delegates.
   - Keep nested stdout out of final context by default.
   - Prefer concise progress events over raw streaming.

4. **Startup and tool-result benchmarks**
   - Expand existing benchmarks if needed.
   - Track regression risk for extension load time and nested agent startup.

### Guardrails

- Do not replace the subprocess runner until equivalent security and tests exist.
- Do not stream unbounded output into parent context.
- Preserve package size budget.

### Acceptance criteria

- Runner mode decision is documented with measured tradeoffs.
- If a second runner is added, both modes share tests for timeout, cancellation, failure formatting, and tool allowlists.
- UX improvements do not increase context noise.

## 8. Phase 6 — Ecosystem and Extensibility

### Goal

Make user-defined agents and integrations easier to build while preserving validation and safety.

### Candidate work

1. **Stable user-agent format**
   - Decide whether YAML-only remains enough or whether Markdown + frontmatter is worth supporting.
   - If Markdown agents are added, preserve typed validation and duplicate-name checks.
   - Provide migration docs between YAML and any new format.

2. **Agent templates**
   - Add documented templates for common agent types:
     - read-only researcher
     - code reviewer
     - docs writer
     - test writer
     - implementation worker
   - Templates should encode safe default tools.

3. **Config validation and status polish**
   - Improve diagnostics for invalid config fields.
   - Consider machine-readable status only if command framework support is straightforward.

4. **Optional cross-extension RPC spike**
   - Evaluate whether other Pi extensions should be able to spawn `pi-blackbytes` agents.
   - Keep disabled unless there is a clear consumer.
   - Require explicit allowlist and no secret leakage.

### Guardrails

- No user-defined agent format should bypass schema validation.
- User agents must not override builtin agents silently unless this is an explicit, documented decision.
- Cross-extension RPC is optional and should not become a dependency for core behavior.

### Acceptance criteria

- New user-agent UX is documented and test-covered.
- Invalid custom agents fail visibly but do not crash the session unless they violate global invariants like duplicate names.
- Extension integration remains optional.

## 9. Phase 7 — Long-Term Intelligence

### Goal

Only after orchestration and isolation are mature, explore persistent agent memory and learning workflows.

### Candidate work

1. **Agent memory design doc**
   - Define what memory is allowed to store.
   - Define where it lives.
   - Define how users inspect, edit, disable, or delete it.
   - Define secret redaction and privacy rules.

2. **Read-only memory first**
   - Start with explicit project notes or user-provided agent instructions.
   - Avoid agents silently writing memory.

3. **Memory diagnostics**
   - Status should show whether memory is enabled and which files/sources are used.

### Guardrails

- No hidden memory.
- No automatic storage of prompts, tool outputs, secrets, or private code snippets without explicit design.
- Memory must be inspectable and removable.

### Acceptance criteria

- Memory behavior is transparent and opt-in.
- Tests cover disabled memory, missing memory files, malformed memory, and redaction boundaries.

## 10. Deferred or Probably-Not Items

These should stay out unless a strong use case appears:

- FUSE/overlay filesystem isolation as a first isolation mechanism.
- Full TUI/job dashboard.
- Long-running daemon process.
- Agent marketplace or remote agent registry.
- Automatic prompt optimization from usage telemetry.
- Silent user-agent override of builtin agents.
- Force-push, hard reset, or destructive git automation.

## 11. Suggested Sequence After Current Plan

Recommended next steps after finishing the current hardening plan:

1. Run a short retrospective on the current subagent system:
   - What still fails in real usage?
   - Which agents are actually useful?
   - Which diagnostics were missing during implementation?

2. Implement Phase 3 in small slices:
   - structured delegate result model
   - capability matrix/status polish
   - `delegate_parallel` for read-only agents only
   - lightweight docs/examples for bounded fanout workflows

3. Before any write-capable parallel/background work, complete Phase 4 isolation design.

4. Re-evaluate in-process runner only after subprocess-based orchestration is stable.

5. Treat memory and cross-extension RPC as late-stage optional capabilities, not near-term requirements.

## 12. Success Markers

The project is progressing in the right direction if:

- Users can understand exactly what each subagent can do from status output.
- Read-only fanout improves research and review quality without introducing workspace risk.
- Write-capable agents never run in risky retry/parallel/background modes without isolation.
- Failures are reported with enough detail to fix config, model, or CLI issues quickly.
- The codebase remains small enough that new contributors can understand registration, runner, loader, and status flows in one sitting.
- Tests continue to define the safety contract for tools, recursion, config parsing, diagnostics, fallback, and isolation.
- The dynamic Bytes system prompt remains the source of truth for everyday workflow.
- Roadmap features only add runtime support, safety, and observability around it.

## 13. Roadmap Review Cadence

Review this roadmap after each major phase:

- After Phase 3: decide whether parallel read-only delegation materially improves the existing prompt-driven workflow or whether status/result polish is enough.
- After Phase 4: decide whether background agents become safe and useful.
- After Phase 5: decide whether in-process execution should remain optional, become default, or be abandoned.
- After Phase 6: decide whether ecosystem integration has real users.

Each review should explicitly remove ideas that no longer fit. The roadmap should stay selective rather than accumulate every possible agent-framework feature.
