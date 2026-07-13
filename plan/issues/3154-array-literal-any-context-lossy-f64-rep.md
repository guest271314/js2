---
id: 3154
title: "Array-literal lowering in an `any` context adopts a lossy NaN-f64 representation for literals containing `undefined`/mixed elements"
status: done
completed: 2026-07-12
assignee: ttraenkler/fable-eqfix
sprint: 71
priority: medium
horizon: m
feasibility: hard
area: codegen
goal: standalone-mode
related: [3151, 90]
origin: "#3151 / PR #2899 auto-park diagnosis (CI-fix dev, 2026-07-12)"
loc-budget-allow:
  - src/codegen/binary-ops.ts
  - src/codegen/literals.ts
coercion-sites-allow:
  - src/codegen/binary-ops.ts
---

## Resolution (2026-07-12, fable-eqfix — jointly with task #90)

Fixed as the array-literal half of the `any !== any` value-equality gap
(TaskList task #90). Two coupled root causes, one PR:

- **(A) `#3154` array-literal rep (`src/codegen/literals.ts`)** — the
  `compileArrayLiteral` contextual-type widening only fired for an
  `Array<any>` contextual type. A **bare-`any`** context (an array literal
  passed directly to an `any`-typed parameter, or an inner tuple of an `any[]`
  outer literal) kept the first-element f64/i32 fast path, so a `void 0`
  element became the sNaN sentinel (reads back a NaN _number_; `a[1] !== a[1]`
  self-compare true; `typeof` lies `"number"`) and string/boolean/symbol
  elements were dropped/number-coerced at CONSTRUCTION. Fix: widen a
  **non-all-numeric** bare-`any` literal to externref-boxed elements (each
  boxed by its own static type — the SAME construction `Array<any>` already
  uses). A homogeneous-numeric literal keeps the f64 fast path byte-identical.

- **(B) `#90` strict-eq value compare (`src/codegen/binary-ops.ts`)** — a
  dynamic element/member read in standalone lowers to a `(ref $AnyValue)`
  reader carrier (#3037 CS1b); compared `===`/`!==` against an `any` PARAM
  (raw externref) or a primitive, the codegen `ref.eq`'d the CARRIER BOX
  against the raw value → always false, so equal strings / the same interned
  symbol / boxed-undefined wrongly tested unequal. Fix: route the mixed
  `$AnyValue`-vs-externref/primitive pair through the tag-aware
  `__any_strict_eq` (§7.2.16 IsStrictlyEqual — numbers by `f64.eq` with
  NaN≠NaN / +0===-0, strings by content, objects/symbols by identity),
  classifying the non-carrier side with the SAME honest classifier the reader
  used. A statically-symbol i32 operand is boxed by its brand
  (`__box_symbol` — the id-interned `$Symbol` carrier), never `__box_number`,
  in the standalone tag-dispatch AND the host `__host_eq` path.

**Gate allowances (#3131):** `loc-budget-allow` (both files) + `coercion-sites-allow`
(binary-ops.ts). The coercion-sites growth is one added `__any_strict_eq` dispatch
(1→2) — an intentional, reviewed step that routes the mixed
`$AnyValue`-vs-externref/primitive strict-eq through the engine keystone
`__any_strict_eq` (§7.2.16), REPLACING a wrong hand-rolled `ref.eq` box-identity
comparison. This is USING the coercion engine, not hand-rolling a fresh
ToString/ToNumber/ToPrimitive matrix.

Regression guard: `tests/issue-90-any-value-eq.test.ts` (15 shapes × both
lanes). **Still out of scope (independent pre-existing root causes, identical
on clean main — verified):** `Map/groupBy/string.js` (groupBy does not iterate
a **string** iterable — empty map) and `Map/groupBy/toPropertyKey.js` (object
**key** identity lost through the struct→externref boxing substrate). Neither is
the string/symbol value-equality class; both reproduce byte-identically on
`origin/main` and are unaffected by this change.

## Problem (probe-pinned 2026-07-12)

When an **array literal** is constructed in an **`any`-typed context** (e.g.
passed as an argument to a parameter typed `any`, rather than `any[]`), the
compiler picks a **lossy representation** for the array's elements:

- `[1, void 0, 3]` becomes an **f64 array** whose `void 0` element is emitted
  as **NaN**. A subsequent read gives `typeof a[1] === "number"` (should be
  `"undefined"`), and because `NaN !== NaN`, even a **self-compare**
  `a[1] !== a[1]` returns true — a plain array literal fails to compare equal
  to _itself_.
- Mixed-element literals like `[1, 'z']` or `[symA, symB]` **misread their
  non-numeric elements** through the same `any`-context path — the string /
  symbol elements are lost or coerced when the literal is built as f64.

The corruption happens at **literal CONSTRUCTION** in the `any` argument
context, not at the read site — so no downstream branch (an `Array.isArray`
dispatch was probed and confirmed NOT to help) can recover the correct values.

### Where it was found

Surfaced by #3151 / PR #2899. The test262 runner's `compareArray` /
`assert_compareArray` harness shims were flipped from `any[]` to `any` params
to support standalone dyn-view TypedArrays. That flip regressed **15
baseline-pass JS-host tests** in the merge_group (run 29175942933), all
compareArray-cluster:

- `Array/prototype/concat/Array.prototype.concat_{holey-sloppy,sloppy,strict}-arguments.js`
  (+ `_sloppy-arguments-with-dupes.js`)
- `Array/prototype/with/this-value-boolean.js`
- `Reflect/ownKeys/order-after-define-property.js`,
  `Object/getOwnPropertyDescriptors/order-after-define-property.js`
- `language/computed-property-names/basics/symbol.js`
- `language/expressions/{array,call,new,super/call}-*spread-obj-spread-order.js`

Every one of these calls `compareArray(<value>, <ARRAY LITERAL>)` where the
literal contains `void 0` / string / symbol elements. Under the `any` param
the literal argument was mis-lowered → `compareArray` returned 0 →
`assert` failed.

#3151 worked around it at the **harness** level (lane-split: host lane keeps
`any[]`, standalone/wasi use `any`). That unblocked the TypedArray cluster
without regressing host — but the **underlying compiler bug remains**: any
real user code that flows an array literal with `undefined`/mixed elements
through an `any`-typed context hits the same lossy f64 representation.

### Minimal repro (probe, JS-host lane)

```ts
function f(a: any): number {
  // self-compare of a plain array literal's undefined element
  return a[1] !== a[1] ? 0 : 1; // returns 0 (BROKEN — should be 1)
}
export function test(): number {
  return f([1, void 0, 3]);
}
```

```ts
// typeof through any: literal's undefined element reads as "number"
function g(a: any): string {
  return typeof a[1];
}
export function test(): string {
  return g([1, void 0, 3]);
} // "number" (BROKEN — "undefined")
```

Compare with the **`any[]`** annotation, which lowers the literal correctly
(WasmGC array of boxed/externref elements) and reads `undefined` back:

```ts
function f(a: any[]): number {
  return a[1] === undefined ? 1 : 0;
}
export function test(): number {
  return f([1, void 0, 3]);
} // 1 (CORRECT)
```

Note the asymmetry surfaced by the probes: an array built as a typed `any[]`
**local** and then passed to an `any` param reads correctly
(`const x: any[] = [1, void 0, 3]; f(x)` → correct); it's specifically the
**array LITERAL constructed directly in the `any` argument position** that
adopts the lossy f64 rep. So the defect is in how the literal's contextual
type drives element-representation selection at construction, not in the
`any` parameter read path.

## Acceptance criteria

- An array literal containing `undefined` (and/or mixed string/symbol/number
  elements) constructed in an `any`-typed context reads back with correct
  element identity: `typeof lit[i]` is `"undefined"` for a `void 0` element,
  and `lit[i] === lit[i]` holds for every element (no NaN self-inequality).
- The `#3151` harness lane-split can then be reverted to a single `any`-typed
  `compareArray`/`assert_compareArray` shim with **no** host-lane regressions
  (this issue is the blocker preventing the unified shim).
- Add `tests/issue-3154.test.ts` covering: `[1, void 0, 3]` self-compare and
  `typeof` through an `any` param, and a mixed `[1, 'z']` / `[symA, symB]`
  literal read.

## Implementation notes (starting points)

- The representation decision lives in array-literal codegen — inspect where
  the contextual/expected type of an array literal selects between an f64
  packed array and a boxed/externref WasmGC array. The bug is that an `any`
  expected type currently routes to the f64-packed path when the _first_
  element is numeric, instead of the boxed path that preserves `undefined`
  and heterogeneous elements.
- Cross-check against the `any[]` path, which already lowers these literals
  correctly — the fix likely makes the `any` expected-type case reuse the
  same boxed-element construction the `any[]` case uses when the literal is
  heterogeneous or contains `undefined`.
- `feasibility: hard` — touches element-representation selection, which has
  perf implications (the f64-packed path exists for a reason); the fix must
  keep the fast path for homogeneous-numeric literals and only widen to the
  boxed rep when the literal is heterogeneous / contains `undefined`, or when
  the `any` context genuinely requires identity-preserving elements.
