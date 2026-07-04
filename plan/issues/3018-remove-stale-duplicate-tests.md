---
id: 3018
title: "chore: remove 76 stale duplicate root-level test files orphaned by the tests/equivalence/ migration (broken ./helpers.js import, never run)"
status: done
sprint: 69
priority: low
created: 2026-07-03
completed: 2026-07-03
assignee: ttraenkler/agent-ab81b787ac6992334
feasibility: low
reasoning_effort: low
task_type: chore
area: tests
language_feature: n/a
goal: quality-infra
related: [3008, 2767]
horizon: s
---

# #3018 — remove stale duplicate root-level test files (orphaned by the tests/equivalence/ migration)

## Finding

76 test files at the `tests/` root import `assertEquivalent` (and friends) from
`"./helpers.js"`. That path does **not** resolve — the equivalence helpers were
moved to `tests/equivalence/helpers.ts` — so every one of these files **fails at
collection time** ("Failed to load url ./helpers.js") and contributes **zero
assertions**. They have silently not run for a long time.

They are **stale duplicates left behind by an incomplete migration**: each of
the 76 has a live counterpart at `tests/equivalence/<same-name>` (which imports
`./helpers.js` correctly because it sits inside `tests/equivalence/`). Verified:

- **all 76** have a `tests/equivalence/` counterpart,
- **70** are byte-identical to their counterpart (modulo the import path),
- **6** differ, and in every case the live `tests/equivalence/` version
  supersedes the root one (5 are strictly larger / extended after the migration;
  `json-stringify.test.ts` differs only in test-title wording — the live titles
  reflect current boolean-branding behaviour, the root titles are stale).

Because the root files never collect, deleting them **cannot reduce active
coverage** — the `tests/equivalence/` copies are what actually run under the
`tests/**/*.test.ts` include. This is the scaled-up form of the secondary
symptom documented in #3008 ("a per-issue file broken at load time contributes
zero assertions and never flags").

## Change

`git rm` the 76 stale root-level duplicates. No source changes; the live
`tests/equivalence/*` copies are untouched and continue to run.

## Acceptance criteria

- The 76 stale root-level `*.test.ts` duplicates are removed.
- No remaining root-level `tests/*.test.ts` imports a non-existent
  `./helpers.js`.
- The live `tests/equivalence/` counterparts still collect and run.
- No test262 / required-gate regression (pure dead-file deletion; nothing
  imports these files).

## Follow-up (out of scope here)

The broader #3008 decision — whether `tests/issue-*.test.ts` / a curated subset
should be a **required** blocking check, plus a collection-error guard that fails
CI when any `tests/**/*.test.ts` errors at import time — remains open under
#3008. This chore only removes the dead duplicates that pollute the collection.
