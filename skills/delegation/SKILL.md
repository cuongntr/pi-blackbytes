# Delegation Guide

Blackbytes exposes four delegate tools. Each one runs a nested Pi session with a role-specific prompt and a runtime-enforced tool allowlist.

---

## Shared rules

- Delegate sessions inherit the parent working directory.
- Delegate sessions only receive the tools allowed for that role and still respect the parent session's disabled-tool settings.
- Nested delegation is capped at one level. A child session does not receive `delegate_*` tools again.
- The right delegate is chosen by task shape, not by preference.

---

## `delegate_explore`

**Access:** Read-only local discovery

Use it for:

- locating files, symbols, and call sites
- answering “where is X implemented?”
- understanding unfamiliar local code structure
- running several parallel discovery passes without spending main-context budget

Avoid it for:

- known-file edits
- questions that one direct grep/read call can answer
- external library research

---

## `delegate_oracle`

**Access:** Read-only elevated reasoning

Use it for:

- difficult debugging after multiple failed attempts
- architecture tradeoffs with non-obvious consequences
- security or performance analysis that needs careful reasoning
- subtle cross-component interactions where retrieval alone is not enough

Avoid it for:

- straightforward questions
- routine implementation choices
- simple codebase lookup work

---

## `delegate_librarian`

**Access:** Read-only local + web/docs research

Use it for:

- understanding external library APIs or internals
- querying official documentation via Context7
- finding real-world examples with `gh_search`
- comparing patterns across public repositories

Avoid it for:

- local implementation tasks
- repository-only discovery that `delegate_explore` already covers well

---

## `delegate_general`

**Access:** Full execution within the enabled session toolset

Use it for:

- multi-file implementation work
- broad refactors with a clear plan
- repetitive migrations or boilerplate generation
- execution-heavy tasks where the plan is already settled

Avoid it for:

- exploratory research
- hard architecture decisions that should be clarified first
- tiny one-file edits

---

## Quick selection guide

```text
Need to find code in this repo?          -> delegate_explore
Need deep reasoning on a hard problem?   -> delegate_oracle
Need docs or open-source examples?       -> delegate_librarian
Need a large well-defined implementation? -> delegate_general
```
