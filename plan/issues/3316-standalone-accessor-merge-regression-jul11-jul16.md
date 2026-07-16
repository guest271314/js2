---
id: 3316
title: "standalone: 4/18 accessor-merge tests regressed between main 026f40f771 (2026-07-11) and f01f7fbb6e (2026-07-16) — illegal cast traps, invisible to CI"
status: ready
sprint: current
created: 2026-07-16
priority: high
feasibility: medium
model: fable
task_type: bug
area: codegen
goal: standalone-mode
related: [2992, 2893]
origin: "found as a documented residual during #2992 slice 5 (fable-mop, 2026-07-16) — not this slice's own regression, flagged for its own triage"
---

# #3316 — accessor-merge regression window, main 026f40f771 → f01f7fbb6e

## Problem

`tests/issue-2992-accessor-merge.test.ts` passed 18/18 (gc + standalone) when
measured on main `026f40f771` (2026-07-11, #2992 slice 3). Re-measured on main
`f01f7fbb6e` (2026-07-16, #2992 slice 5) as a documented-residual check: **4 of
18 standalone cases now fail** — 3 with `illegal cast` traps, 1 with a value
mismatch. Nobody attributed a cause; slice 5's own change is standalone-gated
to the empty-`{}`-widening accessor-define path and does not touch these
cases' shapes (the dynamic-descriptor `var d: any = {get…}; defineProperty(o,
k, d)` + bracket-poisoned-receiver family from slice 3).

**Not caught by CI** — the `quality` job's scoped-suite runs don't include
this file on every PR; it only surfaces when someone happens to re-run it
directly, as slice 5 did as a sanity check.

## Why this matters

`illegal cast` is a Wasm validation-level trap, not a soft semantic
mismatch — something in this window changed either (a) a type/shape
assumption these tests' codegen relies on, or (b) the closure/descriptor
representation the slice-3 accessor machinery (#2893) reads. 5 days and an
unknown number of merged PRs sit in the window; needs a bisect, not a guess.

## Task

1. Confirm the regression reproduces: run `tests/issue-2992-accessor-merge.test.ts`
   on current `main` and identify the exact 4 failing case names + failure
   messages (3× illegal cast, 1× value mismatch — get the specifics).
2. `git bisect` (or manual merge-commit walk) between `026f40f771` and
   `f01f7fbb6e` on this test file only (should be fast — 18 cases, no full
   test262 needed per bisect step) to find the culprit commit/PR.
3. Root-cause the actual mechanism (which representation/assumption broke),
   fix it, and verify all 18/18 pass again standalone + gc.
4. Consider (don't require) whether this test file should get scoped-suite CI
   coverage so a repeat doesn't go silent again — note as a follow-up, not a
   blocker for this issue if it needs its own CI-config discussion.

## Acceptance criteria

- `tests/issue-2992-accessor-merge.test.ts` 18/18 pass (gc + standalone) on
  the fix branch.
- Culprit commit identified and named in this issue file (even if the fix
  itself doesn't revert it — describe what broke and why).
- Zero regressions on the existing #2992 slice 1/3/4/5 test files
  (`tests/issue-2992*.test.ts`) and the adjacent equivalence suites those
  slices validated against.
