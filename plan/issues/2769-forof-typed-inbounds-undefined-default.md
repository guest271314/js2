---
id: 2769
title: "[ARCH] for-of typed in-bounds undefined/hole default-init — representation-level carve (split from #2669)"
status: in-progress
assignee: ttraenkler/forof769
created: 2026-06-28
updated: 2026-06-28
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
related: [2669, 2216]
sprint: current
---

# #2769 — for-of typed in-bounds `undefined`/hole default-init (architect carve)

Split out of the #2669 destructuring umbrella. This is the **typed in-bounds
sentinel-propagation** slice the umbrella flagged as "the next carve" — it needs
a **representation-level** design, not a value-side patch. A dev attempt
(PR #2226) was closed because the obvious fix is architecturally unsound (see
below). Routed to architect.

## Symptom

```js
for (const [x = 23] of [[undefined]]) { … }   // x should be 23; we produce 0/NaN
for (const [x = 23] of [[,]])        { … }     // hole — same bug
```

Real failing test262 (~8–14 tests):
`language/statements/for-of/dstr/{const,let,var}-ary-ptrn-elem-id-init-{undef,hole}.js`,
plus `array-elem-nested-{array,obj}-undefined-own.js`.

## The KEY ASYMMETRY (the crux for the design)

**Binding patterns ALREADY PASS on main; the identical for-of FAILS.**

| form | passes? | why |
|------|---------|-----|
| `let [[x = 23]] = [[undefined]]` | **PASS** (→ 23) | TS infers `[[undefined]]` as a **TUPLE** → tuple-struct → the f64 **sNaN sentinel** (`0x7ff00000deadc0de`) is emitted for undefined-like elements (`compileTupleLiteral`, `literals.ts`) → the destructuring default-check (`i64.reinterpret_f64` == sentinel) fires. |
| `for (const [x = 23] of [[undefined]])` | **FAIL** (→ 0) | TS infers the iterable as an **ARRAY** (`undefined[][]`) → `resolveWasmType` lowers the inner `undefined[]` to **`vec_i32`** → the inner `[undefined]` literal (built fresh as `vec_externref` holding the `undefined` externref) is COERCED to `vec_i32` (`__unbox_number` → `i32.trunc_sat_f64_s` → **`0`**), identity LOST → the default-check on the coerced f64 `0.0` never matches the sentinel. |

So the binding path already has a correct mechanism (tuple + f64 sentinel); the
for-of path loses `undefined` at **construction** because the element is an
ARRAY, not a TUPLE.

## Why the obvious dev fix is unsound (PR #2226, closed)

Widening `undefined[]`/`void[]` from `vec_i32` → externref in `resolveWasmType`
**fixed the for-of** (+35 dstr wins) but `resolveWasmType` is **type-deterministic**
(a given TS type must resolve to ONE backing everywhere), so it changed the
backing for ALL undefined-typed arrays and produced 5 merge-group regressions:

- **Construction** — `new Array(undefined, undefined)` / `[, , ,]` emit
  `array.new_fixed` with `i32.const 0` for undefined/hole elements → invalid Wasm
  ("expected externref, found i32"): `built-ins/Array/S15.4.2.1_A2.1_T1.js`,
  `built-ins/Array/prototype/sort/S15.4.4.11_A1.3_T1.js` (compile_error).
- **i32/f64 consumers** assume numeric backing → `built-ins/Array/S15.4.1_A2.1_T1.js`
  (length, assertion_fail), `built-ins/Array/prototype/reduceRight/15.4.4.22-8-c-4.js`
  (null_deref), `language/module-code/top-level-await/syntax/for-in-await-expr-this.js`
  (illegal_cast).

The +35 wins and −5 regressions are **inseparable** in this approach. Scoping
attempts that were ruled out:
- `_depth >= 1` gate — fails: the for-of resolves its inner `undefined[]` at depth 0
  too (same call site as `new Array`), so depth can't distinguish them, and a
  depth-dependent type breaks resolveWasmType consistency.
- f64 backing instead of externref — worse: breaks both the for-of and construction.

## Candidate approach (for the architect to evaluate)

**Type the for-of-over-array-LITERAL elements as TUPLES**, so the existing
`isTupleStruct` for-of destructure branch (`src/codegen/statements/loops.ts`,
~L1604 — the branch BEFORE the vec-array branch ~L1697) handles them with the
tuple + f64-sentinel mechanism the binding path already uses. This keeps the
fix LOCAL to the for-of and avoids changing the global array element
representation. Open questions the spec must resolve:
- Does typing the iterable's elements as tuples interact correctly with runtime
  iteration (length/break/continue/closures-per-iteration)? The for-of loops a
  runtime vec, not a compile-time literal.
- Restrict to the case where the iterable is a direct array literal whose element
  literals are array/object literals (the spec'd templates), to avoid perturbing
  general for-of-over-array.
- Alternative: a dedicated undefined-bearing array representation, or carrying the
  undefined sentinel through the externref→i32 coercion — both are broader.

## Acceptance

- The ~8–14 listed for-of/dstr `*-id-init-{undef,hole}` + `*-undefined-own` tests
  flip fail→pass.
- ZERO regression in `built-ins/Array/**` construction/consumer tests
  (validate the full `merge_group` / test262 floor, NOT a scoped sweep — the
  PR #2226 regressions were ONLY caught by the merge-group re-validation).
- No change to the global `undefined[]`/`void[]` array backing.

## Notes

- The #2216 nested-array-default codegen slice of #2669 is already **done/merged**
  and is unaffected.
- Umbrella: #2669.
