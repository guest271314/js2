---
id: 2808
parent: 2669
title: "for-of OBJECT-binding head drops nested sub-patterns (no bind, no RequireObjectCoercible throw)"
status: done
created: 2026-06-28
completed: 2026-06-28
assignee: ttraenkler/dstr2
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
sprint: 69
---

# #2808 — for-of OBJECT-binding head drops nested sub-patterns

Slice of the #2669 ES2015 destructuring-correctness umbrella. Concentrated in the
for-of / for-await loop-head binding path, which is a **separate, less-complete
reimplementation** of destructuring (`compileForOfDestructuring`,
`src/codegen/statements/loops.ts`) than the binding-declaration / param paths
(those already pass these tests).

## Cluster + net-recovery

Verify-first re-sweep of the whole `/dstr/` surface on current `origin/main`
(post-#2279). The binding-declaration, object-method and class dirs already
PASS the nested-`null`/`undefined`-must-throw and nested-value-extract templates
(137 / 156). The residual is **for-of-specific**: the for-of binding head drops
nested object/array sub-patterns. Path-classified clean (non-generator,
non-custom-iterable) for-of fails:

| sub-pattern family | tests |
|--------------------|-------|
| `for-of/dstr` `{var,let,const}-obj-ptrn-prop-{obj,ary}{,-init,-value-null,-trailing-comma,-value-undef}` | **18** |
| `for-await-of` `async-{func,gen}-dstr-{var,let,const}-obj-ptrn-prop-{obj,ary}*` | **24** |

**Net recovery: +42 test262, 0 regressions** (full before/after on `for-of/dstr`
(569) and the flat `for-await-of` dstr dir (1215), swapping `loops.ts` clean-main
vs fixed).

## Root cause

`compileForOfDestructuring`'s ARRAY-pattern branch recurses into nested
sub-patterns (#2216 / #2669), but the **OBJECT-pattern struct branch dropped
them**: after resolving the property name it hit

```ts
if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
```

For `for (const { w: { x } } of …)` the binding element's `name` is a nested
`ObjectBindingPattern`/`ArrayBindingPattern`, not an `Identifier`, so the element
was **skipped entirely**:

1. the inner names (`x`,`y`,`z`) were never bound — wrong value
   (`*-prop-obj`, `*-prop-ary`, `*-trailing-comma`); and
2. for a `null`/`undefined` property value the nested pattern was never applied,
   so **RequireObjectCoercible (object sub-pattern) / GetIterator (array
   sub-pattern) never ran and no `TypeError` was thrown**
   (`*-prop-{obj,ary}-value-null`, ECMA-262 §13.15.5.5 / §8.5.2).

## Fix

`src/codegen/statements/loops.ts`, in the object-pattern struct branch of
`compileForOfDestructuring`, handle a nested sub-pattern **before** the
identifier-only `continue`, mirroring the proven array-branch handler:

- **field present** (`fieldIdx >= 0`): `struct.get` the value into a fresh
  `nestedLocal`, apply `emitNestedBindingDefault` (fires only on `undefined`,
  never `null` — KeyedBindingInitialization §13.3.3.7 step 3), then recurse
  `compileForOfDestructuring(element.name, nestedLocal, fieldType, stmt)`. The
  recursion's own `emitNullGuard` / externref RequireObjectCoercible guard throws
  `TypeError` for a `null`/`undefined` target — so the throw is handled by the
  recursion, not re-emitted here.
- **field absent** (`fieldIdx === -1`, value is `undefined`): if a pure default
  is present, compile it as the nested source and recurse; otherwise force a
  nullable carrier and recurse so the guard throws.

The nested **default** is gated `!stmt.awaitModifier && !ts.isCallExpression(...)`
— identical to the array branch. A call default compiled in a conditionally-
skipped arm materialises its capture box on the not-taken branch (#2692) /
over-consumes a generator (#2566); the `awaitModifier` exclusion matches the
#2216 for-await regression precedent. Pure literal/identifier defaults have no
side effect or capture box, so they are safe.

## Why for-of had the gap (and the dec/param paths did not)

The binding-declaration (`compileVariableDeclaration`), function-param
(`destructureParamObject`) and assignment (`expressions/assignment.ts`) paths all
recurse into nested sub-patterns already. `compileForOfDestructuring` is the
fourth, loop-head-specific lowering; its object branch was the only one that
never gained nested recursion. This slice closes that asymmetry for the SYNC
object branch.

## Scope / residual (NOT this slice)

- The **object** nested-default-FIRES sub-case where the property *value* is
  `undefined` (so the struct field lowers to **externref**) is recovered for the
  test262 cluster (`*-obj-ptrn-prop-obj-init`, passes under the production
  runner) but is representation-sensitive under a bare standalone `compile()`
  (externref-field default coercion → `__extern_get` on a wrapped GC struct;
  #2769-adjacent). Tracked under the #2669 tail, not regressed by this slice.
- The for-of / plain **ASSIGNMENT** destructuring nested cases
  (`obj-prop-nested-*`, `expressions/assignment/dstr/obj-prop-nested-*`) live in
  `compileForOfAssignDestructuring` / `expressions/assignment.ts` — a different
  lowering — and remain under the umbrella.
- Generator-source / custom-iterable nested cases stay blocked on #2566 / #2662.
- Heterogeneous typed-vec `[10, undefined]` → NaN is the pre-existing #2769
  array-branch representation gap (untouched by this object-branch slice).

## Acceptance criteria

- `for (const { a: { x }, b: [y] } of arr)` binds inner names correctly. ✓
- A nested object/array sub-pattern over a `null`/`undefined` property value
  throws `TypeError` (RequireObjectCoercible / GetIterator). ✓
- A nested default fires only on `undefined`, never `null`. ✓
- No regression in currently-passing for-of / for-await destructuring tests
  (full before/after: 0 regressions). ✓

## Validation

- Guard test `tests/issue-2808.test.ts` — 10/10 green (value extraction, nested
  array default, the three null/undefined throw cases, three controls).
- test262 before/after (clean-main `loops.ts` vs fixed, identical
  `runTest262File` harness):
  - `for-of/dstr` (569 files): **+18, 0 regressions**.
  - `for-await-of` dstr (1215 files): **+24, 0 regressions**.
- Blast radius is exactly `compileForOfDestructuring` (for-of / for-await loop
  heads). The binding-declaration / object-method / class / param dstr dirs use
  different lowerings and are unaffected.
