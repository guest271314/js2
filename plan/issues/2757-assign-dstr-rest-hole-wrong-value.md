---
id: 2757
title: "Assignment-destructuring (expressions/assignment): rest element + undefined/hole binds wrong value / 'array too large' trap"
status: ready
assignee: ttraenkler/unassigned
created: 2026-06-28
updated: 2026-06-28
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
parent: 2669
related: [2669]
sprint: current
---
# #2757 — assignment-destructuring rest/hole wrong value

Carved from the #2669 destructuring umbrella (sd-dstr-objdefault, 2026-06-28).
The **assignment** destructuring path (`[a, ...r] = x`, i.e.
`expressions/assignment/dstr/`) — distinct file/codegen from binding-pattern
destructuring, so independently shippable in parallel with #2756/#2758.

## Repro (verified on current `origin/main` @ #2201)

```ts
// TRAP: "requested new array is too large"  (want x === undefined)
let x: any, r: any;
[x, ...r] = [];
```
test262 (fresh single-file, FAIL):
```
language/expressions/assignment/dstr/array-rest-nested-obj-undefined-own.js
  -> returned 2 | assert #1 at L28: assert.sameValue(x, undefined)
language/expressions/assignment/dstr/array-rest-nested-obj-undefined-hole.js
  -> same
```
The rest element drained from a short/empty source mis-sizes the new array
(trap), and a present-but-`undefined` / hole element in assignment destructuring
binds the underlying value rather than `undefined`.

## Scope

- `expressions/assignment/dstr/` cluster — **149** total non-pass; this slice is
  the **rest-element + elision/hole value-binding** subset that does NOT involve
  a generator source (those route to #2566) or a custom iterable (those route to
  the iterator-protocol tail / #2662). Est net recovery: **~40–60**.
- The assignment path differs from binding patterns: the targets are arbitrary
  assignment LHS (member exprs, identifiers), not fresh bindings — confirm the
  rest-collection and the hole→undefined semantics in the assignment lowering.

## Root-cause pointer

- Assignment-destructuring lowering lives in the expression/assignment codegen
  (grep `compileArrayAssignmentDestructuring` / array-assignment rest handling in
  `src/codegen/expressions*`); the rest collection sizes a new array from the
  remaining iterator/vec length — verify the empty/short-source length math and
  the OOB→undefined sentinel for non-rest holes.

## Acceptance criteria

- `[x, ...r] = []` ⇒ `x === undefined`, `r` is an empty array (no trap).
- `array-rest-nested-obj-undefined-own` / `-undefined-hole` flip fail→pass.
- No regression in passing assignment-destructuring cases.
- Guard test `tests/issue-2757.test.ts`.

## PARTIAL LANDED — vec-rest length clamp (dev-acorn, 2026-06-28)

Shipped the trap-hardening slice (focused PR `fix(codegen): clamp vec-rest length
in array assignment-destructuring (#2757 partial)`):

- **`src/codegen/expressions/assignment.ts` (array-rest branch, ~line 1578):** the
  rest array was sized `src.length - i` (i = rest element's pattern index) and
  passed straight to `array.new_default`. For a source shorter than the non-rest
  prefix that count is NEGATIVE; `array.new_default` reads the size UNSIGNED → a
  ~4-billion-element request → "requested new array is too large" trap. Now floored
  at 0 (`i32.lt_s` + `if` → 0) so a short/empty source yields an empty rest. Guard:
  `tests/issue-2757.test.ts` (no-trap + normal-rest-still-collects).

## REMAINING (the actual test262 acceptance — fresh dev, precise map)

Verify-first established that the two named cases are blocked by a DIFFERENT
defect than the trap, precisely localized in `src/codegen/expressions/assignment.ts`:

1. **THE BLOCKER — `assignment.ts:1556`: the array-rest branch only handles an
   IDENTIFIER rest target.** `if (ts.isIdentifier(restTarget))` wraps the entire
   rest build+bind. The named cases use an **object-pattern rest target**
   (`[...{ 0: x, length }] = vals`), so `restTarget` is an `ObjectLiteralExpression`
   → the branch is skipped → `x`/`length` are never bound (the `assert.sameValue(x,
   undefined)` fail). **Fix:** build the rest vec into a TEMP local (the existing
   build already produces `struct.new typeIdx` — redirect its final `local.set` to a
   temp), then dispatch on the target kind exactly like the non-rest elements do
   (lines ~1663-1682): `ts.isObjectLiteralExpression` → `emitObjectDestructureFromLocal`,
   `ts.isArrayLiteralExpression` → `emitArrayDestructureFromLocal`,
   property/element access → `emitAssignToTarget`, identifier → the current
   `local.set restLocalIdx`. Keep the identifier path byte-identical to avoid
   churning the working cases.
2. **Secondary — `assignment.ts:1660` "rest on tuples is not supported."** A small
   literal source like `[1]` compiles to a TUPLE struct (fixed-size), not a vec, so
   `isVecStruct` is false and the rest path is skipped entirely. The named cases use
   a VARIABLE source (`vals: any[]` → vec) so they DO hit the vec path; this tuple
   note is only relevant for literal sources and is a separate, lower-priority tail.
3. **Also observed (own follow-up if it persists):** an OOB *non-rest* element in
   the vec path does NOT read `undefined` (`[a, b, ...r] = [1 as any]` left `b`
   non-undefined). `emitElementGet`/`emitBoundsCheckedArrayGet` should yield
   `undefined` for an out-of-range index in assignment destructuring.

Validate on the FULL `merge_group` / test262 floor — the `expressions/assignment/dstr`
cluster is 149 cases and the rest-bind refactor is broad-impact; a dev cannot
validate it with scoped local checks.
