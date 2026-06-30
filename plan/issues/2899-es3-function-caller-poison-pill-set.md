---
id: 2899
title: "≤ES3: Function `.caller` poison-pill must throw TypeError on set (`bound.caller = {}`)"
status: done
completed: 2026-06-30
priority: high
sprint: current
created: 2026-06-30
feasibility: medium
task_type: bug
area: runtime
es_edition: 3
language_feature: function-caller
goal: spec-completeness
related: [2897]
---

# #2899 — bound-function `.caller` poison-pill does not throw on assignment

One of the **8 tests blocking 100% ≤ES3 conformance**.

## Failing test
`test/language/statements/function/13.2-30-s.js`

→ **`returned 5 — assert #4 at L22: assert.throws(TypeError, function() { bound.caller = {}; })`** — assigning to `.caller` should throw `TypeError`, but doesn't.

## What it checks
`Function.prototype.caller` / `Function.prototype.arguments` are "poison-pill" accessor properties: their `[[Get]]`/`[[Set]]` throw a `TypeError` (especially on a bound/strict function). `bound.caller = {}` must throw. We currently allow the assignment (the property isn't a throwing accessor).

## Root-cause direction
The function-object property model needs `caller`/`arguments` realized as poison-pill accessors (throwing getter+setter) on the relevant functions (bound functions, strict functions). Look at how function objects expose `caller`/`arguments` and the assignment path for those keys. (Technically an ES5-strict semantic that the edition heuristic buckets as ≤ES3.)

## Acceptance
- `bound.caller = {}` (and `.arguments` set/get) throw `TypeError`; the test passes.
- No regression in normal function-property tests.

## Resolution (2026-06-30)
Already fixed on `main` when re-verified against the live tree — the filed
baseline was stale. `test/language/statements/function/13.2-30-s.js` returns
`status: pass` via `runTest262File` (and the runner was sanity-checked to
report `fail` on a deliberately-broken `assert.throws` variant, so the pass is
real, not a false positive).

Root cause of the prior fix: **#2745**. `target.bind(self)` yields a real JS
bound-function exotic (host `Function.prototype.bind`, runtime.ts §`__bind_function`),
which inherits `caller`/`arguments` from `%FunctionPrototype%` as `%ThrowTypeError%`
poison-pill accessors. Member-assignment (`bound.caller = {}`) routes through
`__extern_set_strict` → `_safeSet(strict=true)`, whose `strictAccessorWrite`
path (runtime.ts:4699-4738) walks the prototype chain, finds the inherited
poison-pill setter, runs the write, and **re-throws** the setter's TypeError so
the user's `try/catch` sees it. The get arms throw via the host `__extern_get`
invoking the inherited poison-pill getter.

This PR adds a regression guard (`tests/issue-2899.test.ts`): the four
get/set arms each throw `TypeError`, bound functions have no own
`caller`/`arguments`, ordinary object/function-custom property set/get is
unaffected, plus an end-to-end `runTest262File` check (skipped when the
test262 submodule isn't present). No compiler-source change was required.

Note (out of scope for #2899): a *narrow, separate* quirk surfaced while
probing — reading `bound.caller` inside a nested `(fn: any)` callback that
captures a **module-level** `bound` returns `null` instead of throwing
(the production test262 wrapper declares `bound` *local* to `test()` with a
`() => void` callback, so it is unaffected and the conformance test passes).
Flagged to the lead as a possible follow-up; does not block this issue.
