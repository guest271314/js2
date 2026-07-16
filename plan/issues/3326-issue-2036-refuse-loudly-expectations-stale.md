---
id: 3326
title: "tests/issue-2036.test.ts: 7 'refuses loudly' expectations are stale — #3169 gave these methods a working native path, they now succeed instead of refusing"
status: ready
sprint: current
created: 2026-07-16
priority: low
feasibility: trivial
task_type: bug
area: codegen
goal: standalone-mode
related: [2036, 3169]
origin: "found as a side-effect of #3317 (array search-method coercion) validation, 2026-07-16 — pre-existing on main, unrelated to #3317 itself"
---

# #3326 — stale refuse-loudly test expectations after #3169

## Problem

`tests/issue-2036.test.ts` documents that borrowed `Array.prototype`
search/result-building methods over an array-like `$Object` receiver had
**no working native standalone path** and must **refuse loudly** (a clean
compile error) rather than emit invalid Wasm or a silently-wrong value.

7 of its cases now fail on unmodified `origin/main` — confirmed via a clean
worktree, not caused by any in-flight PR. Root cause: #3169 (S3,
carrier-agnostic strict-eq/truthiness/concat for `$AnyValue` union locals)
gave these methods enough of a working native path that they now **succeed**
instead of refusing — a genuine improvement, but it makes the test's "must
refuse loudly" assertions wrong for those 7 cases. Not caught by CI because
this test file isn't in any scoped-suite CI run.

## Task

1. Reproduce: run `tests/issue-2036.test.ts` on current `main`, identify the
   exact 7 failing cases.
2. For each, confirm the method now genuinely produces the CORRECT result
   (not just "doesn't refuse" — verify actual correctness), then update the
   test's expectation from "refuses loudly" to the correct success case.
3. Leave any remaining genuinely-still-unimplemented cases as-is (don't
   force all 45 to pass if some still lack a native path).

## Acceptance criteria

- `tests/issue-2036.test.ts` passes in full, with expectations reflecting
  the current (post-#3169) real behavior — refusals only where a native
  path genuinely still doesn't exist.
