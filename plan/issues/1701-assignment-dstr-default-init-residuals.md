---
id: 1701
title: "Assignment destructuring residuals — empty pattern + non-iterable RHS + iterator close"
status: done
created: 2026-05-28
updated: 2026-05-28
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring
goal: spec-completeness
sprint: 54
owner: dev-1701
related: [1553, 1431, 1592, 1620]
---
# #1701 — Assignment destructuring residuals

> Sub-area distinct from #1553 (declaration destructuring). This issue covers
> the **assignment** form `[a, b] = rhs` and `({x} = rhs)` — where `a/b/x` are
> already-declared bindings. Tracked at
> `test262/test/language/expressions/assignment/dstr/*`.

## Failure surface

143 failing tests today (227 pass, 370 total under `assignment/dstr`).
Distribution after re-running against current main via the test262 wrapper:

| Bucket                                         | Count | Notes |
|------------------------------------------------|-------|-------|
| `returned 2` (first assertion failed)          | 69    | Bulk — see breakdown below |
| `returned 1` (PASS — baseline drift)           | 19    | Baseline cache is stale; rerun will reclaim |
| CE: `Type 'X' is not assignable to type 'void'`| 7     | TS strictness rejects valid JS test bodies |
| CE: iterator-literal shape mismatch            | 8     | TS strictness on `{ next: () => {...} }` |
| CE: Left side of comma operator unused         | 6     | TS strictness on `0, [...] = ...;` pattern |
| RUNERR: `undefined is not a function`          | 5     | Iterator protocol gaps (cascade to #1620) |
| RUNERR: `it.next is not a function`            | 4     | Same |
| RUNERR: `illegal cast`                         | 3     | Cascade to #1529 |
| other CE / runtime errors                      | 4     | Long tail |

19 "returned 1" entries are already passing — the cache file is stale relative
to current main, so the *real* current-state fail count is ~124.

## Root cause(s) — localized

Two distinct spec defects in `src/codegen/expressions/assignment.ts`:

### Defect A — `[] = primitive` does not throw (3 tests + part of `array-elision-val-*`)

Per ECMA-262 §13.15.5.2 ArrayAssignmentPattern Runtime Semantics, step 1
always calls `GetIterator(value)` regardless of pattern length. For boolean /
number / Symbol RHS, this throws TypeError ("X is not iterable"). Our
`compileExternrefArrayDestructuringAssignment` only calls `__array_from_iter_n`
when `target.elements.length > 0` (assignment.ts:1385), so an empty pattern
`[] = true` (and a Elision-only pattern `[,] = 1`) silently succeed.

Furthermore, when the RHS resolves to a non-externref/non-ref primitive in
`compileArrayDestructuringAssignment` (assignment.ts:1039–1057), we box the
number to externref via `__box_number` and recurse — but the null guard at
L1370 only triggers for `ref.is_null`. A boxed `true` (i32) is not null, so
no throw fires. This bucket sits at ~5 tests directly + part of
`array-elision-val-{num,symbol}.js` (covered by the same fix).

### Defect B — `{} = undefined` / `{} = null` does not throw (2 tests)

Per ECMA-262 §13.15.5.2 ObjectAssignmentPattern step 1: `RequireObjectCoercible(value)`
is called BEFORE walking properties. For empty `{}`, this still throws when
value is null/undefined. Our `compileDestructuringAssignment` guard at
assignment.ts:504 is gated on `target.properties.length > 0`, so empty
patterns bypass the throw. The carve-out (#225) was over-broad — empty
ObjectAssignmentPattern still RequireObjectCoercible.

## Acceptance criteria

1. `[] = true` throws TypeError. *(was: silently succeeded)*
2. `[] = 5` throws TypeError. *(was: silently succeeded)*
3. `[] = Symbol()` throws TypeError. *(was: silently succeeded)*
4. `{} = undefined` throws TypeError. *(was: silently succeeded)*
5. `{} = null` throws TypeError. *(was: silently succeeded)*
6. `[] = []` continues to succeed and return the empty array. *(no regression)*
7. `{} = {}` continues to succeed and return the empty object. *(no regression)*
8. `[a] = [1]` and `({x} = {x:1})` continue to work. *(no regression)*

## Out of scope (deferred)

- **Iterator close on rest-element abrupt completion** (~13 tests,
  `array-elem-trlg-iter-{list,rest}-{nrml,rtrn,thrw}-close-*`). Requires
  threading IteratorClose into the rest-binding emission path — sister of #1592,
  too large for this PR.
- **Negative parse tests** (`array-rest-before-elision`, etc.) — TypeScript
  parser already accepts these; making the compiler reject them would be a
  separate parse-validation pass.
- **TS-strictness CE bucket** (~21 tests). The test262 sources include
  patterns that TypeScript's checker rejects under our default settings
  (`0, [] = bool;` triggers "unused comma side-effect"; `{ next: () => {} }`
  is over-narrow for the iterator protocol). Fixing these requires loosening
  the wrapper in `tests/test262-runner.ts` (e.g. `// @ts-nocheck` injection
  on tests where the file lives under `expressions/assignment/dstr/`).
  Tracked as a follow-up.
- **Obj-id `function name` propagation** (`obj-id-init-fn-name-*`, 11 tests)
  — needs NamedEvaluation for assignment patterns mirroring the binding-pattern
  path. Sister of #820m / #194; out of scope for a localized fix.

## Files modified

- `src/codegen/expressions/assignment.ts`
  - `compileArrayDestructuringAssignment` — always emit GetIterator-equivalent
    throw for non-iterable primitive RHS (numbers boxed to externref now reach
    a `__extern_check_iterable` guard).
  - `compileDestructuringAssignment` — drop the `target.properties.length > 0`
    gate on the null/undefined guard for empty object patterns; always
    RequireObjectCoercible when RHS is externref/ref_null.

## Tests added

- `tests/issue-1701.test.ts` — 7 cases (4 throws + 3 no-regression).
