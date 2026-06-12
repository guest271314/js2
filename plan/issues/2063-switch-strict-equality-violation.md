---
id: 2063
title: "switch violates strict-equality matching across types: switch(true){case 1:} matches; \"1\" matches case 1; mixed cases crash"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: switch
goal: core-semantics
related: [162, 198, 245]
origin: "2026-06-10 deep-audit sweep (control-flow agent): verified miscompile on main; semantic bug introduced by #198's coercion fix"
---

# #1943 — switch unifies cases into one coercion domain instead of per-case StrictEquality

## Problem

[§14.12.2 CaseClauseIsSelected](https://tc39.es/ecma262/#sec-runtime-semantics-caseclauseisselected)
requires per-case **StrictEquality** (different types ⇒ no match, no coercion).
The compiler instead unifies the whole switch into one comparison domain,
producing silent wrong-branch execution and a runtime crash on valid code.

## Repro (verified on main)

```ts
export function t3(): number {
  const x: any = true;
  switch (x) { case 1: return 100; default: return 0; }
}
export function s(): number {
  const x: any = "1";
  switch (x) { case 1: return 100; default: return 0; }
}
export function t2(): number {  // crash variant
  const x: any = "1";
  switch (x) { case 1: return 100; case "1": return 50; default: return 0; }
}
```

| fn | wasm | node |
|----|------|------|
| `t3` | `100` | `0` (true !== 1) |
| `s` | `100` | `0` ("1" !== 1) |
| `t2` | `RuntimeError: Illegal argument` | `50` |
| `switch(1){case "1":}` | `RuntimeError: Illegal argument` | no match |

## Root cause

`src/codegen/statements/control-flow.ts:551-680` (`compileSwitchStatement`):
if any case is string-typed, everything is compared with string equality
(numeric discriminant/cases get shoved through `wasm:js-string equals` → host
"Illegal argument"); otherwise an externref discriminant is unboxed to f64
(:588-591), i.e. ToNumber semantics — `true`→1.0 and `"1"`→1.0 then `f64.eq`
matches `case 1`. #198 introduced this "type coercion for mixed-type case
clause comparisons" to fix compile errors.

## Fix direction

When the discriminant (or any case) type is not statically homogeneous, keep
the discriminant boxed and compare per-case with a strict-equals helper that
type-tag-dispatches (any-value helpers already exist); only use the unified
f64/i32/string fast path when discriminant and all cases are provably the same
primitive type.

## Acceptance criteria

- All three repros match Node (no match for cross-type, no crash on mixed cases)
- Homogeneous numeric/string switches keep the fast path (no test262 or perf
  regression on the common case)
- `switch` on booleans, null, undefined matches strict-equality

## Dupe check

Grepped `switch` + strict/coerc/mixed/discriminant: #162 (literal-narrowing,
done), #198 (done — introduced the coercion), #245 (string cases, done). The
strict-equality violation itself is unfiled.

---

## Implementation Plan (per-site delta — shared design in #2058)

