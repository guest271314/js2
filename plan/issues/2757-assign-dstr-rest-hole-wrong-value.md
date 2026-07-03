---
id: 2757
title: "Assignment-destructuring (expressions/assignment): rest element + undefined/hole binds wrong value / 'array too large' trap"
status: done
assignee: ttraenkler/agent-dev
completed: 2026-06-28
created: 2026-06-28
updated: 2026-07-03
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
sprint: 69
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

## RESOLVED — non-identifier rest targets (agent-dev, 2026-06-28)

`src/codegen/expressions/assignment.ts`: the array-rest branch now builds the
collected rest vec into a temp local and **dispatches on the rest TARGET kind**
(previously only an identifier target was handled, so every non-identifier rest
target silently dropped its bindings):

- **identifier** (`[a, ...r]`) — unchanged (build → copy into the rest local).
- **object pattern** (`[...{ 0: x, length }]`) — new `emitVecArrayLikeObjectDestructure`
  helper reads the vec as an array-like: `length` key → vec length field, numeric
  key `N` → bounds-checked element N (OOB → `undefined`), per ECMA-262 §13.15.5.5.
  `emitObjectDestructureFromLocal` could not be reused — it does nominal struct
  field lookups and a vec struct is not registered in `typeIdxToStructName`.
- **array pattern** (`[...[x]]`) → `emitArrayDestructureFromLocal` over the vec.
- **member expression** (`[...obj.y]`) → `emitAssignToTarget` (works for typed
  receivers; dynamic-object property *creation* — `array-rest-put-prop-ref` with
  `o = {}` — still no-ops, deferred tail).

Flips fail→pass: `array-rest-nested-obj-undefined-own`,
`array-rest-nested-obj-undefined-hole`, `array-rest-nested-obj`,
`array-rest-nested-array` (+ similar). Guard tests in `tests/issue-2757.test.ts`.

**Deferred tails** (separate follow-ups, NOT regressions — existing partial
clamp tests still pass): (1) an **empty/short LITERAL source** like `[x,...r]=[]`
compiles to a tuple/empty representation, not the vec path, so `r` is not yet an
array there (issue point #2); (2) an **OOB non-rest element** in the vec path
does not yet read `undefined` (issue point #3); (3) **dynamic-object** member
rest (`[...o.y]` with `o:any={}`) needs `__extern_set` property creation.

## CI-FIX — nested-array-rest undefined/hole invalid-Wasm (PR #2224 merge-group park, agent-af359e7cc95c024c6, 2026-06-28)

PR #2224 was auto-parked by the merge-group bot: net +5 but failed the ratio
gate (28.6% > 10%) on **2 in-area regressions**, both `compile_error` (INVALID
WASM) for the PR's own feature — nested array-pattern rest over an
undefined/hole source:
`expressions/assignment/dstr/array-rest-nested-array-undefined-{own,hole}.js`.

Two distinct defects in the `[...[x]] = vals` path
(`src/codegen/expressions/assignment.ts`):

- **(own, `[undefined]`) — double coercion.** `emitArrayDestructureFromLocal`'s
  identifier-element bind manually `coerceType(elemType → localType)` and THEN
  called `emitCoercedLocalSet(…, elemType)`, which coerces the (already-coerced)
  stack value a SECOND time — emitting `f64.convert_i32_s` on an externref when
  the rest-vec element type differed from the target local's type. Fixed by
  dropping the redundant pre-coerce (`emitCoercedLocalSet` already coerces
  `elemType → localType` internally).

- **(hole, `[ , ]`) — stale `$Hole` global.get.** The nested pattern's null
  guard ran `buildDestructureNullThrow`, which adds a LATE `string_constants`
  import global, shifting every module-global index. A `$Hole` `global.get`
  emitted earlier for the hole literal (`var vals = [ , ]`) went one slot stale
  because `fixupModuleGlobalIndices` walked no in-progress body when
  `ctx.currentFunc` was transiently null at the string-constant add — leaving
  `extern.convert_any` consuming an i32 global. The collected rest vec is freshly
  `struct.new`'d → **provably non-null**, so its null guard is dead code; the new
  `srcKnownNonNull` parameter skips it for the rest-vec dispatch, removing both
  the dead code and the late-string-constant trigger.

Differential `language/expressions/assignment/dstr` (368 files, per-file diff vs
the PR's pre-fix HEAD): **+2 gains, 0 regressions**. `for-of/dstr` and
`for-await-of` nested-array-undefined siblings all pass; `tests/issue-2757.test.ts`
9/9. Guards added for the undefined/hole/empty rest sources (valid-Wasm + no-trap;
value semantics are pinned by the flipped test262 files).
