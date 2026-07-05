---
id: 3040
title: "array-destructured parameter with a CAPTURED custom-iterable default throws 'Cannot destructure null' (blocks #2664 un-hold)"
status: ready
sprint: current
created: 2026-07-05
updated: 2026-07-05
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: destructuring, parameter-defaults, iterators, closures, async-generator
goal: spec-completeness
related: [3038, 3039, 3023, 2664]
architect_spec: candidate
---

# #3040 — array-destructured param with a CAPTURED custom-iterable default → "Cannot destructure null"

Split out (PARKED) from the #2664 (#3023) un-hold work. This is the **third,
distinct** bug behind #2664's `merge_group` regressions (the first two —
#3038 nested-fn reader-by-ref, #3039 boxed transitive-capture accessor write —
are fixed and landing standalone). It is **NOT** a boxed-capture-accessor bug
and **NOT** async-CPS versioning.

## Symptom / blast radius (blocks the last 2 of #2664's regressions)

The 2 remaining `merge_group` regressions under the #2664 stack are
`language/expressions/async-generator/dstr/{dflt,named-dflt}-ary-init-iter-close.js`.
They use `async function*([x] = iter) { ... }` where `iter` is an outer `var`
holding a custom iterable. Under #2664 the body runs (it's vacuous on main) and
throws **"Cannot destructure 'null' or 'undefined'"**.

## Root cause is NOT async, NOT generator — it is CAPTURED-iterable-as-param-default

Minimal repros (host lane, `setExports` wired — `.tmp/probe-*paramdefault*.mts`):

| # | shape | result |
|---|-------|--------|
| 1 | `function f([x] = [7])` (sync fn, inline **array** default), omitted | **7 ✓** |
| 3 | `function* g([x] = [7])` (sync gen, inline array default), omitted | **7 ✓** |
| 5 | `function f({x} = {x:7})` (object-destructure, inline default), omitted | **7 ✓** |
| 8 | `async function* g([x] = [7])` (async gen, inline array default), omitted | **7 ✓** |
| 10 | `async function* g([x] = [7])`, arg **provided** `[9]` | **9 ✓** |
| 9 | `async function* g([x] = iter)` (async gen, **captured custom iterable**), omitted | **THROW null ✗** |
| 12 | `function* g([x] = iter)` (**sync** gen, captured custom iterable), omitted | **THROW null ✗** |
| 13 | `async function f([x] = iter)` (async **fn**, captured custom iterable), omitted | **THROW null ✗** |
| 11 | `async function* g([x] = {inline custom iterable})` (async gen, **inline** custom iterable), omitted | **0 ✗ (silently wrong)** |

Reading the matrix:
- Sync fn / sync gen / async fn / async gen ALL work with an inline **array**
  default → the param-default-application + array-destructure machinery is fine.
- The failure is triggered by a **custom iterable** default (an object with
  `[Symbol.iterator]`, requiring the iterator protocol to destructure), and is
  **independent of async / generator** (sync-gen #12 and async-fn #13 throw too).
- **Captured** custom-iterable default (#9/#12/#13) → the captured `iter` reads
  as **null** in the param-default-destructure code → "Cannot destructure null".
- **Inline** custom-iterable default (#11) → no throw but **silently wrong** (0),
  i.e. the iterator protocol is not driven for a custom-iterable param default;
  it falls through to a default/zero.

So there are two coupled defects in the **parameter-default initializer** path:
1. **Capture threading**: a variable captured as (part of) a param default is
   not threaded into the param-default-initializer code — it resolves to null.
   (This is param-position capture, likely adjacent to
   `promoteAccessorCapturesToGlobals`' `extraNodes`/paramInits handling and the
   nested-fn capture prepend — the SAME family as #3038/#3039/#2029, but the
   param-default slot, not the body.)
2. **Iterator-protocol destructure in param position**: array-destructuring a
   **custom iterable** (vs a plain array literal) as a param default does not
   invoke `[Symbol.iterator]().next()` — it produces the type default (0/null)
   instead of iterating. Plain array-literal defaults hit a fast/array path that
   masks this.

## Why PARKED (senior-dev STOP-AND-DOCUMENT)

Per the lead's 30-min depth box: this is **silently-wrong-code depth**, not a
small precisely-verifiable fix. It spans (a) capture threading in param-default
initializers and (b) iterator-protocol destructuring in parameter position,
across sync-gen / async-gen / async-fn. Param-default handling is broad-impact
(every defaulted destructured param), so a fix needs full `merge_group`
validation and careful design — it is NOT a scoped tweak. The 2 failing files are
'vacuous-pass → real-fail' (like the #3038 cluster), so a **clean fix is
preferred over a vacuity excuse** (lead's note), but it is a fresh sub-project.

## Acceptance

- All 4 THROW/wrong rows above (#9, #11, #12, #13) return their expected value.
- `async-generator/dstr/{dflt,named-dflt}-ary-init-iter-close.js` pass under the
  #2664 stack (the last 2 of #2664's `merge_group` regressions), so #2664 fully
  un-holds with its genuine +68.
- Full `merge_group` green (param-default is broad-impact — no regressions in
  destructuring-param / default-param / iterator suites).

## Notes for the implementer

- Start from the matrix above; reproduce #9/#11/#12/#13 in `.tmp/`.
- Locate the parameter-default-initializer lowering (where `= <expr>` is emitted
  for a destructured param) and (a) confirm how it resolves a captured name in
  the default expr (the null), (b) confirm whether it routes array-destructure of
  the default through the iterator-protocol path or an array fast path.
- Cross-check against the non-default array-destructure param path (which works)
  and the body-position iterator destructure (which works) to see what the
  param-default path skips.