> **Read [#2058's `## Implementation Plan`](./2058-any-plus-runtime-string-numeric-add.md)
> first** for the shared root cause (default mode lowers `any` to externref),
> the −788 boxing-site trap, and the per-site tag-dispatch rule. This section
> covers the switch deltas. **Land order: this is step 1 — land FIRST** (smallest
> blast radius, no new host import; it validates that per-site tag dispatch
> coexists with the test262 comparator).

### Root cause (switch-specific)

`compileSwitchStatement` (`control-flow.ts:567-696`) collapses the entire switch
into **one** `wasmType` comparison domain (control-flow.ts:570-607):

- If the discriminant **or any case** is string-typed → everything compares with
  `__str_equals` / `wasm:js-string equals`, and a numeric discriminant/case gets
  shoved through string-equals → host **"Illegal argument"** crash (`t2`,
  `switch(1){case "1":}`).
- Otherwise an externref discriminant is **unboxed to f64** (`:604-607`) →
  ToNumber semantics: `true`→1.0, `"1"`→1.0, then `f64.eq` wrongly matches
  `case 1` (`t3`, `s`).

§14.12.2 CaseClauseIsSelected requires **per-case StrictEquality** — different
types ⇒ no match, no coercion, no crash.

### Changes

**File: `src/codegen/statements/control-flow.ts`** — `compileSwitchStatement`

1. **Add a homogeneity check.** After computing `switchIsString`
   (control-flow.ts:575-586), compute whether the discriminant and **all** case
   expression types are the *same* primitive class:
   ```
   const allNumeric = isNumberType(exprType) && every case isNumberType
   const allString  = isStringType(exprType) && every case isStringType
   const allBoolean = isBooleanType(exprType) && every case isBooleanType
   const homogeneous = allNumeric || allString || allBoolean
   ```
   When `homogeneous`, keep the **existing fast path** verbatim (no test262 or
   perf regression on the common case — acceptance criterion).

2. **Non-homogeneous → strict-equals dispatch.** When `!homogeneous` (mixed
   types, or discriminant is `any`/`unknown`/`externref` with concrete-typed
   cases), do NOT pick a single `wasmType`. Instead:
   - Keep the discriminant **boxed**: lower it to `ref_null $AnyValue` (box via
     the existing `coerceType(..., {kind:"ref_null", typeIdx: anyValueTypeIdx})`
     path after `ensureAnyValueType(ctx)` / `ensureAnyHelpers(ctx)`), stored in
     `tmpLocalIdx` as the AnyValue box.
   - In **Phase 1** (control-flow.ts:626-680), for each case: box the case
     expression the same way, then compare with **`__any_strict_eq`**
     (`any-helpers.ts:1131`) instead of `eqOp`/`strEqFuncIdx`. `__any_strict_eq`
     already implements §7.2.16 StrictEquality with the right cross-tag rule
     (different tags → 0, no coercion; numeric class 2/3 unified; string content
     via `wasm:js-string equals`; ref identity via `ref.eq`).
   - This makes `t3`/`s` return no-match (`true`/`"1"` have tags 4/5, `case 1`
     tag 2 → `__any_strict_eq` returns 0) and `t2` match `case "1"` without
     crashing (string content compare, no f64-into-string-equals trap).

   **Default-mode (externref, `anyValueTypeIdx < 0`) variant:** if forcing
   `ensureAnyValueType` for every mixed switch is undesirable, the alternative is
   the externref tag-dispatch from #2058/#1776: spill discriminant + each case to
   externref temps and compare with the **strict** form of the #1776 equality
   block (typeof-number→f64.eq, typeof-bool→i32.eq, typeof-string→`__str_equals`,
   else ref identity — **no** cross-type coercion). Prefer reusing
   `__any_strict_eq` via boxing for code-share with the equality operator; fall
   to the externref-spill form only if boxing the discriminant proves to pull in
   too much fast-mode machinery in default mode. Either way the comparison is
   **strict and per-case**.

### The host-boxed-boolean tag-recovery defect (the crux of this issue)

A prototype that routed non-homogeneous switches through `__any_strict_eq` was
**correct except for host-boxed JS booleans**. `__any_from_extern`
(`any-helpers.ts:170-265`) only recovers **bool tag 4** for **WasmGC-native**
`nativeBoxBoolean` refs (the `ref.test $nativeBoxBoolean` arm at
any-helpers.ts:236-251). A boolean that arrives as a **host-boxed** value
(JS `true`/`false` crossing the externref boundary) is **not** a
`$nativeBoxBoolean` struct, so it falls through to the **fallbackStringAny**
(tag 5, any-helpers.ts:192-199, 252). Then `__any_strict_eq` sees tag 5 (string)
vs tag 2 (number) and... that part is actually fine (different tags → 0). The
**real** sibling defect the issue names — `(x:any=true) === 1` evaluating
**true** — comes from the **numeric path**, not the switch: when the boolean is
unboxed to f64 (`__any_to_f64` / the externref-numeric fallback) `true`→1.0 and
`f64.eq(1.0, 1.0)` matches. So the fix has two parts:

1. **Recover the boolean tag honestly in `__any_from_extern`** so a host-boxed
   boolean becomes **tag 4**, not tag 5. Add a probe arm **before** the
   `fallbackStringAny`: under JS-host mode use `__typeof_boolean` +
   `__unbox_boolean` on the externref (manifest 98/104; union-native in
   standalone) — if `__typeof_boolean(externval)` is 1, build a tag-4 AnyValue
   with `i32val = __unbox_boolean(externval)`. Mirror the existing
   `__typeof_number`/`__unbox_number` recovery you'd add for numbers (note the
   #1888 comment forbids doing this re-tag at the *generic boxing* site, but
   `__any_from_extern` is a **standalone-only helper** — `ensureAnyFromExternHelper`
   bails unless `ctx.standalone || ctx.wasi`, any-helpers.ts:171 — and is NOT on
   the comparator's hot path, so honest recovery here is safe).
2. **Once tag 4 is honest, `__any_strict_eq(tag4, tag2)` correctly returns 0**
   (`true === 1` is false) because the numeric-class arm (any-helpers.ts:1156-
   1188) only unifies tags **2 and 3**, not 4 — a boolean is its own type under
   StrictEquality. This kills the `(x:any=true) === 1 → true` sibling defect at
   the **strict-equality** call site (switch and `===`) without touching the
   numeric-context f64 unbox (which is correct for `+`/relational ToNumber).

**Why this is safe vs −788:** the change is confined to `__any_from_extern`
(standalone/WASI only) and `__any_strict_eq` selection at the switch site. The
test262 comparator (`isSameValue`) uses the **externref-equality** block
(binary-ops.ts:1833-2028), not `__any_from_extern` and not switch — so the
comparator ABI is untouched. This is why #2063 lands **first**: it proves the
per-site approach with zero comparator exposure.

### Edge cases (#2063)

- `switch(true){case 1:}` → no match (tag 4 vs tag 2). `default` runs.
- `switch("1"){case 1:}` → no match (tag 5 vs tag 2).
- `switch("1"){case 1: case "1":}` → matches `case "1"`, no crash (string
  content compare; numeric case `1` simply doesn't match, no string-equals on a
  number).
- `switch(1){case "1":}` → no match, **no crash** (the f64-into-string-equals
  trap is gone — strict-eq sees tag 2 vs tag 5 → 0).
- `switch` on **booleans/null/undefined**: `switch(null){case undefined:}` → no
  match (tags 0 vs 1, `__any_strict_eq` different-tag → 0); homogeneous boolean
  switch keeps the i32 fast path.
- Homogeneous numeric / string switch: **unchanged** — fast path, no `AnyValue`
  boxing, no perf hit.
- NaN discriminant: `switch(NaN){case NaN:}` → no match (`f64.eq(NaN,NaN)=0`
  inside the tag-3 arm) — matches JS (`NaN !== NaN`).

### Test files to verify (#2063)

- This issue's three repros (`t3`→0, `s`→0, `t2`→50) + `switch(1){case "1":}`
  no-match-no-crash.
- `switch(true){case 1:}` no match; `(x:any=true) === 1` → false (the sibling
  defect).
- Standalone test262 shard: confirm **no** comparator-bucket movement (switch and
  `__any_from_extern` are off the `isSameValue` path; this is the cleanest of the
  three to land regression-free).

---

## Resolution (2026-06-12)

Implemented entirely in `src/codegen/statements/control-flow.ts`
(`compileSwitchStatement`) — **the comparator path (`binary-ops.ts`) and
`__any_from_extern` were NOT touched**, so the −788 trap is structurally
avoided (the test262 `isSameValue` comparator is off this path).

Chose the spec's **per-site externref tag-dispatch** alternative over the
`__any_strict_eq`-boxing route, which also sidesteps the host-boxed-boolean
`__any_from_extern` tag-recovery defect the spec flagged (that helper is never
invoked by switch now).

### What landed

1. `homogeneousSwitchClass(ctx, stmt)` — returns `"number"|"string"|"boolean"`
   only when the discriminant **and every case** are provably that one primitive
   class (flag-based `isNumberType`/`isStringType`/`isBooleanType`, which are all
   false for `any`/`unknown`/unions/objects). Null ⇒ the switch needs per-case
   strict equality.
2. Homogeneous (`homogeneousClass !== null`): the legacy fast path runs
   **verbatim** — no boxing, no behavior or perf change.
3. Non-homogeneous (`strictPerCase`): the discriminant is kept boxed as
   `externref` (the `else if … unbox-to-f64` is now gated on `!strictPerCase`),
   `switchIsString` is forced false, and each case is compiled to `externref`
   and compared via the new `emitSwitchStrictEq(ctx, fctx, discTmp, caseTmp)`.
4. `emitSwitchStrictEq` mirrors the `===` operator's externref-equality lowering:
   - JS-host mode → `__host_eq` (JS `===`, strict + cross-type-false), with the
     #1383-gated both-numbers `__unbox_number` fallback to recover equal numbers
     boxed in distinct externrefs.
   - standalone/WASI (`noJsHost`) → the #1776 Wasm-native tag dispatch
     (`__typeof_number`→f64.eq, `__typeof_boolean`→i32.eq, `__typeof_bigint`→
     i64.eq, native-string value compare via `__str_equals`, else `ref.eq`
     identity). No coercion across tags.

### Outcome (all verified)

- `t3` (`switch(true){case 1}`) → 0, `s` (`switch("1"){case 1}`) → 0,
  `t2` (mixed `case 1`/`case "1"`) → 50, `switch(1){case "1"}` → 0 with **no
  crash** — both JS-host and standalone modes.
- `switch(true){case true}` → match; `switch(true){case false}` → no match.
- Homogeneous numeric/string/boolean switches unchanged (fast path).
- #198 (the switch-coercion suite that introduced the unification), #1776,
  #1914, #1888 all stay green; `binary-ops.ts` untouched.

### Tests

`tests/issue-2063-switch-strict-equality.test.ts` — 13 cases (JS-host via
`assertEquivalent`, plus a standalone block compiling `--target standalone` and
asserting `WebAssembly.validate` + correct results).
