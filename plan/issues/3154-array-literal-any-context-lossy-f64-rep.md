---
id: 3154
title: "Array-literal lowering in an `any` context adopts a lossy NaN-f64 representation for literals containing `undefined`/mixed elements"
status: ready
sprint: Backlog
priority: medium
horizon: m
feasibility: hard
area: codegen
goal: standalone-mode
related: [3151]
origin: "#3151 / PR #2899 auto-park diagnosis (CI-fix dev, 2026-07-12)"
---

## Problem (probe-pinned 2026-07-12)

When an **array literal** is constructed in an **`any`-typed context** (e.g.
passed as an argument to a parameter typed `any`, rather than `any[]`), the
compiler picks a **lossy representation** for the array's elements:

- `[1, void 0, 3]` becomes an **f64 array** whose `void 0` element is emitted
  as **NaN**. A subsequent read gives `typeof a[1] === "number"` (should be
  `"undefined"`), and because `NaN !== NaN`, even a **self-compare**
  `a[1] !== a[1]` returns true — a plain array literal fails to compare equal
  to *itself*.
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
export function test(): number { return f([1, void 0, 3]); }
```

```ts
// typeof through any: literal's undefined element reads as "number"
function g(a: any): string { return typeof a[1]; }
export function test(): string { return g([1, void 0, 3]); } // "number" (BROKEN — "undefined")
```

Compare with the **`any[]`** annotation, which lowers the literal correctly
(WasmGC array of boxed/externref elements) and reads `undefined` back:

```ts
function f(a: any[]): number { return a[1] === undefined ? 1 : 0; }
export function test(): number { return f([1, void 0, 3]); } // 1 (CORRECT)
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
  expected type currently routes to the f64-packed path when the *first*
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
